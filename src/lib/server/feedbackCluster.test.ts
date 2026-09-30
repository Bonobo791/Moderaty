import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { OPENAI_API_KEY: 'test-openai-key' } as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { clusterClaims, clusterClassifiedClaims } from './feedbackCluster';
import { DeadlineExceededError } from './http';
import * as http from './http';
import * as feedbackGroup from './feedbackGroup';

function stubMerge(content: string | object) {
	const body = typeof content === 'string' ? content : JSON.stringify(content);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 }))
	);
}

const q = (claim: string) => ({ category: 'question' as const, claim });

test('overlapping and omitted inputs retain original claims without discarding valid themes', async () => {
	stubMerge({ themes: [
		{ claim: 'visa procedures', members: [0, 1, 1, 2, 99, 'bad'] },
		{ claim: 'visa routes', members: [2, 3] }
	] });
	const result = await clusterClaims(Array.from({ length: 5 }, (_, index) => q(`original ${index}`)), undefined, 'test-openai-key');
	expect(result).toEqual({ degraded: true, assignments: [
		{ claim: 'visa procedures', groupingSource: 'theme' },
		{ claim: 'visa procedures', groupingSource: 'theme' },
		{ claim: 'original 2', groupingSource: 'original' },
		{ claim: 'visa routes', groupingSource: 'theme' },
		{ claim: 'original 4', groupingSource: 'original' }
	] });
});

test('deadline expiry is not converted into original-claim recovery', async () => {
	vi.stubGlobal('fetch', vi.fn());
	await expect(clusterClaims([q('one'), q('two')], Date.now() - 1, 'test-openai-key')).rejects.toBeInstanceOf(DeadlineExceededError);
	expect(fetch).not.toHaveBeenCalled();
});

test('deadline expiry while streaming the provider body propagates instead of recovering', async () => {
	vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
		start(controller) {
			init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
		}
	}))));
	await expect(clusterClaims([q('one'), q('two')], Date.now() + 100, 'test-openai-key')).rejects.toBeInstanceOf(DeadlineExceededError);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(console.warn).not.toHaveBeenCalled();
});

test.each([new ReferenceError('internal response bug'), new TypeError('internal response type bug')])('unexpected response-helper errors propagate: %s', async (cause) => {
	stubMerge({ themes: [{ claim: 'usable', members: [0, 1] }] });
	vi.spyOn(http, 'jsonResponse').mockRejectedValueOnce(cause);
	await expect(clusterClaims([q('one'), q('two')], undefined, 'test-openai-key')).rejects.toBe(cause);
	expect(console.warn).not.toHaveBeenCalled();
});

test('a successful body arriving after the deadline cannot report successful clustering', async () => {
	const deadline = Date.now() + 1_000;
	stubMerge({ themes: [{ claim: 'usable', members: [0, 1] }] });
	vi.spyOn(http, 'jsonResponse').mockImplementationOnce(async () => {
		vi.spyOn(Date, 'now').mockReturnValue(deadline);
		return { choices: [{ message: { content: JSON.stringify({ themes: [{ claim: 'usable', members: [0, 1] }] }) } }] };
	});
	await expect(clusterClaims([q('one'), q('two')], deadline, 'test-openai-key')).rejects.toBeInstanceOf(DeadlineExceededError);
});

beforeEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

