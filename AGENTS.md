# Agent Guidelines for hn-notify

## Build/Test Commands
- `npm test` - Run all tests with Vitest
- `npm run dev` - Start local development with Wrangler
- `npm run deploy` - Deploy to Cloudflare Workers
- `npm run cf-typegen` - Generate Cloudflare Worker types

## Code Style
- **Formatting**: Tabs for indentation, single quotes, semicolons, 140 char line width (see .prettierrc)
- **TypeScript**: Strict mode enabled, target ES2024, use explicit types for interfaces
- **Imports**: ES modules (`import`/`export`), module resolution: Bundler
- **Naming**: camelCase for functions/variables, PascalCase for types/interfaces, UPPER_CASE for constants
- **Error Handling**: Use try-catch blocks, log errors with `console.error()`, return proper HTTP status codes
- **Functions**: Use `async/await` for promises, type return values explicitly (e.g., `Promise<void>`)
- **Comments**: Use `//` for single-line comments, add JSDoc-style comments for complex functions

## Architecture Notes
- Cloudflare Worker with scheduled cron triggers (every 15 min)
- Uses KV namespace (HN_KV) for persistent storage
- Dual handlers: HTTP fetch for API, scheduled for automated checks
- External dependencies: HN Algolia API, ntfy.sh for notifications
