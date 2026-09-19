// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

// The sensitivity switch's save-failure contract (MOD-10): a failed
// setToneLevel submit must revert the knob to the persisted server value
// AND surface a visible message — the pre-MOD-10 code reverted silently,
// which read exactly like a successful save.

import { expect, test } from 'vitest';

import { persistOutcome } from './sensitivityPersist';

test('a successful submit applies: no revert, no error copy', () => {
	expect(persistOutcome({ type: 'success' }, 2)).toEqual({ kind: 'applied' });
});

test.each([
	{ type: 'failure', name: 'a validation/server failure' },
	{ type: 'error', name: 'a network or thrown-error result' }
])('$name reverts the knob to the persisted level with a visible message', ({ type }) => {
	const outcome = persistOutcome({ type, data: { error: 'channel not found' } }, 1);

	expect(outcome).toMatchObject({ kind: 'reverted', selected: 1 });
	// The server's own message travels so the user sees WHY it did not save.
	expect((outcome as { message: string }).message).toContain('channel not found');
	expect((outcome as { message: string }).message).toContain('could not be saved');
});

test('a generic server detail is not prefixed twice (cubic, PR #142)', () => {
	// The 502 path's detail IS the generic message — prefixing it again would
	// render "Sensitivity could not be saved — Sensitivity could not be saved…".
	const outcome = persistOutcome(
		{ type: 'failure', data: { error: 'Sensitivity could not be saved — try again.' } },
		1
	);

	expect((outcome as { message: string }).message).toBe('Sensitivity could not be saved — try again.');
});

test('a failure without server detail falls back to generic copy — never silent', () => {
	const outcome = persistOutcome({ type: 'failure' }, 2);

	expect(outcome).toMatchObject({ kind: 'reverted', selected: 2 });
	expect((outcome as { message: string }).message).toBe('Sensitivity could not be saved — try again.');
});

test('the knob reverts to whatever the server persisted, not the attempted value', () => {
	// Persisted strict (2), user flipped to chill (1), save failed → the knob
	// returns to strict: the control never displays a value the DB does not hold.
	expect(persistOutcome({ type: 'failure' }, 2)).toMatchObject({ selected: 2 });
	expect(persistOutcome({ type: 'failure' }, 1)).toMatchObject({ selected: 1 });
});
