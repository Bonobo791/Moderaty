// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Meta-tests for the shared arbitraries: every generator's construction
// contract is pinned here (the module sits IN the Stryker mutate scope, so
// these tests are its kill basis — a silently weakened arbitrary would
// otherwise weaken every property that uses it).

import fc from 'fast-check';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { validateRule } from './rules';
import { fetchNewComments } from './youtube';
import {
	COMMENT_DECIDERS,
	COMMENT_STATUSES,
	MALFORMATIONS,
	MEMBERSHIP_ROLES,
	RULE_ACTIONS,
	RULE_TYPES,
	TEN_YEARS_MS,
	channelIdArb,
	channelRowArb,
	commentRowArb,
	commentTextArb,
	commentThreadItemArb,
	commentThreadsResponseArb,
	futureIsoArb,
	hostileTextArb,
	idArb,
	isoTimestampArb,
	malformItem,
	malformedItemArb,
	membershipRowArb,
	orgGraphArb,
	orgRowArb,
	overLimitTextArb,
	pastIsoArb,
	pbtNumRuns,
	ruleConfigRowArb,
	safeRegexArb,
	toIso,
	unsafeRegexArb,
	userRowArb,
	type CommentThreadItem,
	type Malformation
} from './testarbitraries';

afterEach(() => {
	delete mocks.env.FC_NUM_RUNS;
	vi.unstubAllGlobals();
});

// --- runner configuration ---------------------------------------------------

test('pbtNumRuns defaults to 100 when FC_NUM_RUNS is unset or empty', () => {
	expect(pbtNumRuns()).toBe(100);
	mocks.env.FC_NUM_RUNS = '';
	expect(pbtNumRuns()).toBe(100);
});

test('pbtNumRuns honors a positive integer FC_NUM_RUNS — including 1', () => {
	mocks.env.FC_NUM_RUNS = '250';
	expect(pbtNumRuns()).toBe(250);
	mocks.env.FC_NUM_RUNS = '1';
	expect(pbtNumRuns()).toBe(1);
});

test('pbtNumRuns throws loudly on garbage FC_NUM_RUNS — never silently defaults', () => {
	for (const garbage of ['abc', '1.5', '0', '-3']) {
		mocks.env.FC_NUM_RUNS = garbage;
		expect(() => pbtNumRuns()).toThrow('FC_NUM_RUNS must be a positive integer');
	}
});

// --- ids and time ------------------------------------------------------------

test('idArb generates app-shaped random-hex ids', () => {
	// Predicates must return undefined (block body): vitest's expect() returns
	// an Assertion object, which fast-check reads as a failing verdict.
	fc.assert(
		fc.property(idArb, (id) => {
			expect(id).toMatch(/^[a-f0-9]{8}$/);
		})
	);
});

test('channelIdArb generates UC-prefixed channel ids', () => {
	fc.assert(
		fc.property(channelIdArb, (id) => {
			expect(id).toMatch(/^UC[A-Za-z0-9_-]{6}$/);
		})
	);
});

test('toIso formats epoch ms in the app ISO storage format', () => {
	expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z');
	expect(toIso(Date.UTC(2026, 0, 15, 12, 30, 45, 123))).toBe('2026-01-15T12:30:45.123Z');
});

test('isoTimestampArb only generates parseable timestamps within 2020–2035', () => {
	fc.assert(
		fc.property(isoTimestampArb, (timestamp) => {
			const ms = Date.parse(timestamp);
			expect(Number.isNaN(ms)).toBe(false);
			expect(ms).toBeGreaterThanOrEqual(Date.UTC(2020, 0, 1));
			expect(ms).toBeLessThanOrEqual(Date.UTC(2035, 11, 31, 23, 59, 59, 999));
		})
	);
});

const NOW = Date.UTC(2026, 5, 15);

test('pastIsoArb is strictly before now and within ten years back', () => {
	fc.assert(
		fc.property(pastIsoArb(NOW), (timestamp) => {
			const ms = Date.parse(timestamp);
			expect(ms).toBeLessThan(NOW);
			expect(ms).toBeGreaterThanOrEqual(NOW - TEN_YEARS_MS);
		})
	);
});

test('futureIsoArb is strictly after now and within ten years ahead', () => {
	fc.assert(
		fc.property(futureIsoArb(NOW), (timestamp) => {
			const ms = Date.parse(timestamp);
			expect(ms).toBeGreaterThan(NOW);
			expect(ms).toBeLessThanOrEqual(NOW + TEN_YEARS_MS);
		})
	);
});

// --- text --------------------------------------------------------------------

