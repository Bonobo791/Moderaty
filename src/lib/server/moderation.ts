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

import { env } from '$env/dynamic/private';
import { fetchWithRetry, jsonResponse } from '$lib/server/http';

const MODERATION_CATEGORIES = [
	'harassment',
	'harassment/threatening',
	'hate',
	'hate/threatening',
	'illicit',
	'illicit/violent',
	'self-harm',
	'self-harm/intent',
	'self-harm/instructions',
	'sexual',
	'sexual/minors',
	'violence',
	'violence/graphic'
] as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];
export type ToxicityScores = Record<ModerationCategory, number>;

export interface ModerationResult {
	score: number; // max across all moderation category scores
	scores: ToxicityScores; // every category score
}

export function serializeScores(scores: ToxicityScores): string {
	return JSON.stringify(scores);
}

/**
 * Scores a comment for toxicity across the supported moderation categories.
 *
 * @param text - The comment text to evaluate
 * @param deadline - Optional abort deadline for the request.
 * @param apiKey - The OpenAI key to bill (org BYOK key when the pipeline
 * resolved one); defaults to the deployment's `OPENAI_API_KEY`.
 * @returns The maximum toxicity score and the score for each category
 * @throws If the OpenAI API key is missing, the moderation request fails, or required scores are absent or outside [0, 1]
 */
export async function scoreComment(
	text: string,
	deadline?: number,
	apiKey: string | undefined = env.OPENAI_API_KEY
): Promise<ModerationResult> {
	if (!apiKey) throw new Error('OPENAI_API_KEY is required');
	const res = await fetchWithRetry('https://api.openai.com/v1/moderations', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ model: 'omni-moderation-latest', input: text })
	}, deadline);
	const response = await jsonResponse(res, 'moderation');
	if (!response || typeof response !== 'object') {
		throw new Error('moderation response is missing required category scores');
	}
	const data = response as { results?: Array<{ category_scores?: Record<string, unknown> }> };
	const cat = data.results?.[0]?.category_scores;
	const invalid = (v: unknown) => {
		// Stryker disable next-line LogicalOperator, ConditionalExpression: the &&-variant, typeof→false and isFinite→false are equivalent — for every non-number Number.isFinite(v) is false so the legs agree, and JSON.parse can only produce ±Infinity, which the range check below rejects (the killable typeof→true variant shares the line; directives are line-granular and the valid-score tests pin that behavior)
		if (typeof v !== 'number' || !Number.isFinite(v)) return true;
		return v < 0 || v > 1;
	};
	if (!cat || MODERATION_CATEGORIES.some((category) => invalid(cat[category]))) {
		throw new Error('moderation response has missing or out-of-range category scores');
	}
	const scores = {} as ToxicityScores;
	let max = 0;
	for (const k of MODERATION_CATEGORIES) {
		const v = cat[k] as number;
		scores[k] = v;
		// Stryker disable next-line EqualityOperator: assigning max = v when v === max is a numeric no-op, so > and >= are indistinguishable
		if (v > max) max = v;
	}
	return { score: max, scores };
}
