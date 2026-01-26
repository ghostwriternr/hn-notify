// Types
interface Env {
	HN_KV: KVNamespace;
	NTFY_TOPIC: string;
	AI: Ai;
}

interface KeywordConfig {
	keyword: string;
	context?: string;
}

interface HNHit {
	objectID: string;
	title?: string;
	story_title?: string;
	url?: string;
	story_url?: string;
	author: string;
	created_at_i: number;
	comment_text?: string;
}

interface HNSearchResponse {
	hits: HNHit[];
}

// KV Keys
const KEYWORDS_KEY = "keywords";
const LAST_CHECK_KEY = "last_check_timestamp";

// AI Configuration
const RELEVANCE_THRESHOLD = 0.5; // Minimum score to send notification (0-1)

// HN Algolia API
const HN_API_BASE = "https://hn.algolia.com/api/v1";

async function searchHN(query: string, sinceTimestamp: number): Promise<HNHit[]> {
	const url = new URL(`${HN_API_BASE}/search_by_date`);
	url.searchParams.set("query", query);
	url.searchParams.set("numericFilters", `created_at_i>${sinceTimestamp}`);
	url.searchParams.set("hitsPerPage", "50");

	const response = await fetch(url.toString());
	if (!response.ok) {
		throw new Error(`HN API error: ${response.status}`);
	}

	const data: HNSearchResponse = await response.json();
	return data.hits;
}

// Notifications via ntfy.sh
async function sendNotification(topic: string, title: string, message: string, url?: string): Promise<void> {
	const headers: Record<string, string> = {
		Title: title,
	};

	if (url) {
		headers.Click = url;
		headers.Actions = `view, Open, ${url}`;
	}

	await fetch(`https://ntfy.sh/${topic}`, {
		method: "POST",
		headers,
		body: message,
	});
}

// Keywords management
async function getKeywords(kv: KVNamespace): Promise<KeywordConfig[]> {
	const data = await kv.get(KEYWORDS_KEY);
	if (!data) return [];

	const parsed = JSON.parse(data);

	if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
		return parsed.map((keyword: string) => ({ keyword }));
	}

	return parsed;
}

async function addKeyword(kv: KVNamespace, keyword: string, context?: string): Promise<KeywordConfig[]> {
	const keywords = await getKeywords(kv);
	const normalized = keyword.trim().toLowerCase();

	if (!normalized) {
		throw new Error("Keyword cannot be empty");
	}

	const trimmedContext = context?.trim() || undefined;

	const existing = keywords.find((k) => k.keyword === normalized);
	if (existing) {
		existing.context = trimmedContext;
	} else {
		keywords.push({ keyword: normalized, context: trimmedContext });
	}

	await kv.put(KEYWORDS_KEY, JSON.stringify(keywords));
	return keywords;
}

async function removeKeyword(kv: KVNamespace, keyword: string): Promise<KeywordConfig[]> {
	const keywords = await getKeywords(kv);
	const normalized = keyword.trim().toLowerCase();
	const filtered = keywords.filter((k) => k.keyword !== normalized);
	await kv.put(KEYWORDS_KEY, JSON.stringify(filtered));
	return filtered;
}

// Last check timestamp
async function getLastCheckTimestamp(kv: KVNamespace): Promise<number> {
	const data = await kv.get(LAST_CHECK_KEY);
	if (!data) {
		// Default to 15 minutes ago on first run
		return Math.floor(Date.now() / 1000) - 15 * 60;
	}
	return parseInt(data, 10);
}

async function setLastCheckTimestamp(kv: KVNamespace, timestamp: number): Promise<void> {
	await kv.put(LAST_CHECK_KEY, timestamp.toString());
}

async function checkRelevance(ai: Ai, context: string, hit: HNHit): Promise<number> {
	const content = [hit.title, hit.story_title, hit.comment_text?.replace(/<[^>]*>/g, " ")]
		.filter(Boolean)
		.join(" ")
		.substring(0, 500);

	if (!content.trim()) {
		return 0;
	}

	const result = await ai.run("@cf/baai/bge-reranker-base", {
		query: context,
		contexts: [{ text: content }],
	});

	return result.response?.[0]?.score ?? 0;
}

interface MatchedHit {
	keyword: string;
	hit: HNHit;
}

function formatBatchNotification(matches: MatchedHit[]): { title: string; body: string } {
	if (matches.length === 0) {
		return { title: "HN Alert", body: "No matches" };
	}

	if (matches.length === 1) {
		const { keyword, hit } = matches[0];
		const itemTitle = hit.title || hit.story_title || "Comment";
		return {
			title: `[${keyword}] ${itemTitle}`,
			body: formatHitBody(hit),
		};
	}

	const keywordCounts = new Map<string, number>();
	for (const { keyword } of matches) {
		keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
	}
	const summaryParts = Array.from(keywordCounts.entries()).map(([kw, count]) => `${kw}(${count})`);

	const title = `HN Alert: ${matches.length} matches`;
	const lines: string[] = [summaryParts.join(", "), ""];

	for (const { keyword, hit } of matches.slice(0, 10)) {
		const itemTitle = hit.title || hit.story_title || "Comment";
		lines.push(`• [${keyword}] ${itemTitle.substring(0, 60)}`);
	}

	if (matches.length > 10) {
		lines.push(`... and ${matches.length - 10} more`);
	}

	return { title, body: lines.join("\n") };
}

