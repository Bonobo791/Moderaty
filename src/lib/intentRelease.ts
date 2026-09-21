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
