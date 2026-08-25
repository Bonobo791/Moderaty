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

import { invalidateAll } from '$app/navigation';

/**
 * Re-runs the current page's load functions on a fixed interval so data
 * changed by background cron runs appears without a manual refresh.
 * Must be called during component initialization; the interval is cleared
 * automatically when the component is destroyed.
 *
 * @param intervalMs - Milliseconds between refreshes (default 15s)
 */
export function autoRefresh(intervalMs = 15_000): void {
	$effect(() => {
		const timer = setInterval(() => invalidateAll(), intervalMs);
		return () => clearInterval(timer);
	});
}
