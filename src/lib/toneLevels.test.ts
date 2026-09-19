// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; see LICENSE.

// The shared tone-level representation (MOD-14): the type, the canonical
// list, and the boundary guard must never disagree — a level added to
// TONE_LEVELS widens ToneLevel, so a guard that re-hardcodes the members
// would silently reject the new level at validation, the scoring gate, and
// the UI (cubic, PR #142).

import { expect, test } from 'vitest';

import { TONE_LEVELS, isToneLevel } from './toneLevels';

test('every canonical level passes the boundary guard — type and guard cannot drift', () => {
	for (const level of TONE_LEVELS) expect(isToneLevel(level)).toBe(true);
});

test('non-level values are rejected at the boundary', () => {
	for (const value of [0, 3, '1', 'strict', null, undefined, {}]) {
		expect(isToneLevel(value)).toBe(false);
	}
});
