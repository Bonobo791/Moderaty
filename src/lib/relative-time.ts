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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function plural(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/** Human "N units ago" rendering for ISO timestamps; falls back to the raw string if unparseable. */
export function relativeTime(iso: string, now: Date = new Date()): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return iso;
	const diff = now.getTime() - then;
	if (diff < MINUTE) return 'just now';
	if (diff < HOUR) return plural(Math.floor(diff / MINUTE), 'minute');
	if (diff < DAY) return plural(Math.floor(diff / HOUR), 'hour');
	if (diff < WEEK) return plural(Math.floor(diff / DAY), 'day');
	return plural(Math.floor(diff / WEEK), 'week');
}
