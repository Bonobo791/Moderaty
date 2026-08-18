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

import { expect, test } from 'vitest';

import { eq } from 'drizzle-orm';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { contactSubmissions } from '$lib/server/db/schema';
import { CONTACT_OPT_IN_TEXT } from '$lib/server/contact';

import { load } from './+page.server';

setupTestDb(['contact_submissions']);

async function seedRow(token: string, overrides: { status?: string; expiresAt?: string } = {}) {
	const inserted = await testDb()
		.db.insert(contactSubmissions)
		.values({
			email: 'fan@example.com',
			name: 'Fan',
			status: 'pending',
			verificationToken: token,
			expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
			consentText: CONTACT_OPT_IN_TEXT,
			ip: '127.0.0.1',
			userAgent: 'test'
		})
		.returning();
	if (overrides.status) {
		await testDb()
			.db.update(contactSubmissions)
			.set({ status: overrides.status, verifiedAt: overrides.status === 'verified' ? new Date().toISOString() : null })
			.where(eq(contactSubmissions.id, inserted[0].id));
	}
	return inserted[0];
}

function loadVerify(token: string | null) {
	const url = new URL('http://localhost/contact/verify');
	if (token !== null) url.searchParams.set('token', token);
	return load({ url } as never);
}

test('rejects a tokenless visit with 400', async () => {
	try {
		await loadVerify(null);
		expect.unreachable('load should throw');
	} catch (e) {
		expect(e).toMatchObject({ status: 400 });
	}
});

test('marks a valid token verified and returns the confirmed e-mail', async () => {
	await seedRow('tok-ok');
	const data = await loadVerify('tok-ok');
	expect(data).toEqual({ state: 'verified', email: 'fan@example.com' });
	const row = await testDb().db.select().from(contactSubmissions).where(eq(contactSubmissions.verificationToken, 'tok-ok')).get();
	expect(row!.status).toBe('verified');
	expect(row!.verifiedAt).toEqual(expect.any(String));
});

test('is idempotent: re-opening an already verified link reports already_verified', async () => {
	await seedRow('tok-done', { status: 'verified' });
	const data = await loadVerify('tok-done');
	expect(data).toEqual({ state: 'already_verified', email: 'fan@example.com' });
});

test('reports expired for an unverified token past its expiry and does not flip it', async () => {
	await seedRow('tok-old', { expiresAt: new Date(Date.now() - 1000).toISOString() });
	const data = await loadVerify('tok-old');
	expect(data).toEqual({ state: 'expired', email: 'fan@example.com' });
	const row = await testDb().db.select().from(contactSubmissions).where(eq(contactSubmissions.verificationToken, 'tok-old')).get();
	expect(row!.status).toBe('pending');
});

test('reports invalid for an unknown token', async () => {
	const data = await loadVerify('nope');
	expect(data).toEqual({ state: 'invalid', email: null });
});
