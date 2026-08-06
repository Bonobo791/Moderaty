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

// Test helper: shared fast-check arbitraries built from the app schema and
// API shapes (no zod in the repo — generators are hand-built). Test-only —
// never imported by app code. Importing this module configures fast-check
// globally (numRuns from FC_NUM_RUNS). Conventions: docs/property-testing.md.

import fc from 'fast-check';
import { env } from '$env/dynamic/private';

// ---------------------------------------------------------------------------
// Runner configuration
// ---------------------------------------------------------------------------

/**
 * Runs per property: FC_NUM_RUNS when set (burn-in), else 100. A set but
 * invalid value fails loudly — never silently defaults.
 */
export function pbtNumRuns(): number {
	const raw = env.FC_NUM_RUNS;
	if (raw === undefined || raw === '') return 100;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`FC_NUM_RUNS must be a positive integer, got ${JSON.stringify(raw)}`);
	}
	return parsed;
}

fc.configureGlobal({ numRuns: pbtNumRuns() });

// ---------------------------------------------------------------------------
// Ids and time
// ---------------------------------------------------------------------------

/** Random-hex-shaped ids, like the app's keys (users, orgs, sessions, invites). */
export const idArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-f0-9]{8}$/);

/** YouTube channel ids (UC…). */
export const channelIdArb: fc.Arbitrary<string> = fc.stringMatching(/^UC[A-Za-z0-9_-]{6}$/);

/** Milliseconds in ten years (365.25 days/year) — the retention/expiry horizon. */
export const TEN_YEARS_MS = 315576000000;

/** Formats an epoch-ms instant in the app's ISO storage format. */
export function toIso(instant: number): string {
	return new Date(instant).toISOString();
}

/** Always-parseable ISO timestamps within 2020–2035. */
export const isoTimestampArb: fc.Arbitrary<string> = fc
	.date({
		min: new Date(Date.UTC(2020, 0, 1)),
		max: new Date(Date.UTC(2035, 11, 31, 23, 59, 59, 999)),
		noInvalidDate: true
	})
	.map((date) => date.toISOString());

/** ISO timestamps strictly before `now` (1ms to ten years back). */
export function pastIsoArb(now: number): fc.Arbitrary<string> {
	return fc.integer({ min: 1, max: TEN_YEARS_MS }).map((offset) => toIso(now - offset));
}