test('the production memberships retain 39 assignments and recover six original claims regardless of theme order', async () => {
	const themes = [
		{ claim: 'Visa application and extension procedures', members: [0, 1, 3, 5, 7, 8, 9, 10, 11, 13, 14, 15, 17, 18, 27, 28, 33, 40, 41, 43, 44] },
		{ claim: 'Visa types and routes in Thailand', members: [4, 21, 25, 29, 36, 37, 41] },
		{ claim: 'Financial requirements and banking for visas', members: [2, 6, 12, 22, 32, 34, 35] },
		{ claim: 'Visa eligibility and restrictions', members: [16, 23, 24, 26, 39] },
		{ claim: 'Visa costs and agent services', members: [18] },
		{ claim: 'Legal and health considerations', members: [20, 42] },
		{ claim: 'Living in Thailand and local information', members: [30, 31, 38] },
		{ claim: 'Other questions about Thailand', members: [33, 34, 35] }
	];
	const rows = Array.from({ length: 45 }, (_, index) => q(`original claim ${index}`));
	const fallback = [18, 19, 33, 34, 35, 41];
	let first: Awaited<ReturnType<typeof clusterClaims>> | undefined;
	for (const ordered of [themes, [...themes].reverse()]) {
		stubMerge({ themes: ordered });
		const result = await clusterClaims(rows, undefined, 'test-openai-key');
		expect(result.degraded).toBe(true);
		expect(result.assignments).toHaveLength(45);
		result.assignments.forEach((assignment, index) => {
			expect(assignment).toEqual(fallback.includes(index)
				? { claim: `original claim ${index}`, groupingSource: 'original' }
				: { claim: themes.find((theme) => theme.members.includes(index))?.claim, groupingSource: 'theme' });
		});
		const grouped = feedbackGroup.groupFeedback(result.assignments.map((assignment, index) => ({
			...rows[index], ...assignment, commentId: `comment-${index}`, text: `comment text ${index}`,
			publishedAt: '2026-01-01T00:00:00.000Z', hasAbuse: false
		})));
		expect(grouped.findings.map((finding) => finding.supporterCount)).toEqual([18, 6, 5, 5, 3]);
		expect(grouped.pooled).toBe(8);
		if (first) expect(result).toEqual(first);
		first = result;
	}
	expect(console.warn).toHaveBeenCalledTimes(2);
	expect(console.warn).toHaveBeenLastCalledWith('feedback clustering recovered:', {
		category: 'question', reasons: ['overlapping-inputs', 'unassigned-inputs'], fallbackComments: 6, inputComments: 45
	});
});

test.each([null, [], 1, { claim: 'invalid array', members: '0,1' }, { claim: null, members: [0, 1] }])('unusable theme objects do not discard a usable sibling: %j', async (theme) => {
	stubMerge({ themes: [theme, { claim: 'usable', members: [0, 1] }] });
	expect(await clusterClaims([q('one'), q('two')], undefined, 'test-openai-key')).toEqual({ degraded: true, assignments: [
		{ claim: 'usable', groupingSource: 'theme' }, { claim: 'usable', groupingSource: 'theme' }
	] });
});

test.each([-1, 0.5, null, true, '1'])('invalid references are excluded, not coerced: %j', async (member) => {
	stubMerge({ themes: [{ claim: 'usable', members: [0, member] }] });
	expect(await clusterClaims([q('one'), q('two')], undefined, 'test-openai-key')).toEqual({ degraded: true, assignments: [
		{ claim: 'usable', groupingSource: 'theme' }, { claim: 'two', groupingSource: 'original' }
	] });
});

test.each([null, {}, { choices: null }, { choices: {} }, { choices: [null] }, { choices: [{ message: {} }] }])('invalid provider envelopes recover: %j', async (response) => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
	expect(await clusterClaims([q('one'), q('two')], undefined, 'test-openai-key')).toEqual({ degraded: true, assignments: [
		{ claim: 'one', groupingSource: 'original' }, { claim: 'two', groupingSource: 'original' }
	] });
});

test('unexpected grouping errors propagate instead of being disguised as provider recovery', async () => {
	stubMerge({ themes: [{ claim: 'usable', members: [0, 1] }] });
	vi.spyOn(feedbackGroup, 'normalizeClaimKey').mockImplementation(() => { throw new Error('internal grouping error'); });
	await expect(clusterClaims([q('one'), q('two')], undefined, 'test-openai-key')).rejects.toThrow('internal grouping error');
	expect(console.warn).not.toHaveBeenCalled();
});

