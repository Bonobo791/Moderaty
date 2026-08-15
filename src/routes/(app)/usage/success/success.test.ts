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
	return load({ locals: { user: OWNER } as never, url: new URL(`http://localhost/usage/success${sessionId ? `?session_id=${sessionId}` : ''}`) } as never);
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

	test('a session for ANOTHER org is never fulfilled here', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession({ metadata: { org_id: 'org-other', bundle: 'credits_500' } }));

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(false);
		expect(data.pending).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
	});
});
