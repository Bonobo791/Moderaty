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

import { expect, test, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { ENCRYPTION_KEY: 'test-encryption-key' }
}));

import { decrypt, encrypt } from './crypto';

test('round trips plaintext through AES-256-GCM encryption', () => {
	const plaintext = 'refresh-token: secret value';
	const payload = encrypt(plaintext);

	expect(payload).not.toBe(plaintext);
	expect(Buffer.from(payload, 'base64').length).toBeGreaterThan(28);
	expect(decrypt(payload)).toBe(plaintext);
});
