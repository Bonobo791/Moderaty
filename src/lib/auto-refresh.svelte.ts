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
