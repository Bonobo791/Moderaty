// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Advanced Digital Marketing LTDA
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
