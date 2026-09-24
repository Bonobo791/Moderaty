// Shared bound for optimistic-submit masks (SensitivitySwitch's `dirty`, the
// channel page's protection overrides). The normal release is the server row
// echoing the saved intent — but a concurrent write (another tab, a teammate)
// can mean no echo ever lands. Without a bound the mask hides every 15s
// autoRefresh forever, and a later whole-row submit rewrites the stale intent
// over the newer server change. Two refresh cycles is long enough for any
// honest echo to arrive first, short enough to self-heal promptly (codex,
// PR #147).

export const INTENT_RELEASE_MS = 30_000;

/**
 * Arms a one-shot release timer; returns the cancel. Callers cancel the
 * pending release before re-arming — and on new intent, a landed echo, or
 * teardown — so a stale timer can never drop a newer mask.
 */
export function armIntentRelease(release: () => void): () => void {
	const timer = setTimeout(release, INTENT_RELEASE_MS);
	return () => clearTimeout(timer);
}
