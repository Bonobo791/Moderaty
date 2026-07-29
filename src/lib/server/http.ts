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

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

export class DeadlineExceededError extends Error {
	constructor() {
		super('request deadline exceeded');
	}
}

/**
 * Ensures the current time is before the specified deadline.
 *
 * @param deadline - The time limit, expressed as milliseconds since the Unix epoch.
 * @throws DeadlineExceededError if the deadline has been reached or passed.
 */
export function assertBeforeDeadline(deadline?: number) {
	if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineExceededError();
}

/**
 * Determines the delay before the next retry attempt.
 *
 * @param response - The response containing an optional `Retry-After` header
 * @param retry - The zero-based retry attempt number
 * @returns The delay in milliseconds
 */
function retryDelay(response: Response | undefined, retry: number): number {
	const retryAfter = response?.headers.get('retry-after');
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	}
	return Math.min(1_000 * 2 ** retry, 10_000);
}

/**
 * Determines whether an HTTP response or failed request can be retried.
 *
 * @param response - The response to evaluate, or `undefined` when no response was received
 * @returns `true` if no response was received or the status indicates throttling or a server error, `false` otherwise
 */
function retryable(response: Response | undefined): boolean {
	return response === undefined || response.status === 429 || response.status >= 500;
}

function requestTimeout(deadline?: number): number {
	const remaining = deadline === undefined ? TIMEOUT_MS : Math.min(TIMEOUT_MS, deadline - Date.now());
	if (remaining <= 0) throw new DeadlineExceededError();
	return remaining;
}

type FetchAttempt = { response: Response } | { error: unknown };

async function fetchAttempt(input: RequestInfo | URL, init: RequestInit, deadline?: number): Promise<FetchAttempt> {
	try {
		return {
			response: await fetch(input, { ...init, signal: AbortSignal.timeout(requestTimeout(deadline)) })
		};
	} catch (error) {
		if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineExceededError();
		return { error };
	}
}

function boundedRetryDelay(response: Response | undefined, retry: number, deadline?: number): number {
	const delay = retryDelay(response, retry);
	return deadline === undefined ? delay : Math.min(delay, Math.max(0, deadline - Date.now()));
}

/**
 * Fetches a resource with bounded retries and optional deadline enforcement.
 *
 * @param input - The request resource to fetch.
 * @param deadline - An absolute time in milliseconds after which the request fails with `DeadlineExceededError`.
 * @returns The first non-retryable response, or the final response after retries are exhausted.
 * @throws `DeadlineExceededError` when the deadline is reached before or during a request.
 */
export async function fetchWithRetry(
	input: RequestInfo | URL,
	init: RequestInit = {},
	deadline?: number
): Promise<Response> {
	for (let retry = 0; ; retry++) {
		const attempt = await fetchAttempt(input, init, deadline);
		const response = 'response' in attempt ? attempt.response : undefined;
		if (response && !retryable(response)) return response;
		if (retry === MAX_RETRIES) {
			if ('error' in attempt) throw attempt.error;
			return attempt.response;
		}
		await new Promise((resolve) => setTimeout(resolve, boundedRetryDelay(response, retry, deadline)));
	}
}