test('commentTextArb stays within the 500-char storage contract', () => {
	fc.assert(
		fc.property(commentTextArb, (text) => {
			expect(text.length).toBeLessThanOrEqual(500);
		})
	);
});

test('overLimitTextArb always exceeds the 500-char cap', () => {
	fc.assert(
		fc.property(overLimitTextArb, (text) => {
			expect(text.length).toBeGreaterThan(500);
			expect(text.length).toBeLessThanOrEqual(600);
		})
	);
});

test('hostileTextArb generates strings, including blank and over-limit samples', () => {
	const samples = fc.sample(hostileTextArb, { numRuns: 300, seed: 42 });
	expect(samples.every((sample) => typeof sample === 'string')).toBe(true);
	expect(samples.some((sample) => sample.length === 0)).toBe(true);
	expect(samples.some((sample) => sample.length > 500)).toBe(true);
});

// --- row shapes ----------------------------------------------------------------

test('userRowArb rows have app-shaped synthetic identities', () => {
	fc.assert(
		fc.property(userRowArb, (row) => {
			expect(row.id).toMatch(/^[a-f0-9]{8}$/);
			expect(row.googleSub).toMatch(/^sub-[a-f0-9]{8}$/);
			expect(row.email).toMatch(/^[a-f0-9]{8}@example\.com$/);
		})
	);
});

test('orgRowArb rows have an id, a name, and personalFor null or an id', () => {
	fc.assert(
		fc.property(orgRowArb, (row) => {
			expect(row.id).toMatch(/^[a-f0-9]{8}$/);
			expect(typeof row.name).toBe('string');
			expect(row.personalFor === null || /^[a-f0-9]{8}$/.test(row.personalFor)).toBe(true);
		})
	);
});

test('channelRowArb always honors the channels_org_requires_owner CHECK', () => {
	fc.assert(
		fc.property(channelRowArb, (row) => {
			// org_id IS NOT NULL OR user_id IS NULL — a connected user implies an org.
			expect(row.orgId !== null || row.userId === null).toBe(true);
			expect(row.id).toMatch(/^UC/);
			expect(row.refreshTokenEnc).toMatch(/^[a-f0-9]{8}$/);
		})
	);
});

test('channelRowArb generates all three ownership variants', () => {
	const samples = fc.sample(channelRowArb, { numRuns: 100, seed: 42 });
	expect(samples.some((row) => row.userId !== null && row.orgId !== null)).toBe(true);
	expect(samples.some((row) => row.userId === null && row.orgId !== null)).toBe(true);
	expect(samples.some((row) => row.userId === null && row.orgId === null)).toBe(true);
});

test('commentRowArb stays inside the status/decider vocabularies and the text cap', () => {
	fc.assert(
		fc.property(commentRowArb, (row) => {
			expect(COMMENT_STATUSES).toContain(row.status);
			expect(COMMENT_DECIDERS).toContain(row.decidedBy);
			expect(row.text.length).toBeLessThanOrEqual(500);
			expect(Number.isNaN(Date.parse(row.publishedAt))).toBe(false);
		})
	);
});

test('ruleConfigRowArb stays inside the type/action vocabularies with a non-empty pattern', () => {
	fc.assert(
		fc.property(ruleConfigRowArb, (row) => {
			expect(RULE_TYPES).toContain(row.type);
			expect(RULE_ACTIONS).toContain(row.action);
			expect(row.pattern.length).toBeGreaterThanOrEqual(1);
			expect(row.channelId).toMatch(/^UC/);
		})
	);
});

test('membershipRowArb stays inside the role vocabulary', () => {
	fc.assert(
		fc.property(membershipRowArb, (row) => {
			expect(MEMBERSHIP_ROLES).toContain(row.role);
			expect(row.userId).toMatch(/^[a-f0-9]{8}$/);
			expect(row.orgId).toMatch(/^[a-f0-9]{8}$/);
		})
	);
});

// --- entity graph --------------------------------------------------------------

test('orgGraphArb links resolve to entities inside the graph', () => {
	fc.assert(
		fc.property(orgGraphArb, (graph) => {
			expect(graph.user.length).toBeGreaterThanOrEqual(1);
			expect(graph.org.length).toBeGreaterThanOrEqual(1);
			const userIds = new Set(graph.user.map((user) => user.id));
			const orgIds = new Set(graph.org.map((org) => org.id));
			for (const user of graph.user) {
				expect(user.googleSub).toMatch(/^sub-[a-f0-9]{8}$/);
				expect(user.email).toMatch(/^[a-f0-9]{8}@example\.com$/);
			}
			for (const membership of graph.membership) {
				expect(userIds.has(membership.user.id)).toBe(true);
				expect(orgIds.has(membership.org.id)).toBe(true);
			}
			for (const channel of graph.channel) {
				expect(orgIds.has(channel.org.id)).toBe(true);
				if (channel.connectedBy !== undefined) {
					expect(userIds.has(channel.connectedBy.id)).toBe(true);
				}
			}
		})
	);
});

