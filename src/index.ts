// Types
interface Env {
	HN_KV: KVNamespace;
	NTFY_TOPIC: string;
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
async function getKeywords(kv: KVNamespace): Promise<string[]> {
	const data = await kv.get(KEYWORDS_KEY);
	if (!data) return [];
	return JSON.parse(data);
}

async function addKeyword(kv: KVNamespace, keyword: string): Promise<string[]> {
	const keywords = await getKeywords(kv);
	const normalized = keyword.trim().toLowerCase();

	if (!normalized) {
		throw new Error("Keyword cannot be empty");
	}

	if (keywords.includes(normalized)) {
		return keywords;
	}

	keywords.push(normalized);
	await kv.put(KEYWORDS_KEY, JSON.stringify(keywords));
	return keywords;
}

async function removeKeyword(kv: KVNamespace, keyword: string): Promise<string[]> {
	const keywords = await getKeywords(kv);
	const normalized = keyword.trim().toLowerCase();
	const filtered = keywords.filter((k) => k !== normalized);
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

// Format hit for notification
function formatHit(hit: HNHit): { title: string; message: string; url: string } {
	const title = hit.title || hit.story_title || "HN Comment";
	const url = hit.url || hit.story_url || `https://news.ycombinator.com/item?id=${hit.objectID}`;

	let message = `by ${hit.author}`;
	if (hit.comment_text) {
		// Strip HTML and truncate
		const text = hit.comment_text.replace(/<[^>]*>/g, " ").substring(0, 200);
		message = `${text}...`;
	}

	return { title, message, url };
}

// Scheduled handler - runs every 15 minutes
async function handleScheduled(env: Env): Promise<void> {
	const keywords = await getKeywords(env.HN_KV);

	if (keywords.length === 0) {
		console.log("No keywords configured, skipping");
		return;
	}

	if (!env.NTFY_TOPIC) {
		console.log("NTFY_TOPIC not configured, skipping");
		return;
	}

	const lastCheck = await getLastCheckTimestamp(env.HN_KV);
	const now = Math.floor(Date.now() / 1000);

	console.log(`Checking ${keywords.length} keywords since ${new Date(lastCheck * 1000).toISOString()}`);

	const seenIds = new Set<string>();

	for (const keyword of keywords) {
		try {
			const hits = await searchHN(keyword, lastCheck);

			for (const hit of hits) {
				// Dedupe across keywords
				if (seenIds.has(hit.objectID)) continue;
				seenIds.add(hit.objectID);

				const { title, message, url } = formatHit(hit);
				await sendNotification(
					env.NTFY_TOPIC,
					`[${keyword}] ${title}`,
					message,
					url
				);

				console.log(`Notified: ${title}`);
			}
		} catch (error) {
			console.error(`Error searching for "${keyword}":`, error);
		}
	}

	await setLastCheckTimestamp(env.HN_KV, now);
	console.log(`Done. Found ${seenIds.size} new items.`);
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
		// GET /keywords - list all keywords
		if (path === "/keywords" && request.method === "GET") {
			const keywords = await getKeywords(env.HN_KV);
			return Response.json({ keywords }, { headers: corsHeaders });
		}

		// POST /keywords - add a keyword
		if (path === "/keywords" && request.method === "POST") {
			const body = await request.json<{ keyword: string }>();
			const keywords = await addKeyword(env.HN_KV, body.keyword);
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
