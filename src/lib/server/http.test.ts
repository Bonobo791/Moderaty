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

// @ts-nocheck

import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithRetry } from './http.js';

test('retries transient responses but not client errors', async (context) => {
	const originalFetch = globalThis.fetch;
	context.after(() => {
		globalThis.fetch = originalFetch;
	});

	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return calls === 1
			? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
			: new Response('', { status: 200 });
	};
	assert.equal((await fetchWithRetry('https://example.test')).status, 200);
	assert.equal(calls, 2);

	calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return new Response('', { status: 400 });
	};
	assert.equal((await fetchWithRetry('https://example.test')).status, 400);
	assert.equal(calls, 1);
});
