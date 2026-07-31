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
import { fetchWithRetry, jsonResponse } from '$lib/server/http';

export interface ToneContext {
	videoTitle: string;
	videoDescription: string;
}

export interface ToneResult {
	score: number; // 0 = respectful, 1 = genuine harm without verbal abuse
}

// The calibrated rubric is part of the prompt contract: over-scoring drives
// real-world bans, so the model must stay conservative and treat 0.95+ as
// rare — genuine attempts to harm (targeted harassment, dogpiling,
// manipulation) expressed WITHOUT verbal abuse. Verbal abuse itself is the
// omni-moderation signal's job, not this one.
const TONE_PROMPT = `You score the tone of YouTube comments for a channel owner.
Given the video's title and description for context, score how demeaning,
condescending, or sarcastically mocking ONE comment is toward the creator or
other commenters. Respond with JSON only: {"score": <number from 0 to 1>}.

Use this exact calibrated scale:
- 0.00-0.50 Acceptable: genuine or respectful disagreement, criticism of ideas,
  earnest questions. Most comments land here.
- 0.51-0.75 Borderline: mildly condescending or passive-aggressive; snark
  without clear malice.
- 0.76-0.94 Clearly demeaning: mockery, belittling, or contempt aimed at a
  person. Requires clear evidence in the text.
- 0.95-1.00 Reserved and rare: the author is genuinely attempting to cause
  harm WITHOUT verbal abuse — targeted harassment, dogpiling or brigading,
  manipulation or humiliation campaigns. Almost never used; when unsure,
  score lower.

Stay conservative: over-scoring leads to real bans on real people. Scores
above 0.75 need concrete textual evidence, and 0.95 or above should almost
never be used.`;

/**
 * Scores a comment's tone (demeaning / condescending / sarcastic) with video context.
 *
 * @param text - The comment text to evaluate.
 * @param context - The video's title and (truncated) description.
 * @returns The calibrated tone score.
 * @throws If the OpenAI API key is missing, the request fails, or the score is absent or outside [0, 1].
 */
export async function scoreTone(text: string, context: ToneContext, deadline?: number): Promise<ToneResult> {
	if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
	const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: env.OPENAI_TONE_MODEL ?? 'gpt-4.1-nano',
			temperature: 0,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: TONE_PROMPT },
				{
					role: 'user',
					content: `Video title: ${context.videoTitle}\nVideo description: ${context.videoDescription}\n\nComment: ${text}`
				}
			]
		})
	}, deadline);
	const response = await jsonResponse(res, 'tone');
	const content = (
		response as { choices?: Array<{ message?: { content?: unknown } }> }
	).choices?.[0]?.message?.content;
	let score: unknown;
	try {
		score = (JSON.parse(typeof content === 'string' ? content : '') as { score?: unknown }).score;
	} catch {
		score = undefined;
	}
	if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
		throw new Error('tone response has missing or out-of-range score');
	}
	return { score };
}
