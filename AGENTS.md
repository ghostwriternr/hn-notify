# Agent Guidelines for hn-notify

## Build/Test Commands
- `npm test` — Run all tests (API + eval) with Vitest
- `npm run dev` — Start local dev server with Wrangler
- `npm run deploy` — Deploy to Cloudflare Workers
- `npm run cf-typegen` — Regenerate `worker-configuration.d.ts` types

## Code Style
- **Formatting**: Tabs, single quotes, semicolons, 140 char width (`.prettierrc`)
- **TypeScript**: Strict mode, ES2024 target, explicit types for interfaces
- **Imports**: ES modules, module resolution: Bundler
- **Naming**: camelCase functions/variables, PascalCase types, UPPER_CASE constants
- **Error Handling**: try-catch, `console.error()`, proper HTTP status codes
- **Functions**: async/await, explicitly typed return values
- **Commits**: Imperative mood, 50 char subject, body wraps at 72 chars

## Architecture

### Overview
Cloudflare Worker that monitors Hacker News for configurable keywords and sends push notifications via ntfy.sh. Uses Workers AI to filter out false positives from Algolia's fuzzy search.

### Request Flow (Scheduled — every 15 min)
```
Cron trigger
  → Load keywords from KV
  → For each keyword: search HN Algolia API (search_by_date, since last check)
  → For each hit:
      1. Dedup by objectID (skip if seen in this cycle)
      2. Check KV dedup (skip if notified: prefix exists, 24h TTL)
      3. If keyword has a context string → score with AI reranker
         - Score >= RELEVANCE_THRESHOLD → include
         - Score < threshold → filter out (log it)
         - AI error → include anyway (fail-open)
      4. If no context string → include (no filtering)
  → Batch all matches into one notification
  → Send via ntfy.sh
  → Write notified:{objectID} keys to KV (24h TTL)
  → Update last_check_timestamp
```

### Request Flow (HTTP API)
```
GET  /keywords        — List all keywords with context strings
POST /keywords        — Add/update keyword: {"keyword": "...", "context": "..."}
DELETE /keywords/:kw  — Remove keyword
GET  /status          — Config summary (keyword count, last check, threshold)
POST /trigger         — Manually trigger a check cycle
```

### Key Files
| File | Purpose |
|------|---------|
| `src/index.ts` | Entire worker: API routes, scheduled handler, AI scoring, notifications |
| `test/index.spec.ts` | API route tests (unit + integration via SELF) |
| `test/reranker-eval.spec.ts` | AI reranker evaluation suite (48 items, 12 keywords) |
| `test/fixtures/eval-dataset.json` | Eval dataset with embedded context strings |
| `wrangler.jsonc` | Worker config: KV binding, cron, AI binding |

### Bindings
| Binding | Type | Purpose |
|---------|------|---------|
| `HN_KV` | KV Namespace | Keywords, timestamps, dedup keys |
| `NTFY_TOPIC` | Secret | ntfy.sh topic name (set via `wrangler secret put`) |
| `AI` | Workers AI | Reranker model access |

### KV Schema
| Key Pattern | Value | TTL | Purpose |
|-------------|-------|-----|---------|
| `keywords` | JSON array of `{keyword, context?}` | None | Keyword configuration |
| `last_check_timestamp` | Unix timestamp string | None | Last successful check time |
| `notified:{objectID}` | `"1"` | 24 hours | Dedup: prevent re-notifying same HN item |

## AI Reranker

### How It Works
Each keyword can have an optional `context` string that describes what the keyword *actually* means. When a hit comes in, the reranker scores how relevant the hit's content is to the context string.

- **Model**: `@cf/baai/bge-reranker-base` (Cloudflare Workers AI)
- **Threshold**: `RELEVANCE_THRESHOLD` exported from `src/index.ts` (currently `0.01`)
- **Input**: query = context string, text = first 500 chars of (title + story_title + comment_text with HTML stripped)
- **Output**: score between 0 and 1, higher = more relevant

### Why Context Strings Exist
Algolia search is fuzzy. The keyword `e2b` matches `emb`eddings, `E2E`, `Eb`ola, URL-encoded `%E2%80%`, `EIB`, `B2B`. The keyword `forevervm` matches any comment containing "forever". Without context strings, these fuzzy matches generate massive notification spam.

**Every keyword MUST have a context string.** A keyword without one bypasses AI filtering entirely — all Algolia hits become notifications.

### Threshold Tuning
- Current threshold: `0.01`
- True positives typically score `0.01` – `0.99`
- False positives typically score `< 0.001`
- **Do NOT raise above 0.01** without running evals — some legitimate TPs score as low as `0.01`–`0.02`
- **Do NOT lower below 0.005** — edge-case FPs (like "embeddings" in AI-heavy comments) can score `0.005`–`0.008`
- After any threshold change, run `npm test` to verify all 48 eval items still pass

## Eval Suite

### Dataset (`test/fixtures/eval-dataset.json`)
48 items from real HN data across all 12 production keywords:
- **27 true positives** — items that SHOULD trigger notifications
- **21 false positives** — items from Algolia fuzzy matching that should be filtered out

