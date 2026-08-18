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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { organizations } from '$lib/server/db/schema';
import { getCredits } from '$lib/server/billing/ledger';

const mocks = vi.hoisted(() => ({
	sessionsRetrieve: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		checkout: { sessions: { retrieve: mocks.sessionsRetrieve } }
	})
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { load } from './+page.server';

setupTestDb(['organizations', 'credit_transactions', 'stripe_events']);

const OWNER = TEST_OWNER;

function paidSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'cs_1',
		payment_status: 'paid',
		metadata: { org_id: 'org-1', bundle: 'credits_500' },
		...overrides
	};
}

function loadWith(sessionId: string | null) {
	// Build from a fixed base URL; the query value goes through searchParams
	// (repo guideline: new URL(path, base), never interpolation — coderabbit).
	const url = new URL('/usage/success', 'http://localhost');
	if (sessionId !== null) url.searchParams.set('session_id', sessionId);
	return load({ locals: { user: OWNER } as never, url } as never);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('usage/success load', () => {
	test('grants the credits when the user lands before the webhook', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession());

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(true);
		expect(data.pending).toBe(false);
		expect(data.failed).toBe(false);
		expect(await getCredits('org-1')).toBe(500);
	});

	test('a paid session already granted by the webhook still shows success (never "No purchase found")', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession());
		// First load: the page grants. Second load (refresh): the webhook has
		// also granted — fulfillCheckout is an idempotent no-op.
		await loadWith('cs_1');
		expect(await getCredits('org-1')).toBe(500);

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(true);
		expect(data.failed).toBe(false);
		expect(await getCredits('org-1')).toBe(500); // still exactly once
	});

	test('an unpaid session stays pending', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession({ payment_status: 'unpaid' }));

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(false);
		expect(data.pending).toBe(true);
		expect(data.failed).toBe(false);
	});

	test('a paid session with missing/invalid bundle metadata FAILS — never a fake success', async () => {
		// fulfillCheckout returns 'rejected' for a paid session whose bundle
		// metadata is unusable: the page must NOT report success for credits
		// that were never granted (coderabbit — the old boolean fallback
		// `fulfillCheckout() || payment_status === 'paid'` showed success for
		// any paid session, even when nothing was credited).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession({ metadata: { org_id: 'org-1', bundle: 'credits_999999' } }));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(false);
		expect(data.pending).toBe(false);
		expect(data.failed).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		errorSpy.mockRestore();
	});

	test('a retrieval failure logs a fixed category and a truncated id — never the raw error or full session id', async () => {
		// The session id is query-controlled and the provider error can carry
		// payment details — the log must stay restricted (coderabbit).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockRejectedValue(new Error('No such checkout session: cs_1 (card data redacted)'));

		const logged: string[] = [];
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
			logged.push(String(args[0]));
		});
		try {
			const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };
			expect(data.pending).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain('could not fulfill checkout');
		expect(logged[0]).not.toContain('cs_1');
		expect(logged[0]).not.toContain('card data redacted');
	});

	test('a session for ANOTHER org is never fulfilled here', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession({ metadata: { org_id: 'org-other', bundle: 'credits_500' } }));

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(false);
		expect(data.pending).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
	});
});
