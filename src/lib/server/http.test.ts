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
import { fetchWithRetry } from './http';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test('retries transient responses but not client errors', async () => {

	let calls = 0;
	vi.stubGlobal('fetch', async () => {
		calls++;
		return calls === 1
			? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
			: new Response('', { status: 200 });
	});
	expect((await fetchWithRetry('https://example.test')).status).toBe(200);
	expect(calls).toBe(2);

	calls = 0;
	vi.stubGlobal('fetch', async () => {
		calls++;
		return new Response('', { status: 400 });
	});
	expect((await fetchWithRetry('https://example.test')).status).toBe(400);
	expect(calls).toBe(1);
});

test('caps retry sleeps at the remaining deadline', async () => {
	vi.useFakeTimers();
	const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {
		status: 429,
		headers: { 'Retry-After': '60' }
	})));

	void fetchWithRetry('https://example.test', {}, Date.now() + 10).catch(() => undefined);
	await vi.advanceTimersByTimeAsync(0);

	expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 10);
});

test('fails before fetching when the deadline has passed', async () => {
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);

	await expect(fetchWithRetry('https://example.test', {}, Date.now())).rejects.toThrow(
		'request deadline exceeded'
	);
	expect(fetch).not.toHaveBeenCalled();
});
