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
});

async function seedOrg(id: string, openaiKeyEnc: string | null) {
	await testDb().db.insert(organizations).values({ id, name: id, openaiKeyEnc });
}

test('a stored org key beats the env key', async () => {
	await seedOrg('org-1', encrypt('sk-org-key'));
	expect(await resolveOpenAiKey('org-1')).toBe('sk-org-key');
});

test('no stored key falls back to the env key', async () => {
	await seedOrg('org-2', null);
	expect(await resolveOpenAiKey('org-2')).toBe('env-openai-key');
});

test('a null org (pre-account channel) uses the env key', async () => {
	expect(await resolveOpenAiKey(null)).toBe('env-openai-key');
});

test('an unknown org uses the env key', async () => {
	expect(await resolveOpenAiKey('org-missing')).toBe('env-openai-key');
});

test('corrupt ciphertext falls back to the env key and logs loudly', async () => {
	await seedOrg('org-3', 'not-valid-ciphertext');
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await resolveOpenAiKey('org-3')).toBe('env-openai-key');
	expect(spy).toHaveBeenCalled();
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
		expect(spy).toHaveBeenCalled();
	} finally {
		dbSpy.mockRestore();
	}
});

test('no stored key and no env key resolves to undefined (the scorer throws loudly)', async () => {
	mocks.env.OPENAI_API_KEY = undefined;
	await seedOrg('org-4', null);
	expect(await resolveOpenAiKey('org-4')).toBeUndefined();
});