Each entry has:
```json
{
  "objectID": "12345678",
  "title": "...",
  "story_title": "...",
  "comment_text": "...",
  "context_keyword": "e2b",
  "context_string": "E2B.dev cloud sandbox for AI code execution...",
  "expected_relevant": true,
  "match_reason": "emb(eddings)"  // FPs only: why Algolia matched
}
```

### Adding New Eval Items
1. Find the HN item ID (from Algolia search or HN directly)
2. Fetch item data: `curl https://hn.algolia.com/api/v1/items/{id}`
3. For comments, also fetch the parent story for `story_title`: use `story_id` from the response
4. Add entry to `eval-dataset.json` with the keyword's current `context_string` from production
5. Set `expected_relevant: true` for items that should notify, `false` for noise
6. For FPs, add `match_reason` explaining why Algolia matched it
7. Run `npm test` to verify

### Important Eval Properties
- `context_string` is embedded per-item in the dataset (single source of truth)
- `RELEVANCE_THRESHOLD` is imported from `src/index.ts` (not hardcoded in tests)
- Tests call the real Workers AI model — they are NOT mocked
- Eval tests incur Cloudflare AI usage charges (see warning on `npm test`)

## Managing Keywords

### Production URL
```
https://hn-notify.ghostwriternr.workers.dev
```

### Adding a Keyword
```bash
curl -X POST https://hn-notify.ghostwriternr.workers.dev/keywords \
  -H "Content-Type: application/json" \
  -d '{"keyword": "new-keyword", "context": "Descriptive context for AI filtering"}'
```

### Viewing Current Keywords
```bash
curl https://hn-notify.ghostwriternr.workers.dev/keywords
```

### Updating a Context String
POST the same keyword with a new context — it overwrites the existing context:
```bash
curl -X POST https://hn-notify.ghostwriternr.workers.dev/keywords \
  -H "Content-Type: application/json" \
  -d '{"keyword": "existing-keyword", "context": "improved context string"}'
```

### Writing Good Context Strings
- Be specific about the product/company: "E2B.dev cloud sandbox" not just "sandbox"
- Include related terms the reranker should associate: "Jamsocket, cloud code execution platform"
- Cover the use cases you care about: "deploying AI agents, sandboxed code execution"
- Test with real data before deploying — use the eval suite to verify TP/FP separation

### When Updating a Context String
If you change a context string in production, also update `context_string` in matching eval dataset entries, then run `npm test` to confirm no regressions. The eval caught a real gap when `cloudflare containers` context was too narrow for AI agent deployment content.

## External Services

### HN Algolia API
- Base URL: `https://hn.algolia.com/api/v1`
- Search endpoint: `/search_by_date?query={keyword}&numericFilters=created_at_i>{timestamp}&hitsPerPage=50`
- Items endpoint: `/items/{id}` (for fetching individual items)
- Algolia search is fuzzy — short keywords like `e2b` will match substrings in unrelated words
- No API key required, no rate limit enforced (but be reasonable)

### ntfy.sh
- Push notifications via `POST https://ntfy.sh/{topic}`
- Topic is stored as a Cloudflare secret (`NTFY_TOPIC`)
- Supports click-through URLs and action buttons
- Free tier, no auth required for pushing

### Cloudflare Workers AI
- Model: `@cf/baai/bge-reranker-base`
- Bound via `ai` config in `wrangler.jsonc`
- Used for scoring relevance of HN hits against keyword context strings
- Charges per inference — eval tests hit real API

## Deployment
```bash
npm run deploy  # Deploys to Cloudflare Workers via wrangler
```
- Secrets (like `NTFY_TOPIC`) are set separately: `npx wrangler secret put NTFY_TOPIC`
- Keyword config lives in KV (managed via HTTP API), NOT in code
- The only tunable in code is `RELEVANCE_THRESHOLD` in `src/index.ts`

## Common Operations

### Diagnosing Notification Spam
1. Check recent notifications: `curl -s "https://ntfy.sh/TOPIC/json?poll=1&since=12h"`
2. Look for patterns — is one keyword dominating? Are items repeated?
3. Check if the noisy keyword has a context string: `GET /keywords`
4. If no context string → add one (see "Writing Good Context Strings")
5. If context string exists but spam continues → context may be too broad, or threshold too low

### Testing a Context String Change
1. Find real TP and FP examples from Algolia search results
2. Add them to `test/fixtures/eval-dataset.json` with the new context string
3. Run `npm test` — TPs should score >= 0.01, FPs should score < 0.01
4. If passing, update production via `POST /keywords`

### Manual Trigger
```bash
curl -X POST https://hn-notify.ghostwriternr.workers.dev/trigger
```
This runs one full check cycle immediately (useful for testing after changes).

## Gotchas
- `worker-configuration.d.ts` has pre-existing lint errors (empty interfaces) — ignore them
- The vitest compatibility date warning ("2025-09-27" vs "2025-09-06") is harmless
- Algolia `/items/{id}` and HN Firebase API may intermittently return 401 — retry or use Algolia search API as fallback
- Comment items from Algolia don't have `story_title` — fetch parent story via `story_id` field
- Keywords are stored in KV as a JSON array, NOT per-key — the entire array is read/written atomically