test('a failed category falls back without losing another category’s valid themes', async () => {
	vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		const user = body.messages.find((message: { role: string }) => message.role === 'user').content;
		const content = user.includes('"category":"request"') ? 'not json' : JSON.stringify({ themes: [{ claim: 'healthy question', members: [0, 1] }] });
		return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
	}));
	const result = await clusterClassifiedClaims([
		{ ...q('question one'), commentId: 'q1' },
		{ category: 'request' as const, claim: 'request one', commentId: 'r1' },
		{ ...q('question two'), commentId: 'q2' },
		{ category: 'request' as const, claim: 'request two', commentId: 'r2' }
	], ['question', 'request'], 2, undefined, 'test-openai-key');
	expect(result).toEqual({ clusteringDegraded: true, classified: [
		{ category: 'question', claim: 'healthy question', commentId: 'q1', groupingSource: 'theme' },
		{ category: 'request', claim: 'request one', commentId: 'r1', groupingSource: 'original' },
		{ category: 'question', claim: 'healthy question', commentId: 'q2', groupingSource: 'theme' },
		{ category: 'request', claim: 'request two', commentId: 'r2', groupingSource: 'original' }
	] });
	expect(console.warn).toHaveBeenCalledTimes(1);
});

test('merges differently-worded same-theme claims onto one canonical claim', async () => {
	stubMerge({ themes: [{ claim: 'when is the next video', members: [0, 2] }, { claim: 'the audio is loud', members: [1] }] });
	const canonical = await clusterClaims(
		[q('next episode when?'), { category: 'criticism', claim: 'the audio is loud' }, q('part 2 release date?')],
		undefined,
		'test-openai-key'
	);
	expect(canonical.assignments.map((assignment) => assignment.claim)).toEqual(['when is the next video', 'the audio is loud', 'when is the next video']);
});

test('fewer than two claims skip the provider call entirely', async () => {
	vi.stubGlobal('fetch', vi.fn());
	expect(await clusterClaims([q('solo claim')], undefined, 'test-openai-key')).toEqual({ degraded: false, assignments: [{ claim: 'solo claim', groupingSource: 'original' }] });
	expect(await clusterClaims([], undefined, 'test-openai-key')).toEqual({ degraded: false, assignments: [] });
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
	['an index out of range', { themes: [{ claim: 'a', members: [0, 7] }] }, ['a', 'two']],
	['an index assigned twice', { themes: [{ claim: 'a', members: [0, 1] }, { claim: 'b', members: [1] }] }, ['a', 'two']],
	['an index omitted', { themes: [{ claim: 'a', members: [0] }] }, ['a', 'two']],
	['a cross-category merge', { themes: [{ claim: 'a', members: [0, 1] }] }, ['one', 'two']],
	['an empty themes array', { themes: [] }, ['one', 'two']],
	['a missing themes field', {}, ['one', 'two']],
	['an oversized canonical claim', { themes: [{ claim: 'x'.repeat(201), members: [0, 1] }] }, ['one', 'two']],
	['a blank canonical claim', { themes: [{ claim: '   ', members: [0, 1] }] }, ['one', 'two']],
	['empty members', { themes: [{ claim: 'a', members: [] }, { claim: 'b', members: [0, 1] }] }, ['b', 'b']],
	['non-integer members', { themes: [{ claim: 'a', members: [0, 'one'] }] }, ['a', 'two']],
	['non-JSON content', 'not json', ['one', 'two']]
])('a malformed merge response recovers — %s', async (name, payload, expected) => {
	stubMerge(payload);
	const rows = [q('one'), name === 'a cross-category merge' ? { category: 'criticism' as const, claim: 'two' } : q('two')];
	const result = await clusterClaims(rows, undefined, 'test-openai-key');
	expect(result.degraded).toBe(true);
	expect(result.assignments.map((assignment) => assignment.claim)).toEqual(expected);
});

test('the merge request defaults to gpt-6-luna with a none-effort pass', async () => {
	stubMerge({ themes: [{ claim: 'a', members: [0, 1] }] });
	await clusterClaims([q('a'), q('b')], undefined, 'test-openai-key');
	const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
	expect(body.model).toBe('gpt-6-luna');
	// gpt-6-luna is a reasoning model — it rejects temperature, so the
	// request carries a none-effort pass instead.
	expect(body.temperature).toBeUndefined();
	expect(body.reasoning_effort).toBe('none');
});

test('a non-OK provider response recovers with original claims', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 403 })));
	expect(await clusterClaims([q('a'), q('b')], undefined, 'test-openai-key')).toEqual({ degraded: true, assignments: [
		{ claim: 'a', groupingSource: 'original' }, { claim: 'b', groupingSource: 'original' }
	] });
});

