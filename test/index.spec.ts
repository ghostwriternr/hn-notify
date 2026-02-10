import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('API routes', () => {
	it('returns 404 for unknown paths (unit style)', async () => {
		const request = new IncomingRequest('http://example.com/nope');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env as Parameters<typeof worker.fetch>[1], ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'Not found' });
	});

	it('returns status (integration style)', async () => {
		const response = await SELF.fetch('https://example.com/status');
		expect(response.status).toBe(200);
		const body = await response.json<{ keywords_count: number; ntfy_configured: boolean }>();
		expect(body).toHaveProperty('keywords_count');
		expect(body).toHaveProperty('last_check');
		expect(body).toHaveProperty('ntfy_configured');
		expect(body).toHaveProperty('relevance_threshold');
	});

	it('manages keywords via POST and GET', async () => {
		await SELF.fetch('https://example.com/keywords', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ keyword: 'test-keyword', context: 'test context' }),
		});

		const response = await SELF.fetch('https://example.com/keywords');
		const body = await response.json<{ keywords: Array<{ keyword: string; context?: string }> }>();
		const added = body.keywords.find((k) => k.keyword === 'test-keyword');
		expect(added).toBeDefined();
		expect(added?.context).toBe('test context');

		await SELF.fetch('https://example.com/keywords/test-keyword', { method: 'DELETE' });

		const after = await SELF.fetch('https://example.com/keywords');
		const afterBody = await after.json<{ keywords: Array<{ keyword: string }> }>();
		expect(afterBody.keywords.find((k) => k.keyword === 'test-keyword')).toBeUndefined();
	});

	it('handles CORS preflight', async () => {
		const response = await SELF.fetch('https://example.com/keywords', { method: 'OPTIONS' });
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});
});
