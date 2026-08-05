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
