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

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * Derives a 32-byte encryption key from the configured encryption secret.
 *
 * @returns The SHA-256 digest of `ENCRYPTION_KEY`.
 * @throws Error If `ENCRYPTION_KEY` is not configured.
 */
function key(): Buffer {
	if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required');
	return createHash('sha256').update(env.ENCRYPTION_KEY).digest();
}

/**
 * Encrypts plaintext using AES-256-GCM.
 *
 * @param plaintext - The UTF-8 string to encrypt
 * @returns A base64-encoded payload containing the initialization vector, authentication tag, and ciphertext
 */
export function encrypt(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	// Stryker disable next-line StringLiteral: Node treats a falsy inputEncoding as the default (utf8) for string data, so '' is byte-identical to 'utf8' (verified: multibyte string produces the utf8 byte length).
	const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Decrypts a Base64-encoded AES-256-GCM payload.
 *
 * @param payload - The Base64-encoded initialization vector, authentication tag, and ciphertext.
 * @returns The decrypted UTF-8 plaintext.
 */
export function decrypt(payload: string): string {
	const buf = Buffer.from(payload, 'base64');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(12, 28);
	const enc = buf.subarray(28);
	// Stryker disable next-line ObjectLiteral: aes-256-gcm's default authTagLength is 16, so {} is identical to { authTagLength: 16 } (verified: decrypt succeeds with {} and a 16-byte tag).
	const decipher = createDecipheriv('aes-256-gcm', key(), iv, { authTagLength: 16 });
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
