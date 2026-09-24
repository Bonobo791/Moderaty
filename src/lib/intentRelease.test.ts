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
