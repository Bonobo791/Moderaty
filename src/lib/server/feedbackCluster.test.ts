import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { OPENAI_API_KEY: 'test-openai-key' } as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { clusterClaims, clusterClassifiedClaims } from './feedbackCluster';

function stubMerge(content: string | object) {
	const body = typeof content === 'string' ? content : JSON.stringify(content);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 }))
	);
}

const q = (claim: string) => ({ category: 'question' as const, claim });

beforeEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test('merges differently-worded same-theme claims onto one canonical claim', async () => {
	stubMerge({ themes: [{ claim: 'when is the next video', members: [0, 2] }, { claim: 'the audio is loud', members: [1] }] });
	const canonical = await clusterClaims(
		[q('next episode when?'), { category: 'criticism', claim: 'the audio is loud' }, q('part 2 release date?')],
		undefined,
		'test-openai-key'
	);
	expect(canonical).toEqual(['when is the next video', 'the audio is loud', 'when is the next video']);
});

test('fewer than two claims skip the provider call entirely', async () => {
	vi.stubGlobal('fetch', vi.fn());
	expect(await clusterClaims([q('solo claim')], undefined, 'test-openai-key')).toEqual(['solo claim']);
	expect(await clusterClaims([], undefined, 'test-openai-key')).toEqual([]);
	expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

test('claims travel inside a delimiter tag as untrusted content', async () => {
	stubMerge({ themes: [{ claim: 'a', members: [0] }, { claim: 'b', members: [1] }] });
	await clusterClaims([q('one'), q('two')], undefined, 'test-openai-key');
	const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
	const user: string = body.messages.find((m: { role: string }) => m.role === 'user')?.content;
	const system: string = body.messages.find((m: { role: string }) => m.role === 'system')?.content;
	expect(user).toContain('"claim":"one"');
	expect(system).toContain('untrusted');
	expect(user).toMatch(/^<data-[0-9a-f]+>\n/);
});

test('a missing API key throws rather than silently using the deployment key', async () => {
	vi.stubGlobal('fetch', vi.fn());
	await expect(clusterClaims([q('a'), q('b')])).rejects.toThrow('OPENAI_API_KEY');
	expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

test.each([
	['an index out of range', { themes: [{ claim: 'a', members: [0, 7] }] }],
	['an index assigned twice', { themes: [{ claim: 'a', members: [0, 1] }, { claim: 'b', members: [1] }] }],
	['an index omitted', { themes: [{ claim: 'a', members: [0] }] }],
	['a cross-category merge', { themes: [{ claim: 'a', members: [0, 1] }] }],
	['an empty themes array', { themes: [] }],
	['a missing themes field', {}],
	['an oversized canonical claim', { themes: [{ claim: 'x'.repeat(201), members: [0, 1] }] }],
	['a blank canonical claim', { themes: [{ claim: '   ', members: [0, 1] }] }],
	['empty members', { themes: [{ claim: 'a', members: [] }, { claim: 'b', members: [0, 1] }] }],
	['non-integer members', { themes: [{ claim: 'a', members: [0, 'one'] }] }],
	['non-JSON content', 'not json']
])('a malformed merge response throws — %s', async (_name, payload) => {
	stubMerge(payload);
	await expect(
		clusterClaims([q('one'), { category: 'criticism', claim: 'two' }], undefined, 'test-openai-key')
	).rejects.toThrow('feedback clustering response has missing or invalid themes');
});

test('a non-OK provider response throws through jsonResponse', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 403 })));
	await expect(clusterClaims([q('a'), q('b')], undefined, 'test-openai-key')).rejects.toThrow('feedback clustering failed');
});

test('clusterClassifiedClaims rewrites feedback rows and leaves none rows untouched', async () => {
	stubMerge({ themes: [{ claim: 'shared theme', members: [0, 1] }] });
	const merged = await clusterClassifiedClaims(
		[
			{ commentId: 'a', category: 'question' as const, claim: 'wording one' },
			{ commentId: 'b', category: 'question' as const, claim: 'wording two' },
			{ commentId: 'n', category: 'none' as const, claim: '' }
		],
		undefined,
		'test-openai-key'
	);
	expect(merged.map((row) => row.claim)).toEqual(['shared theme', 'shared theme', '']);
	// The merge input must only contain the two feedback rows — 'none' never
	// reaches the model or consumes a theme member slot.
	const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
	const user: string = body.messages.find((m: { role: string }) => m.role === 'user')?.content;
	expect(user).toContain('"i":1');
	expect(user).not.toContain('"i":2');
});
