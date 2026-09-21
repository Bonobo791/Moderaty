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

async function seedOrg(id: string, openaiKeyEnc: string | null, plan: 'free' | 'hosted' | 'lifetime' = 'free') {
	await testDb().db.insert(organizations).values({ id, name: id, openaiKeyEnc, plan });
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

test('a database failure resolves NO key — the plan is unknown, so the env key may belong to a lifetime org', async () => {
	// resolveOpenAiKey must never throw: a mid-run DB hiccup resolves
	// undefined (loudly), not an aborted moderation batch — the scorers throw
	// and the comments queue for human review (I11). The deployment key is
	// NOT a safe fallback here: the plan is unreadable, so the org could be
	// lifetime, and spending the operator's key for a lifetime run is the
	// exact leak BYOK-required exists to prevent (codeant P1).
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const dbSpy = vi.spyOn(testDb().db, 'select').mockImplementation(() => {
		throw new Error('database is down');
	});
	try {
		expect(await resolveOpenAiKey('org-1')).toBeUndefined();
		expect(spy).toHaveBeenCalledWith(
			'failed to read the stored OpenAI key — plan unknown, so no deployment-key fallback (a lifetime org would burn it)',
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

test('a lifetime org with no stored key gets NOTHING — the deployment key is not theirs to burn', async () => {
	// BYOK is not optional on lifetime: the $49 price cannot fund unbounded
	// operator-side scoring, so a keyless lifetime org resolves undefined —
	// the scorer throws and every comment lands in the review queue (I11)
	// instead of silently spending the deployment's key. Loud, per run.
	await seedOrg('org-lifetime', null, 'lifetime');
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await resolveOpenAiKey('org-lifetime')).toBeUndefined();
	expect(spy).toHaveBeenCalledWith(
		'lifetime org has no stored OpenAI key — scoring cannot run on the deployment key',
		{ orgId: 'org-lifetime' }
	);
});

test('a lifetime org with a CORRUPT stored key gets nothing either — never the env fallback', async () => {
	// An undecryptable key on a metered org degrades to the env key; on
	// lifetime that same fallback would quietly bill the operator for the
	// buyer's usage. Resolve undefined instead — still logged loudly.
	await seedOrg('org-lifetime-corrupt', 'not-valid-ciphertext', 'lifetime');
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await resolveOpenAiKey('org-lifetime-corrupt')).toBeUndefined();
	expect(spy).toHaveBeenCalledWith(
		'stored OpenAI key failed to decrypt — no deployment-key fallback on the lifetime plan',
		{ orgId: 'org-lifetime-corrupt', error: expect.any(Error) }
	);
});

test('a lifetime org WITH a stored key scores on it', async () => {
	await seedOrg('org-lifetime-key', encrypt('sk-lifetime-key'), 'lifetime');
	expect(await resolveOpenAiKey('org-lifetime-key')).toBe('sk-lifetime-key');
});