// --- YouTube payloads through the real parser ------------------------------------

function stubYouTube(body: unknown): void {
	vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }));
}

test('valid commentThreads responses: every generated item is processed by the real parser', async () => {
	await fc.assert(
		fc.asyncProperty(commentThreadsResponseArb('valid'), async (response) => {
			// Strip any page token so the fetch is exactly one page.
			const body = { ...(response as { items: unknown[]; nextPageToken?: string }) };
			// An omitted page token is `undefined`, matching YouTube's JSON — never null.
			expect(body.nextPageToken).not.toBeNull();
			body.nextPageToken = undefined;
			stubYouTube(body);
			const page = await fetchNewComments('UCchan', 'token', null, { maxPages: 1 });
			expect(page.comments).toHaveLength(body.items.length);
			for (const comment of page.comments) {
				expect(comment.id).toBeTruthy();
				expect(comment.text).toBeTruthy();
				expect(Number.isNaN(Date.parse(comment.publishedAt))).toBe(false);
			}
		})
	);
});

test('malformItem breaks exactly the field each malformation names', () => {
	const [base] = fc.sample(commentThreadItemArb, { numRuns: 1, seed: 42 });
	const broken: Record<Malformation, (item: CommentThreadItem) => boolean> = {
		id: (item) => item.snippet.topLevelComment.id === undefined,
		threadId: (item) => item.id === undefined,
		text: (item) => item.snippet.topLevelComment.snippet.textDisplay === undefined,
		publishedAtMissing: (item) => item.snippet.topLevelComment.snippet.publishedAt === undefined,
		// present-but-unparseable — a different input class than a missing field
		publishedAtInvalid: (item) => item.snippet.topLevelComment.snippet.publishedAt === 'not-a-date'
	};
	for (const kind of MALFORMATIONS) {
		expect(broken[kind](malformItem(base, kind))).toBe(true);
	}
	// The base item is never mutated.
	expect(base.snippet.topLevelComment.id).toBeTruthy();
	expect(base.id).toBeTruthy();
});

test('malformed items: always skipped by the real parser, never fatal (I1)', async () => {
	await fc.assert(
		fc.asyncProperty(malformedItemArb, async (item) => {
			stubYouTube({ items: [item] });
			const page = await fetchNewComments('UCchan', 'token', null, { maxPages: 1 });
			expect(page.comments).toHaveLength(0);
		})
	);
});

test('mixed responses: the parser never aborts and outputs are well-formed (I1)', async () => {
	await fc.assert(
		fc.asyncProperty(commentThreadsResponseArb('mixed'), async (response) => {
			const body = { ...(response as { items: unknown[] }), nextPageToken: undefined };
			stubYouTube(body);
			const page = await fetchNewComments('UCchan', 'token', null, { maxPages: 1 });
			expect(page.comments.length).toBeLessThanOrEqual(body.items.length);
			for (const comment of page.comments) {
				expect(comment.id).toBeTruthy();
				expect(Number.isNaN(Date.parse(comment.publishedAt))).toBe(false);
			}
		})
	);
});

test('mixed mode can actually produce parser-skipped items (not a disguised valid mode)', async () => {
	let sawSkipped = false;
	for (const response of fc.sample(commentThreadsResponseArb('mixed'), { numRuns: 20, seed: 42 })) {
		const body = { ...(response as { items: unknown[] }), nextPageToken: undefined };
		stubYouTube(body);
		const page = await fetchNewComments('UCchan', 'token', null, { maxPages: 1 });
		if (page.comments.length < body.items.length) sawSkipped = true;
	}
	expect(sawSkipped).toBe(true);
});

// --- rule regexes (I6) -----------------------------------------------------------

test('safeRegexArb always passes validateRule', () => {
	fc.assert(
		fc.property(safeRegexArb, (pattern) => {
			expect(() => validateRule({ id: 1, type: 'regex', pattern, action: 'hold' })).not.toThrow();
		})
	);
});

test('unsafeRegexArb is always rejected by validateRule — never accepted-unsafe (I6)', () => {
	fc.assert(
		fc.property(unsafeRegexArb, (pattern) => {
			expect(() => validateRule({ id: 1, type: 'regex', pattern, action: 'hold' })).toThrow();
		})
	);
});
