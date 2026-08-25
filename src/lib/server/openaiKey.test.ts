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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { ENCRYPTION_KEY: 'test-encryption-key', OPENAI_API_KEY: 'env-openai-key' } as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { setupTestDb, testDb } from '$lib/server/testdb';
import { organizations } from '$lib/server/db/schema';
import { encrypt } from '$lib/server/crypto';
import { resolveOpenAiKey } from './openaiKey';

setupTestDb(['organizations']);

afterEach(() => {
	mocks.env.OPENAI_API_KEY = 'env-openai-key';
	vi.restoreAllMocks();
});

async function seedOrg(id: string, openaiKeyEnc: string | null) {
	await testDb().db.insert(organizations).values({ id, name: id, openaiKeyEnc });
}

test('a stored org key beats the env key', async () => {
	await seedOrg('org-1', encrypt('sk-org-key'));
	expect(await resolveOpenAiKey('org-1')).toBe('sk-org-key');
});

test('no stored key falls back to the env key — quietly', async () => {
	await seedOrg('org-2', null);
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await resolveOpenAiKey('org-2')).toBe('env-openai-key');
	// A NULL stored key is the normal default, not an error: no loud log.
	expect(spy).not.toHaveBeenCalled();
});

test('a null org (pre-account channel) uses the env key — without touching the database', async () => {
	const select = vi.spyOn(testDb().db, 'select');
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await resolveOpenAiKey(null)).toBe('env-openai-key');
	// A null org short-circuits to the deployment key before any query.
	expect(select).not.toHaveBeenCalled();
	expect(spy).not.toHaveBeenCalled();
});

test('an unknown org uses the env key — quietly', async () => {
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await resolveOpenAiKey('org-missing')).toBe('env-openai-key');
	// No stored row is a normal state, not an error: no loud log.
	expect(spy).not.toHaveBeenCalled();
});

test('corrupt ciphertext falls back to the env key and logs loudly', async () => {
	await seedOrg('org-3', 'not-valid-ciphertext');
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await resolveOpenAiKey('org-3')).toBe('env-openai-key');
	expect(spy).toHaveBeenCalledWith(
		'stored OpenAI key failed to decrypt — falling back to the deployment key',
		{ orgId: 'org-3', error: expect.any(Error) }
	);
});

test('a database failure falls back to the env key and logs loudly instead of crashing the run', async () => {
	// resolveOpenAiKey must never throw: a mid-run DB hiccup degrades to the
	// deployment key (loudly), not to an aborted moderation batch.
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const dbSpy = vi.spyOn(testDb().db, 'select').mockImplementation(() => {
		throw new Error('database is down');
	});
	try {
		expect(await resolveOpenAiKey('org-1')).toBe('env-openai-key');
		expect(spy).toHaveBeenCalledWith(
			'failed to read the stored OpenAI key — falling back to the deployment key',
			{ orgId: 'org-1', error: expect.any(Error) }
		);
	} finally {
		dbSpy.mockRestore();
	}
});

test('no stored key and no env key resolves to undefined (the scorer throws loudly)', async () => {
	mocks.env.OPENAI_API_KEY = undefined;
	await seedOrg('org-4', null);
	expect(await resolveOpenAiKey('org-4')).toBeUndefined();
});