/** ISO timestamps strictly after `now` (1ms to ten years ahead). */
export function futureIsoArb(now: number): fc.Arbitrary<string> {
	return fc.integer({ min: 1, max: TEN_YEARS_MS }).map((offset) => toIso(now + offset));
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Comment text inside the storage contract (≤500 chars). */
export const commentTextArb: fc.Arbitrary<string> = fc.string({ maxLength: 500 });

/** Comment text past the 500-char storage cap — must never be stored whole. */
export const overLimitTextArb: fc.Arbitrary<string> = fc.string({ minLength: 501, maxLength: 600 });

/**
 * Hostile-but-real text: valid comments, over-limit comments, and a library
 * of nasty constants (blank, whitespace-only, bidi override, NUL, emoji
 * flood, combining-mark flood).
 */
export const hostileTextArb: fc.Arbitrary<string> = fc.oneof(
	commentTextArb,
	overLimitTextArb,
	fc.constantFrom('', ' ', '\t\r\n ', '\u202Eevil', 'a\0b', '💣'.repeat(120), '\u0303'.repeat(700))
);

// ---------------------------------------------------------------------------
// Schema row shapes (drizzle shapes, hand-built — no zod)
// ---------------------------------------------------------------------------

export interface UserRow {
	id: string;
	googleSub: string;
	email: string;
	displayName: string;
}

export const userRowArb: fc.Arbitrary<UserRow> = fc.record({
	id: idArb,
	googleSub: idArb.map((id) => `sub-${id}`),
	email: idArb.map((id) => `${id}@example.com`),
	displayName: fc.string({ maxLength: 30 })
});

export interface OrgRow {
	id: string;
	name: string;
	personalFor: string | null;
}

export const orgRowArb: fc.Arbitrary<OrgRow> = fc.record({
	id: idArb,
	name: fc.string({ maxLength: 40 }),
	personalFor: fc.option(idArb, { nil: null })
});

export interface ChannelRow {
	id: string;
	userId: string | null;
	orgId: string | null;
	title: string;
	refreshTokenEnc: string;
}

/**
 * Channel rows honoring the channels_org_requires_owner CHECK (a connected
 * user implies an owning org): claimed (user+org), detached (org-owned, user
 * wiped by account deletion), orphan (pre-accounts, both null).
 */
export const channelRowArb: fc.Arbitrary<ChannelRow> = fc.oneof(
	fc.record({
		id: channelIdArb,
		userId: idArb,
		orgId: idArb,
		title: fc.string({ maxLength: 60 }),
		refreshTokenEnc: idArb
	}),
	fc.record({
		id: channelIdArb,
		userId: fc.constant(null),
		orgId: idArb,
		title: fc.string({ maxLength: 60 }),
		refreshTokenEnc: idArb
	}),
	fc.record({
		id: channelIdArb,
		userId: fc.constant(null),
		orgId: fc.constant(null),
		title: fc.string({ maxLength: 60 }),
		refreshTokenEnc: idArb
	})
);

// Status/decider vocabularies mirror the column comments in db/schema.ts —
// no exported constant exists app-side to import.
export const COMMENT_STATUSES = ['pending', 'approved', 'held', 'rejected', 'deleted', 'restoring'] as const;
export const COMMENT_DECIDERS = ['rule', 'ai', 'human', 'none'] as const;

export interface CommentRow {
	id: string;
	channelId: string;
	text: string;
	publishedAt: string;
	status: (typeof COMMENT_STATUSES)[number];
	decidedBy: (typeof COMMENT_DECIDERS)[number];
}

export const commentRowArb: fc.Arbitrary<CommentRow> = fc.record({
	id: idArb,
	channelId: channelIdArb,
	text: commentTextArb,
	publishedAt: isoTimestampArb,
	status: fc.constantFrom(...COMMENT_STATUSES),
	decidedBy: fc.constantFrom(...COMMENT_DECIDERS)
});

export const RULE_TYPES = ['keyword', 'regex', 'user'] as const;
export const RULE_ACTIONS = ['hold', 'reject', 'delete', 'ban'] as const;

export interface RuleConfigRow {
	channelId: string;
	type: (typeof RULE_TYPES)[number];
	pattern: string;
	action: (typeof RULE_ACTIONS)[number];
}

export const ruleConfigRowArb: fc.Arbitrary<RuleConfigRow> = fc.record({
	channelId: channelIdArb,
	type: fc.constantFrom(...RULE_TYPES),
	pattern: fc.string({ minLength: 1, maxLength: 60 }),
	action: fc.constantFrom(...RULE_ACTIONS)
});

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;

export interface MembershipRow {
	userId: string;
	orgId: string;
	role: (typeof MEMBERSHIP_ROLES)[number];
}

export const membershipRowArb: fc.Arbitrary<MembershipRow> = fc.record({
	userId: idArb,
	orgId: idArb,
	role: fc.constantFrom(...MEMBERSHIP_ROLES)
});

/**
 * A small tenant graph — users, orgs, channels, memberships with links
 * resolved to real entity references. Ids are unique per type in the initial
 * pool; membership (user, org) PAIRS are not guaranteed unique — dedupe
 * before inserting (the pair is the table's primary key).
 */
export interface OrgGraphUser {
	id: string;
	googleSub: string;
	email: string;
	displayName: string;
}

export interface OrgGraphOrg {
	id: string;
	name: string;
}

export interface OrgGraphChannel {
	id: string;
	title: string;
	refreshTokenEnc: string;
	org: OrgGraphOrg;
	connectedBy: OrgGraphUser | undefined;
}

export interface OrgGraphMembership {
	role: (typeof MEMBERSHIP_ROLES)[number];
	user: OrgGraphUser;
	org: OrgGraphOrg;
}

export interface OrgGraph {
	user: OrgGraphUser[];
	org: OrgGraphOrg[];
	channel: OrgGraphChannel[];
	membership: OrgGraphMembership[];
}

interface OrgGraphFields {
	user: OrgGraphUser;
	org: OrgGraphOrg;
	channel: Pick<OrgGraphChannel, 'id' | 'title' | 'refreshTokenEnc'>;
	membership: Pick<OrgGraphMembership, 'role'>;
}

type OrgGraphRelations = {
	user: Record<string, never>;
	org: Record<string, never>;
	membership: {
		user: { arity: '1'; type: 'user' };
		org: { arity: '1'; type: 'org' };
	};
	channel: {
		org: { arity: '1'; type: 'org' };
		connectedBy: { arity: '0-1'; type: 'user' };
	};
};

// fast-check computes the graph value through a recursive mapped type
// (EntityGraphValue); with named interfaces TS reports a circular-reference
// error the moment that type is expanded, so the value type is asserted to
// the hand-written OrgGraph instead (via unknown — even `as` comparability
// expands it). Runtime is unaffected: the meta-test 'orgGraphArb links
// resolve to entities inside the graph' pins the shape.
export const orgGraphArb = fc.entityGraph<OrgGraphFields, OrgGraphRelations>(
	{
		user: {
			id: idArb,
			googleSub: idArb.map((id) => `sub-${id}`),
			email: idArb.map((id) => `${id}@example.com`),
			displayName: fc.string({ maxLength: 30 })
		},
		org: { id: idArb, name: fc.string({ maxLength: 40 }) },
		channel: { id: channelIdArb, title: fc.string({ maxLength: 60 }), refreshTokenEnc: idArb },
		membership: { role: fc.constantFrom(...MEMBERSHIP_ROLES) }
	},
	{
		user: {},
		org: {},
		membership: {
			user: { arity: '1', type: 'user' },
			org: { arity: '1', type: 'org' }
		},
		channel: {
			org: { arity: '1', type: 'org' },
			connectedBy: { arity: '0-1', type: 'user' }
		}
	},
	{
		initialPoolConstraints: {
			user: { minLength: 1, maxLength: 4 },
			org: { minLength: 1, maxLength: 3 },
			channel: { minLength: 1, maxLength: 4 },
			membership: { minLength: 1, maxLength: 6 }
		},
		unicityConstraints: {
			user: (user) => user.id,
			org: (org) => org.id,
			channel: (channel) => channel.id
		}
	}
) as unknown as fc.Arbitrary<OrgGraph>;

// ---------------------------------------------------------------------------
// YouTube commentThreads.list payloads (I1 fuzzing)
// ---------------------------------------------------------------------------

export interface CommentThreadItem {
	id?: string;
	snippet: {
		videoId?: string;
		topLevelComment: {
			id?: string;
			snippet: {
				videoId?: string;
				textDisplay?: string;
				publishedAt?: string;
				authorDisplayName?: string;
				authorChannelId?: { value?: string };
			};
		};
	};
}

/** A raw commentThread item the real parser always accepts. */
export const commentThreadItemArb: fc.Arbitrary<CommentThreadItem> = fc.record({
	id: idArb,
	snippet: fc.record({
		videoId: idArb,
		topLevelComment: fc.record({
			id: idArb,
			snippet: fc.record({
				videoId: idArb,
				textDisplay: fc.string({ minLength: 1, maxLength: 500 }),
				publishedAt: isoTimestampArb,
				authorDisplayName: fc.string({ minLength: 1, maxLength: 40 }),
				authorChannelId: fc.record({ value: channelIdArb })
			})
		})
	})
});

const MALFORMATIONS = ['id', 'threadId', 'text', 'publishedAtMissing', 'publishedAtInvalid'] as const;

/** The malformation kinds malformedItemArb applies (exported for per-kind tests). */
export { MALFORMATIONS };
export type Malformation = (typeof MALFORMATIONS)[number];

/** Applies one malformation to a valid item, returning a new object. */
export function malformItem(item: CommentThreadItem, malformation: Malformation): CommentThreadItem {
	const clone = structuredClone(item);
	switch (malformation) {
		case 'id':
			delete clone.snippet.topLevelComment.id;
			break;
		case 'threadId':
			delete clone.id;
			break;
		case 'text':
			delete clone.snippet.topLevelComment.snippet.textDisplay;
			break;
		case 'publishedAtMissing':
			delete clone.snippet.topLevelComment.snippet.publishedAt;
			break;
		case 'publishedAtInvalid':
			clone.snippet.topLevelComment.snippet.publishedAt = 'not-a-date';
			break;
	}
	return clone;
}

/**
 * A commentThread item the real parser must SKIP (malformed = missing or
 * invalid id, threadId, text, or publishedAt — I1: item-level garbage is
 * skipped, never fatal). Guaranteed malformed by construction: at least one
 * malformation is always applied.
 */
export const malformedItemArb: fc.Arbitrary<CommentThreadItem> = fc
	.tuple(
		commentThreadItemArb,
		fc.array(fc.constantFrom(...MALFORMATIONS), { minLength: 1, maxLength: 4 })
	)
	.map(([item, malformations]) => malformations.reduce(malformItem, item));

/**
 * A commentThreads.list response body: 'valid' = every item parses; 'mixed' =
 * any blend of valid and malformed items (the I1 case: valid items processed,
 * malformed ones skipped, batch never aborts — for any page size).
 */
export function commentThreadsResponseArb(mode: 'valid' | 'mixed'): fc.Arbitrary<unknown> {
	const itemArb =
		mode === 'valid' ? commentThreadItemArb : fc.oneof(commentThreadItemArb, malformedItemArb);
	return fc.record({
		// Stryker disable next-line StringLiteral: "" equivalent — the parser never reads the response kind field
		kind: fc.constant('youtube#commentThreadListResponse'),
		items: fc.array(itemArb),
		nextPageToken: fc.option(idArb, { nil: undefined })
	});
}

// ---------------------------------------------------------------------------
// Rule regexes (I6)
// ---------------------------------------------------------------------------

// Fragment library: no backreferences, no groups with duplicate alternatives,
// all recheck-provable. Joined with |; uniqueArray dedupes by construction.
const SAFE_REGEX_FRAGMENTS = [
	'spam',
	'free money',
	'[0-9]+',
	'https?://',
	'(buy|sell)',
	'\\bclick\\b',
	'[aeiou]{2}',
	'win\\d*'
] as const;

/** Regex sources that always pass validateRule (type 'regex'). */
export const safeRegexArb: fc.Arbitrary<string> = fc
	.uniqueArray(fc.constantFrom(...SAFE_REGEX_FRAGMENTS), { minLength: 1, maxLength: 4 })
	.map((fragments) => fragments.join('|'));

/**
 * Patterns validateRule must always reject: digit/named backreferences,
 * duplicate alternation, textbook catastrophic backtracking, or past the
 * 256-char cap (any 257+ char string trips the length guard regardless of
 * content).
 */
export const unsafeRegexArb: fc.Arbitrary<string> = fc.oneof(
	fc.constantFrom('(spam)\\1', '(?<g>free)\\k<g>', '(foo|foo)', '(a+)+$'),
	fc.string({ minLength: 257, maxLength: 280 })
);
