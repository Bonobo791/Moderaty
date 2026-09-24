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
