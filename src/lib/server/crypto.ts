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

function key(): Buffer {
	return createHash('sha256').update(env.ENCRYPTION_KEY ?? 'insecure-dev-key').digest();
}

export function encrypt(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(payload: string): string {
	const buf = Buffer.from(payload, 'base64');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(12, 28);
	const enc = buf.subarray(28);
	const decipher = createDecipheriv('aes-256-gcm', key(), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
