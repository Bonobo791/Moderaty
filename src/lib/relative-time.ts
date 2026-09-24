const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

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
	if (diff < MONTH) return plural(Math.floor(diff / WEEK), 'week');
	if (diff < YEAR) return plural(Math.floor(diff / MONTH), 'month');
	return plural(Math.floor(diff / YEAR), 'year');
}
