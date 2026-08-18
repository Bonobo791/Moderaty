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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { afterEach, expect, test, vi } from 'vitest';
import { assertBeforeDeadline, DeadlineExceededError, fetchWithRetry } from './http';

afterEach(() => {
	vi.unstubAllGlobals();
	// Restore spies BEFORE swapping real timers back in: a setTimeout spy
	// captured the fake timer as its "original", so restoring after
	// useRealTimers would reinstall the fake one for the next test.
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// Stubs fetch to respond with `first` once, then 200: the request must
// succeed after exactly one retry. Returns the fetch call count.
async function expectSingleRetry(first: Response): Promise<number> {
	let calls = 0;
	vi.stubGlobal('fetch', async () => {
		calls++;
		return calls === 1 ? first : new Response('', { status: 200 });
	});
	expect((await fetchWithRetry('https://example.test')).status).toBe(200);
	return calls;
}

// Stubs fetch to respond with `responses` in order, then 200; runs
// fetchWithRetry under fake timers, advancing `advances` ms per step, and
// returns the delays setTimeout was called with.
async function retryDelays(
	responses: Response[],
	advances: number[],
	setup?: () => void
): Promise<unknown[]> {
	vi.useFakeTimers();
	setup?.();
	const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
	const fetch = vi.fn();
	for (const response of responses) fetch.mockResolvedValueOnce(response);
	fetch.mockResolvedValue(new Response('', { status: 200 }));
	vi.stubGlobal('fetch', fetch);

	const promise = fetchWithRetry('https://example.test');
	for (const ms of advances) await vi.advanceTimersByTimeAsync(ms);
	expect((await promise).status).toBe(200);

	return setTimeoutSpy.mock.calls.map((call) => call[1]);
}

test('retries transient responses but not client errors', async () => {
	expect(
		await expectSingleRetry(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
	).toBe(2);

	let calls = 0;
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

test('honours a caller-provided abort signal instead of overwriting it', async () => {
	// I5: the caller's signal must be composed into the request, not replaced
	// by the timeout signal — and a caller abort must not be retried.
	const controller = new AbortController();
	controller.abort();
	const fetch = vi.fn().mockImplementation((_input: unknown, init?: RequestInit) =>
		init?.signal?.aborted
			? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
			: Promise.resolve(new Response('', { status: 200 }))
	);
	vi.stubGlobal('fetch', fetch);

	await expect(fetchWithRetry('https://example.test', { signal: controller.signal })).rejects.toThrow(
		'aborted'
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});

test('honours Retry-After in seconds', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('fetch', vi.fn()
		.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } }))
		.mockResolvedValue(new Response('', { status: 200 })));

	// Seconds, not milliseconds — treating the header as ms hammers a
	// throttled API a thousand times faster than it asked for.
	const promise = fetchWithRetry('https://example.test');
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(1999);
	expect(settled).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(settled).toBe(true);
	expect((await promise).status).toBe(200);
});

test('retries server errors and network failures', async () => {
	expect(
		await expectSingleRetry(new Response('', { status: 500, headers: { 'Retry-After': '0' } }))
	).toBe(2);

	let calls = 0;
	vi.stubGlobal('fetch', async () => {
		calls++;
		if (calls === 1) throw new TypeError('fetch failed');
		return new Response('', { status: 200 });
	});
	// The deadline bounds the exponential sleep while leaving room for the retry.
	expect((await fetchWithRetry('https://example.test', {}, Date.now() + 1100)).status).toBe(200);
	expect(calls).toBe(2);
});

test('assertBeforeDeadline passes with no deadline or a future one', () => {
	expect(() => assertBeforeDeadline()).not.toThrow();
	expect(() => assertBeforeDeadline(Date.now() + 60_000)).not.toThrow();
});

test('assertBeforeDeadline throws once the deadline is reached', () => {
	expect(() => assertBeforeDeadline(Date.now() - 1)).toThrow(DeadlineExceededError);
	expect(() => assertBeforeDeadline(Date.now() - 1)).toThrow('request deadline exceeded');

	vi.useFakeTimers();
	vi.setSystemTime(1_000);
	// At the exact deadline the request is already too late (>=, not >).
	expect(() => assertBeforeDeadline(1_000)).toThrow(DeadlineExceededError);
});

test('backs off exponentially when a retryable response has no Retry-After header', async () => {
	const delays = await retryDelays(
		[new Response('', { status: 429 }), new Response('', { status: 429 })],
		[1_000, 2_000]
	);

	// 1s then 2s: a missing header must fall back to exponential backoff
	// (doubling per attempt), not to zero delay or a flat 1s.
	expect(delays).toEqual([1_000, 2_000]);
});

test('honours Retry-After as an HTTP date and ignores an unparseable value', async () => {
	const delays = await retryDelays(
		[
			new Response('', {
				status: 429,
				headers: { 'Retry-After': new Date(1_000_000 + 2_000).toUTCString() }
			}),
			new Response('', {
				status: 429,
				headers: { 'Retry-After': 'not-a-date' }
			})
		],
		[2_000, 2_000],
		() => vi.setSystemTime(1_000_000)
	);

	// A valid HTTP date waits until that date; a value that is neither a
	// number nor a parseable date must fall back to exponential backoff
	// (2s for the second attempt), never to a NaN/0 delay.
	expect(delays).toEqual([2_000, 2_000]);
});

test('fails immediately without a retry sleep when an error surfaces at the deadline', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
	const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
	const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
	vi.stubGlobal('fetch', fetch);

	let caught: unknown;
	const promise = fetchWithRetry('https://example.test', {}, 1_000).catch((error: unknown) => {
		caught = error;
	});
	// advanceTimersByTimeAsync(0) drains any zero-delay retry sleeps: if the
	// error were (wrongly) retried instead of failing fast, the loop would
	// burn through its remaining attempts here and `caught` would still be
	// set — but only after scheduling sleeps, which the spy must never see.
	await vi.advanceTimersByTimeAsync(0);
	await promise;

	expect(caught).toBeInstanceOf(DeadlineExceededError);
	expect((caught as Error).message).toBe('request deadline exceeded');
	expect(setTimeoutSpy).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});