function formatHitBody(hit: HNHit): string {
	if (hit.comment_text) {
		return hit.comment_text.replace(/<[^>]*>/g, " ").substring(0, 200) + "...";
	}
	return `by ${hit.author}`;
}

async function handleScheduled(env: Env): Promise<void> {
	const keywordConfigs = await getKeywords(env.HN_KV);

	if (keywordConfigs.length === 0) {
		console.log("No keywords configured, skipping");
		return;
	}

	if (!env.NTFY_TOPIC) {
		console.log("NTFY_TOPIC not configured, skipping");
		return;
	}

	const lastCheck = await getLastCheckTimestamp(env.HN_KV);
	const now = Math.floor(Date.now() / 1000);

	console.log(`Checking ${keywordConfigs.length} keywords since ${new Date(lastCheck * 1000).toISOString()}`);

	const seenIds = new Set<string>();
	const matches: MatchedHit[] = [];
	let filteredCount = 0;

	for (const { keyword, context } of keywordConfigs) {
		try {
			const hits = await searchHN(keyword, lastCheck);

			for (const hit of hits) {
				if (seenIds.has(hit.objectID)) continue;
				seenIds.add(hit.objectID);

				if (context) {
					try {
						const score = await checkRelevance(env.AI, context, hit);
						if (score < RELEVANCE_THRESHOLD) {
							filteredCount++;
							console.log(`Filtered [${keyword}] (score=${score.toFixed(2)}): ${hit.title || hit.story_title}`);
							continue;
						}
						console.log(`Passed [${keyword}] (score=${score.toFixed(2)}): ${hit.title || hit.story_title}`);
					} catch (aiError) {
						console.error("AI filtering error, including in batch anyway:", aiError);
					}
				}

				matches.push({ keyword, hit });
				console.log(`Matched [${keyword}]: ${hit.title || hit.story_title}`);
			}
		} catch (error) {
			console.error(`Error searching for "${keyword}":`, error);
		}
	}

	if (matches.length > 0) {
		const { title, body } = formatBatchNotification(matches);
		const firstHitUrl = `https://news.ycombinator.com/item?id=${matches[0].hit.objectID}`;
		await sendNotification(env.NTFY_TOPIC, title, body, firstHitUrl);
		console.log(`Sent batch notification with ${matches.length} matches`);
	}

	await setLastCheckTimestamp(env.HN_KV, now);
	console.log(`Done. Found ${seenIds.size} items, matched ${matches.length}, filtered ${filteredCount}.`);
}

// HTTP handler for keyword management API
async function handleRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	// CORS headers for convenience
	const corsHeaders = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};

	if (request.method === "OPTIONS") {
		return new Response(null, { headers: corsHeaders });
	}

	try {
		// GET /keywords - list all keywords with their contexts
		if (path === "/keywords" && request.method === "GET") {
			const keywords = await getKeywords(env.HN_KV);
			return Response.json({ keywords }, { headers: corsHeaders });
		}

		// POST /keywords - add a keyword (context is optional for AI filtering)
		if (path === "/keywords" && request.method === "POST") {
			const body = await request.json<{ keyword: string; context?: string }>();
			const keywords = await addKeyword(env.HN_KV, body.keyword, body.context);
			return Response.json({ keywords }, { headers: corsHeaders });
		}

		// DELETE /keywords/:keyword - remove a keyword
		if (path.startsWith("/keywords/") && request.method === "DELETE") {
			const keyword = decodeURIComponent(path.replace("/keywords/", ""));
			const keywords = await removeKeyword(env.HN_KV, keyword);
			return Response.json({ keywords }, { headers: corsHeaders });
		}

		// GET /status - check configuration
		if (path === "/status" && request.method === "GET") {
			const keywords = await getKeywords(env.HN_KV);
			const lastCheck = await getLastCheckTimestamp(env.HN_KV);
			return Response.json(
				{
					keywords_count: keywords.length,
					last_check: new Date(lastCheck * 1000).toISOString(),
					ntfy_configured: !!env.NTFY_TOPIC,
					relevance_threshold: RELEVANCE_THRESHOLD,
				},
				{ headers: corsHeaders }
			);
		}

		// POST /trigger - manually trigger a check (for testing)
		if (path === "/trigger" && request.method === "POST") {
			await handleScheduled(env);
			return Response.json({ ok: true, message: "Check triggered" }, { headers: corsHeaders });
		}

		return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return Response.json({ error: message }, { status: 500, headers: corsHeaders });
	}
}

// Worker exports
export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		return handleRequest(request, env);
	},

	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(handleScheduled(env));
	},
};