test('identical input claims keep one label even when the model splits them into differently-worded themes', async () => {
	// Three exact-recurrence claims assigned three different canonical
	// wordings would each regroup as a singleton — splitting indistinguishable
	// inputs is provably wrong, so the first covering theme's label wins.
	stubMerge({
		themes: [
			{ claim: 'release schedule', members: [0] },
			{ claim: 'when is the next video', members: [1] },
			{ claim: 'upload cadence', members: [2] }
		]
	});
	const canonical = await clusterClaims(
		[q('release schedule'), q('release schedule'), q('release schedule')],
		undefined,
		'test-openai-key'
	);
	expect(canonical.assignments.map((assignment) => assignment.claim)).toEqual(['release schedule', 'release schedule', 'release schedule']);
});

test('identical input claims split across same-label themes unify rather than fail', async () => {
	stubMerge({
		themes: [
			{ claim: 'more cat videos', members: [0] },
			{ claim: 'more cat videos', members: [1, 2] }
		]
	});
	const canonical = await clusterClaims(
		[q('more cat videos pls'), q('more cat videos pls'), q('more cat videos pls')],
		undefined,
		'test-openai-key'
	);
	expect(canonical.assignments.map((assignment) => assignment.claim)).toEqual(['more cat videos', 'more cat videos', 'more cat videos']);
});

test('two same-category themes emitting the same canonical label retain their original claims', async () => {
	// 'Turn the volume up' and 'turn the volume down' are separate themes —
	// if two theme objects label them both 'audio volume' they merge at
	// regrouping into a false recurrence. The label should have been emitted
	// by one theme (or never shared); anything else is malformed.
	stubMerge({
		themes: [
			{ claim: 'audio volume', members: [0, 1] },
			{ claim: 'audio volume!', members: [2, 3] }
		]
	});
	const result = await clusterClaims(
		[
			{ category: 'request', claim: 'turn the volume up' },
			{ category: 'request', claim: 'louder please' },
			{ category: 'request', claim: 'turn the volume down' },
			{ category: 'request', claim: 'much quieter audio' }
		],
		undefined,
		'test-openai-key'
	);
	expect(result).toEqual({ degraded: true, assignments: [
		{ claim: 'turn the volume up', groupingSource: 'original' },
		{ claim: 'louder please', groupingSource: 'original' },
		{ claim: 'turn the volume down', groupingSource: 'original' },
		{ claim: 'much quieter audio', groupingSource: 'original' }
	] });
});

test('a content-free canonical label over real input claims is malformed', async () => {
	stubMerge({ themes: [{ claim: '...', members: [0, 1] }] });
	expect(await clusterClaims([q('when is the next video'), q('part 2 release date')], undefined, 'test-openai-key')).toEqual({ degraded: true, assignments: [
		{ claim: 'when is the next video', groupingSource: 'original' }, { claim: 'part 2 release date', groupingSource: 'original' }
	] });
});

test('a canonical label that sanitizes to nothing is malformed over real claims', async () => {
	// 'fucking shit' is nonblank with a nonempty normalized key, but
	// groupFeedback sanitizes it to '' and would pool every member —
	// the same silent loss a content-free label causes (codex).
	stubMerge({ themes: [{ claim: 'fucking shit', members: [0, 1] }] });
	expect(await clusterClaims([q('the audio is broken'), q('sound keeps cutting out')], undefined, 'test-openai-key')).toEqual({ degraded: true, assignments: [
		{ claim: 'the audio is broken', groupingSource: 'original' }, { claim: 'sound keeps cutting out', groupingSource: 'original' }
	] });
});

test('a content-free canonical label may echo already content-free input claims', async () => {
	// The classifier can emit '...' — echoing it back is pass-through that
	// pools downstream, not a malformed response.
	stubMerge({ themes: [{ claim: '...', members: [0, 1] }] });
	const canonical = await clusterClaims([q('...'), q('!!!')], undefined, 'test-openai-key');
	expect(canonical.assignments.map((assignment) => assignment.claim)).toEqual(['...', '...']);
});

