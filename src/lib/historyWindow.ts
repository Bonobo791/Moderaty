export const HISTORY_MONTH_PRESETS = [1, 3, 6, 12, 24] as const;

export type HistoryWindow = (typeof HISTORY_MONTH_PRESETS)[number] | 'all';

export function parseHistoryWindow(value: string | null, allowAll = false): HistoryWindow | null {
	if (allowAll && value === 'all') return 'all';
	if (!value || !HISTORY_MONTH_PRESETS.some((months) => String(months) === value)) return null;
	return Number(value) as (typeof HISTORY_MONTH_PRESETS)[number];
}

export function historyWindowBoundary(window: HistoryWindow, now = Date.now()): string {
	return window === 'all' ? '1970-01-01T00:00:00.000Z' : new Date(now - window * 30 * 24 * 60 * 60 * 1000).toISOString();
}
