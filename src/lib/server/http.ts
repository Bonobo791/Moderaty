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

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

export class DeadlineExceededError extends Error {
	constructor() {
		super('request deadline exceeded');
	}
}

/**
 * Reads a response body as JSON, failing loudly on transport or parse errors.
 *
 * @param response - The HTTP response to read.
 * @param label - The operation name used in error messages (e.g. 'moderation').
 * @returns The parsed JSON body.
 * @throws If the response status is not OK or the body is not valid JSON.
 */
export async function jsonResponse(response: Response, label: string): Promise<unknown> {
	const body = await response.text();
	if (!response.ok) throw new Error(`${label} failed: ${response.status} ${body}`);
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
}

/**
 * Ensures the current time is before the specified deadline.
 *
 * @param deadline - The time limit, expressed as milliseconds since the Unix epoch.
 * @throws DeadlineExceededError if the deadline has been reached or passed.
 */
export function assertBeforeDeadline(deadline?: number) {
	if (
		// Stryker disable next-line ConditionalExpression: `deadline !== undefined` -> `true` is equivalent — `Date.now() >= undefined` is always false, so the && result is unchanged; the directive also sweeps the killable whole-condition siblings that start on the same line
		deadline !== undefined &&
		Date.now() >= deadline
	) throw new DeadlineExceededError();
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
	return (
		// Stryker disable next-line ConditionalExpression: the only call site (fetchWithRetry) guards with `response &&` before invoking retryable, so `response === undefined` can never be observed here; the directive also sweeps the killable whole-chain and sub-chain siblings that start on the same line
		response === undefined ||
		response.status === 429 ||
		response.status >= 500
	);
}

function requestTimeout(deadline?: number): number {
	const remaining = deadline === undefined ? TIMEOUT_MS : Math.min(TIMEOUT_MS, deadline - Date.now());
	if (remaining <= 0) throw new DeadlineExceededError();
	return remaining;
}

type FetchAttempt = { response: Response } | { error: unknown };

async function fetchAttempt(input: RequestInfo | URL, init: RequestInit, deadline?: number): Promise<FetchAttempt> {
	try {
		const timeout = AbortSignal.timeout(requestTimeout(deadline));
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		return { response: await fetch(input, { ...init, signal }) };
	} catch (error) {
		if (init.signal?.aborted) throw error;
		if (
			// Stryker disable next-line ConditionalExpression: `deadline !== undefined` -> `true` is equivalent — `Date.now() >= undefined` is always false, so the && result is unchanged; the directive also sweeps the killable whole-condition siblings that start on the same line
			deadline !== undefined &&
			Date.now() >= deadline
		) throw new DeadlineExceededError();
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
