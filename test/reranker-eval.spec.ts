import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { RELEVANCE_THRESHOLD } from '../src/index';
import dataset from './fixtures/eval-dataset.json';

interface EvalItem {
	objectID: string;
	title: string;
	story_title: string;
	comment_text: string;
	context_keyword: string;
	context_string: string;
	expected_relevant: boolean;
	match_reason?: string;
}

async function scoreItem(ai: Ai, context: string, item: EvalItem): Promise<number> {
	const content = [item.title, item.story_title, item.comment_text?.replace(/<[^>]*>/g, ' ')]
		.filter(Boolean)
		.join(' ')
		.substring(0, 500);

	if (!content.trim()) return 0;

	const result = await ai.run('@cf/baai/bge-reranker-base', {
		query: context,
		contexts: [{ text: content }],
	});

	return result.response?.[0]?.score ?? 0;
}

describe('reranker eval', () => {
	const items = dataset as EvalItem[];
	const truePositives = items.filter((d) => d.expected_relevant);
	const falsePositives = items.filter((d) => !d.expected_relevant);

	describe('true positives score above threshold', () => {
		for (const item of truePositives) {
			const label = item.title || item.story_title || `comment ${item.objectID}`;
			it(`[${item.context_keyword}] ${label}`, async () => {
				expect(item.context_string, `missing context_string for "${item.context_keyword}"`).toBeTruthy();

				const score = await scoreItem(env.AI, item.context_string, item);
				expect(score, `expected TP to score >= ${RELEVANCE_THRESHOLD}, got ${score}`).toBeGreaterThanOrEqual(
					RELEVANCE_THRESHOLD
				);
			});
		}
	});

	describe('false positives score below threshold', () => {
		for (const item of falsePositives) {
			const label = item.title || item.story_title || `comment ${item.objectID}`;
			const reason = item.match_reason ? ` (${item.match_reason})` : '';
			it(`[${item.context_keyword}] ${label}${reason}`, async () => {
				expect(item.context_string, `missing context_string for "${item.context_keyword}"`).toBeTruthy();

				const score = await scoreItem(env.AI, item.context_string, item);
				expect(score, `expected FP to score < ${RELEVANCE_THRESHOLD}, got ${score}`).toBeLessThan(
					RELEVANCE_THRESHOLD
				);
			});
		}
	});
});
