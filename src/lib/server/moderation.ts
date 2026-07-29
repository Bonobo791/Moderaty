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

export interface ModerationResult {
	score: number; // max of the six toxic category scores
	scores: Record<string, number>; // the six category scores
}

/**
 * Scores a comment for toxicity across the supported moderation categories.
 *
 * @param text - The comment text to evaluate
 * @returns The maximum toxicity score and the score for each category
 * @throws If the OpenAI API key is missing, the moderation request fails, or required scores are absent
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
	const data = await res.json();
	if (!res.ok) throw new Error(`moderation failed: ${res.status} ${JSON.stringify(data)}`);
	const cat = data.results?.[0]?.category_scores;
	if (!cat || TOXIC_CATEGORIES.some((category) => !Number.isFinite(cat[category]))) {
		throw new Error('moderation response is missing required category scores');
	}
	const scores: Record<string, number> = {};
	let max = 0;
	for (const k of TOXIC_CATEGORIES) {
		const v = cat[k];
		scores[k] = v;
		if (v > max) max = v;
	}
	return { score: max, scores };
}