test('content-free inputs cannot bridge themes — a junk label never reaches real claims', async () => {
	// '...' and '!!!' normalize to the same empty key, but they share no
	// semantics: linking them would let the junk-labeled theme win the
	// component and pool the real recurrence 'audio is broken' (codex).
	stubMerge({
		themes: [
			{ claim: '...', members: [0] },
			{ claim: 'audio is broken', members: [1, 2, 3] }
		]
	});
	const canonical = await clusterClaims(
		[q('...'), q('!!!'), q('the audio is broken'), q('sound keeps cutting out')],
		undefined,
		'test-openai-key'
	);
	expect(canonical.assignments.map((assignment) => assignment.claim)).toEqual(['...', 'audio is broken', 'audio is broken', 'audio is broken']);
});

test('equivalent inputs pull every member of the linked themes into one label', async () => {
	// The second theme asserts 'same words' and 'other words' belong
	// together; 'same words' ≡ 'same words' is provable, so the only
	// consistent read is all three under one label.
	stubMerge({
		themes: [
			{ claim: 'label a', members: [0] },
			{ claim: 'label b', members: [1, 2] }
		]
	});
	const canonical = await clusterClaims(
		[q('same words'), q('same words'), q('other words')],
		undefined,
		'test-openai-key'
	);
	expect(canonical.assignments.map((assignment) => assignment.claim)).toEqual(['label a', 'label a', 'label a']);
});

test('clusterClassifiedClaims merges per category — the provider never sees a mixed-category batch', async () => {
	// Reproduces the wedged digest: the model merged request index 0 with
	// criticism index 1 ("make the sound louder" + "the audio is too quiet")
	// and strict validation threw every tick. Merging per category makes a
	// cross-category theme impossible to emit — the request row never even
	// reaches the provider.
	const seen: { i: number; category: string; claim: string }[][] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			const user: string = body.messages.find((m: { role: string }) => m.role === 'user')?.content;
			const items = JSON.parse(user.replace(/^<data-[0-9a-f]+>\n|\n<\/data-[0-9a-f]+>$/g, '')) as {
				i: number;
				category: string;
				claim: string;
			}[];
			seen.push(items);
			// Mirror the production failure: a mixed-category batch lets the
			// model merge across categories — a response validation rejects.
			const categories = new Set(items.map((item) => item.category));
			const themes =
				categories.size > 1
					? [{ claim: 'one shared issue', members: items.map((item) => item.i) }]
					: [{ claim: 'merged theme', members: items.map((item) => item.i) }];
			return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ themes }) } }] }), {
				status: 200
			});
		})
	);
	const merged = await clusterClassifiedClaims(
		[
			{ commentId: 'r', category: 'request' as const, claim: 'make the sound louder' },
			{ commentId: 'c1', category: 'criticism' as const, claim: 'the audio is too quiet' },
			{ commentId: 'c2', category: 'criticism' as const, claim: 'the sound is off' }
		],
		['question', 'criticism', 'correction', 'request'],
		2,
		undefined,
		'test-openai-key'
	);
	expect(merged.classified.map((row) => row.claim)).toEqual(['make the sound louder', 'merged theme', 'merged theme']);
	expect(seen.length).toBe(1);
	for (const items of seen) expect(new Set(items.map((item) => item.category)).size).toBe(1);
});

test('clusterClassifiedClaims issues one merge call per category and stitches canonical claims back', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			const user: string = body.messages.find((m: { role: string }) => m.role === 'user')?.content;
			const items = JSON.parse(user.replace(/^<data-[0-9a-f]+>\n|\n<\/data-[0-9a-f]+>$/g, '')) as {
				i: number;
				category: string;
			}[];
			const themes = [{ claim: `merged ${items[0].category}`, members: items.map((item) => item.i) }];
			return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ themes }) } }] }), {
				status: 200
			});
		})
	);
	const merged = await clusterClassifiedClaims(
		[
			{ commentId: 'a', category: 'request' as const, claim: 'r1' },
			{ commentId: 'b', category: 'criticism' as const, claim: 'c1' },
			{ commentId: 'c', category: 'request' as const, claim: 'r2' },
			{ commentId: 'd', category: 'criticism' as const, claim: 'c2' }
		],
		['criticism', 'request'],
		2,
		undefined,
		'test-openai-key'
	);
	expect(merged.classified.map((row) => row.claim)).toEqual([
		'merged request',
		'merged criticism',
		'merged request',
		'merged criticism'
	]);
	expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
});

