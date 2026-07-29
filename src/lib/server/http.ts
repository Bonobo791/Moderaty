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

export function assertBeforeDeadline(deadline?: number) {
	if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineExceededError();
}

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

function retryable(response: Response | undefined): boolean {
	return response === undefined || response.status === 429 || response.status >= 500;
}

export async function fetchWithRetry(
	input: RequestInfo | URL,
	init: RequestInit = {},
	deadline?: number
): Promise<Response> {
	for (let retry = 0; ; retry++) {
		assertBeforeDeadline(deadline);
		const remaining = deadline === undefined ? TIMEOUT_MS : Math.min(TIMEOUT_MS, deadline - Date.now());
		if (remaining <= 0) throw new DeadlineExceededError();
		let response: Response | undefined;
		try {
			response = await fetch(input, { ...init, signal: AbortSignal.timeout(remaining) });
		} catch (error) {
			if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineExceededError();
			if (retry === MAX_RETRIES) throw error;
		}
		if (response && !retryable(response)) return response;
		if (retry === MAX_RETRIES) return response!;
		await new Promise((resolve) => setTimeout(resolve, retryDelay(response, retry)));
	}
}
