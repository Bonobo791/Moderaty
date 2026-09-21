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

// intentRelease bounds every optimistic-submit mask (SensitivitySwitch's
// `dirty`, the channel page's protection overrides): the echo release is the
// normal path, but a concurrent write can mean no echo ever lands — these
// pin the timer semantics both components rely on (codex, PR #147).

import { expect, test, vi } from 'vitest';

import { INTENT_RELEASE_MS, armIntentRelease } from './intentRelease';

test('the release fires once the bound elapses — never before', () => {
	vi.useFakeTimers();
	try {
		const release = vi.fn();
		armIntentRelease(release);
		vi.advanceTimersByTime(INTENT_RELEASE_MS - 1);
		expect(release).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(release).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

test('the bound outlives at least one auto-refresh cycle', () => {
	// autoRefresh invalidates every 15s — a bound shorter than that could drop
	// the mask before the echo had any chance to land.
	expect(INTENT_RELEASE_MS).toBeGreaterThan(15_000);
});

test('cancelling prevents the release — a stale timer must never drop a newer mask', () => {
	vi.useFakeTimers();
	try {
		const release = vi.fn();
		const cancel = armIntentRelease(release);
		cancel();
		cancel();
		vi.advanceTimersByTime(INTENT_RELEASE_MS * 2);
		expect(release).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});
