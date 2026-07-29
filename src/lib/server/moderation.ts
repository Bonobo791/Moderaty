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

export async function scoreComment(text: string): Promise<ModerationResult> {
	const res = await fetch('https://api.openai.com/v1/moderations', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ model: 'omni-moderation-latest', input: text })
	});
	const data = await res.json();
	if (!res.ok) throw new Error(`moderation failed: ${res.status} ${JSON.stringify(data)}`);
	const cat = data.results?.[0]?.category_scores ?? {};
	const scores: Record<string, number> = {};
	let max = 0;
	for (const k of TOXIC_CATEGORIES) {
		const v = typeof cat[k] === 'number' ? cat[k] : 0;
		scores[k] = v;
		if (v > max) max = v;
	}
	return { score: max, scores };
}
