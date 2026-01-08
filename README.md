# hn-notify

A Cloudflare Worker that monitors Hacker News for keywords and sends push notifications via [ntfy.sh](https://ntfy.sh).

## How it works

- Runs every 15 minutes via cron trigger
- Searches HN (stories, comments) using the Algolia API
- Sends notifications for new matches to your ntfy.sh topic
- Stores keywords and last-check timestamp in Cloudflare KV

## Setup

1. Create a KV namespace and update `wrangler.jsonc` with the ID
2. Set your ntfy.sh topic: `npx wrangler secret put NTFY_TOPIC`
3. Deploy: `npm run deploy`
4. Subscribe to your topic in the ntfy app

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/keywords` | List keywords |
| POST | `/keywords` | Add keyword (`{"keyword": "..."}`) |
| DELETE | `/keywords/:keyword` | Remove keyword |
| GET | `/status` | Check config |
| POST | `/trigger` | Manual check |

## Development

```bash
npm run dev      # Local dev server
npm run deploy   # Deploy to Cloudflare
```
