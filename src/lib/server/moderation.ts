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

import { env } from '$env/dynamic/private';
import { fetchWithRetry } from '$lib/server/http';

const TOXIC_CATEGORIES = [
	'harassment',
	'harassment/threatening',
	'hate',
	'hate/threatening',
	'violence',
	'violence/graphic'
] as const;

async function jsonResponse(response: Response): Promise<unknown> {
	const body = await response.text();
	if (!response.ok) throw new Error(`moderation failed: ${response.status} ${body}`);
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error('moderation returned invalid JSON');
	}
}

export type ToxicCategory = (typeof TOXIC_CATEGORIES)[number];
export type ToxicityScores = Record<ToxicCategory, number>;

export interface ModerationResult {
	score: number; // max of the six toxic category scores
	scores: ToxicityScores; // the six category scores
}

export function serializeScores(scores: ToxicityScores): string {
	return `{"harassment":${scores.harassment},"harassment/threatening":${scores['harassment/threatening']},"hate":${scores.hate},"hate/threatening":${scores['hate/threatening']},"violence":${scores.violence},"violence/graphic":${scores['violence/graphic']}}`;
}

/**
 * Scores a comment for toxicity across the supported moderation categories.
 *
 * @param text - The comment text to evaluate
 * @returns The maximum toxicity score and the score for each category
 * @throws If the OpenAI API key is missing, the moderation request fails, or required scores are absent or outside [0, 1]
 */
export async function scoreComment(text: string, deadline?: number): Promise<ModerationResult> {
	if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
	const res = await fetchWithRetry('https://api.openai.com/v1/moderations', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ model: 'omni-moderation-latest', input: text })
	}, deadline);
	const response = await jsonResponse(res);
	if (!response || typeof response !== 'object') {
		throw new Error('moderation response is missing required category scores');
	}
	const data = response as { results?: Array<{ category_scores?: Record<string, unknown> }> };
	const cat = data.results?.[0]?.category_scores;
	const invalid = (v: unknown) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1;
	if (!cat || TOXIC_CATEGORIES.some((category) => invalid(cat[category]))) {
		throw new Error('moderation response has missing or out-of-range category scores');
	}
	const scores = {} as ToxicityScores;
	let max = 0;
	for (const k of TOXIC_CATEGORIES) {
		const v = cat[k] as number;
		scores[k] = v;
		if (v > max) max = v;
	}
	return { score: max, scores };
}