test('clusterClassifiedClaims skips the provider when no category has two feedback rows', async () => {
	vi.stubGlobal('fetch', vi.fn());
	const merged = await clusterClassifiedClaims(
		[
			{ commentId: 'a', category: 'request' as const, claim: 'r1' },
			{ commentId: 'b', category: 'criticism' as const, claim: 'c1' },
			{ commentId: 'n', category: 'none' as const, claim: '' }
		],
		['criticism', 'request'],
		2,
		undefined,
		'test-openai-key'
	);
	expect(merged.classified.map((row) => row.claim)).toEqual(['r1', 'c1', '']);
	expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

test('clusterClassifiedClaims rewrites feedback rows and leaves none rows untouched', async () => {
	stubMerge({ themes: [{ claim: 'shared theme', members: [0, 1] }] });
	const merged = await clusterClassifiedClaims(
		[
			{ commentId: 'a', category: 'question' as const, claim: 'wording one' },
			{ commentId: 'b', category: 'question' as const, claim: 'wording two' },
			{ commentId: 'n', category: 'none' as const, claim: '' }
		],
		['question'],
		2,
		undefined,
		'test-openai-key'
	);
	expect(merged.classified.map((row) => row.claim)).toEqual(['shared theme', 'shared theme', '']);
	// The merge input must only contain the two feedback rows — 'none' never
	// reaches the model or consumes a theme member slot.
	const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
	const user: string = body.messages.find((m: { role: string }) => m.role === 'user')?.content;
	expect(user).toContain('"i":1');
	expect(user).not.toContain('"i":2');
});

test('clusterClassifiedClaims skips provider calls for categories below the finding threshold', async () => {
	// codex: a category that cannot reach the supporters bar is pure provider
	// spend — grouping pools its rows identically clustered or not. Its rows
	// pass through unchanged; only the qualifying category is sent.
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			new Response(
				JSON.stringify({ choices: [{ message: { content: JSON.stringify({ themes: [{ claim: 'merged theme', members: [0, 1, 2] }] }) } }] }),
				{ status: 200 }
			)
		)
	);
	const merged = await clusterClassifiedClaims(
		[
			{ commentId: 'a', category: 'question' as const, claim: 'q1' },
			{ commentId: 'b', category: 'question' as const, claim: 'q2' },
			{ commentId: 'c', category: 'question' as const, claim: 'q3' },
			{ commentId: 'd', category: 'request' as const, claim: 'r1' },
			{ commentId: 'e', category: 'request' as const, claim: 'r2' }
		],
		['question', 'request'],
		3,
		undefined,
		'test-openai-key'
	);
	expect(merged.classified.map((row) => row.claim)).toEqual(['merged theme', 'merged theme', 'merged theme', 'r1', 'r2']);
	expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); // 'question' alone qualifies (3 ≥ 3)
});

test('clusterClassifiedClaims never sends disabled-category rows to the provider', async () => {
	stubMerge({ themes: [{ claim: 'shared theme', members: [0, 1] }] });
	const merged = await clusterClassifiedClaims(
		[
			{ commentId: 'a', category: 'question' as const, claim: 'wording one' },
			{ commentId: 'b', category: 'question' as const, claim: 'wording two' },
			{ commentId: 'c', category: 'criticism' as const, claim: 'disabled critique' }
		],
		['question'],
		2,
		undefined,
		'test-openai-key'
	);
	// Disabled-category rows keep their own claim — grouping pools them.
	expect(merged.classified.map((row) => row.claim)).toEqual(['shared theme', 'shared theme', 'disabled critique']);
	const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
	const user: string = body.messages.find((m: { role: string }) => m.role === 'user')?.content;
	expect(user).not.toContain('disabled critique');
});
