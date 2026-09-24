// Safe actionable copy per persisted failure category — cron only stores
// the category, so raw provider detail can never reach a page. Shared by
// the dashboard status cell and the channel header (PR #142: identical
// states must read identically on both surfaces).
const FAILURE_ACTIONS: Record<string, string> = {
	token: 'YouTube access expired — reconnect the channel',
	credits: 'AI credits ran out — top up on the usage page; we retry on the next check',
	quota: 'YouTube quota is exhausted — we retry on the next check',
	scoring: 'AI scoring was unavailable — we retry on the next check',
	timeout: 'The last check timed out — we retry on the next check'
};

export function runFailureAction(category: string | null): string {
	return FAILURE_ACTIONS[category ?? ''] ?? 'The last check failed — we retry on the next check';
}
