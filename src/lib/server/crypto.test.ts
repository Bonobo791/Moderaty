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

import { expect, test, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { ENCRYPTION_KEY: 'test-encryption-key' }
}));

import { env } from '$env/dynamic/private';
import { decrypt, encrypt } from './crypto';

test('round trips plaintext through AES-256-GCM encryption', () => {
	const plaintext = 'refresh-token: secret value';
	const payload = encrypt(plaintext);

	expect(payload).not.toBe(plaintext);
	expect(Buffer.from(payload, 'base64').length).toBeGreaterThan(28);
	expect(decrypt(payload)).toBe(plaintext);
});

test('encrypts the same plaintext to a different payload every time', () => {
	// Mutation audit: a fixed IV still round-trips (encrypt and decrypt share
	// it), but AES-GCM nonce reuse destroys confidentiality of every stored
	// YouTube token and enables tag forgery on the consent-pending cookie.
	expect(encrypt('same plaintext')).not.toBe(encrypt('same plaintext'));
});

test('encrypt fails loudly with the exact error when ENCRYPTION_KEY is not configured', () => {
	// Mutation audit: removing the missing-key guard encrypts with an undefined
	// secret instead of failing at the boundary; the exact message is the
	// operable signal in server logs.
	const envRecord = env as Record<string, string | undefined>;
	const original = envRecord.ENCRYPTION_KEY;
	delete envRecord.ENCRYPTION_KEY;
	try {
		expect(() => encrypt('plaintext')).toThrow(/^ENCRYPTION_KEY is required$/);
	} finally {
		envRecord.ENCRYPTION_KEY = original;
	}
});

test('decrypt fails loudly with the exact error when ENCRYPTION_KEY is not configured', () => {
	// Mutation audit: both entry points share the key guard; each must be
	// exercised so a guard removed on one path cannot survive.
	const envRecord = env as Record<string, string | undefined>;
	const original = envRecord.ENCRYPTION_KEY;
	delete envRecord.ENCRYPTION_KEY;
	try {
		const dummyPayload = Buffer.from('x'.repeat(40)).toString('base64');
		expect(() => decrypt(dummyPayload)).toThrow(/^ENCRYPTION_KEY is required$/);
	} finally {
		envRecord.ENCRYPTION_KEY = original;
	}
});

test('derives the encryption key from ENCRYPTION_KEY, so a wrong key cannot decrypt', () => {
	// Mutation audit: substituting a constant key source still round-trips
	// (encrypt and decrypt share key()), hiding key-rotation breakage and a
	// shipped-constant exposure.
	const payload = encrypt('stored refresh token');
	(env as Record<string, string>).ENCRYPTION_KEY = 'rotated-key';
	try {
		expect(() => decrypt(payload)).toThrow();
	} finally {
		(env as Record<string, string>).ENCRYPTION_KEY = 'test-encryption-key';
	}
});
