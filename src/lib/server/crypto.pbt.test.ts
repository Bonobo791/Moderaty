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

import fc from 'fast-check';
import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { ENCRYPTION_KEY: 'pbt-encryption-key' } as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { decrypt, encrypt } from './crypto';
// Side-effect import: configures fast-check numRuns globally (FC_NUM_RUNS).
import './testarbitraries';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Runs `run` with ENCRYPTION_KEY set to `key`, restoring the previous value afterwards. */
function withKey<T>(key: string, run: () => T): T {
	const original = mocks.env.ENCRYPTION_KEY;
	mocks.env.ENCRYPTION_KEY = key;
	try {
		return run();
	} finally {
		mocks.env.ENCRYPTION_KEY = original;
	}
}

test('round-trip: decrypt(encrypt(x)) === x for arbitrary plaintexts', () => {
	// Property audit: mutating the iv/tag/ciphertext slicing in decrypt (or
	// dropping the utf8 encoding) breaks the round-trip for some generated
	// string (multibyte/NUL), flipping this red.
	fc.assert(
		fc.property(fc.string(), (plaintext) => {
			expect(decrypt(encrypt(plaintext))).toBe(plaintext);
		})
	);
});

test('tamper: a single altered base64 character anywhere in iv|tag|ciphertext makes decrypt throw', () => {
	// Property audit: if decrypt ignored the GCM tag (no setAuthTag / no
	// final()), a tampered ciphertext would decode to garbage without throwing
	// — this property goes red.
	fc.assert(
		fc.property(
			fc.string(),
			fc.nat(),
			fc.integer({ min: 1, max: BASE64_ALPHABET.length - 1 }),
			(plaintext, indexSeed, charShift) => {
				const payload = encrypt(plaintext);
				// Exclude the last three characters: the final base64 quantum is
				// four chars wide, and its padding bits live in the trailing
				// char(s) — a replacement differing only in those bits decodes
				// to the same bytes (burn-in counterexample: "", index len-3,
				// charShift 1 — a "XX=="-padded payload). Characters at indices
				// 0..len-4 are fully data: any alphabet change flips decoded
				// iv|tag|ciphertext bytes, and '=' never appears there.
				const index = indexSeed % (payload.length - 3);
				const originalChar = payload[index];
				// Different character by construction: shift the alphabet position.
				const replacement =
					BASE64_ALPHABET[(BASE64_ALPHABET.indexOf(originalChar) + charShift) % BASE64_ALPHABET.length];
				const tampered = payload.slice(0, index) + replacement + payload.slice(index + 1);
				expect(() => decrypt(tampered)).toThrow();
			}
		),
		// Burn-in counterexample (seed -1965533364): the empty plaintext pads its
		// 28-byte payload as "XX==", and indexSeed lands the tamper on a char with
		// padding bits — pinned so the quantum-boundary mapping stays honest.
		{ examples: [['', 74357335, 1]] }
	);
});

test('wrong key: a payload decrypts under its own key and throws under any other key', () => {
	// Property audit: a constant key source (key not derived from
	// ENCRYPTION_KEY) still round-trips under k1 but never throws under k2 —
	// this property goes red, catching key-rotation breakage.
	fc.assert(
		fc.property(
			fc.string(),
			fc.string({ minLength: 1 }),
			fc.string({ minLength: 1 }),
			(plaintext, k1, k2) => {
				fc.pre(k1 !== k2); // key pair must be distinct; no other rejection
				const payload = withKey(k1, () => encrypt(plaintext));
				expect(withKey(k1, () => decrypt(payload))).toBe(plaintext);
				expect(() => withKey(k2, () => decrypt(payload))).toThrow();
			}
		)
	);
});
