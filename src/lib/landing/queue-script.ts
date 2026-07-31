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

export type Verdict = 'APPROVED' | 'HELD' | 'DELETED' | 'BANNED' | 'REJECTED';

export type QueueItem = {
	author: string;
	text: string;
	verdict: Verdict;
	reason: string;
};

export type Counts = {
	incoming: number;
	actioned: number;
	yours: number;
};

/** Counters when the loop first appears: the night is already underway. */
export const INITIAL_COUNTS: Counts = { incoming: 39, actioned: 33, yours: 4 };

/** The labeled illustrative night, also the reduced-motion end state. */
export const FINAL_COUNTS: Counts = { incoming: 47, actioned: 41, yours: 6 };

export const SCRIPT: QueueItem[] = [
	{
		author: 'dana.plays',
		text: 'The pacing in the mid section was your best yet. More of this.',
		verdict: 'APPROVED',
		reason: 'score 0.04'
	},
	{
		author: 'CryptoKingdom42',
		text: 'I made $8,412 in 3 days thanks to this one method, DM me to...',
		verdict: 'DELETED',
		reason: 'rule: KEYWORD "crypto"'
	},
	{
		author: 'UmAckchyually',
		text: 'Ackchyually, your point at 4:12 is wrong, and here are 400 words on why...',
		verdict: 'HELD',
		reason: 'score 0.68, your call'
	},
	{
		author: 'xX_grassfree_Xx',
		text: 'People like you ruin this hobby. It is just dark humor bro, cope...',
		verdict: 'BANNED',
		reason: 'score 0.97'
	},
	{
		author: 'bia_souza',
		text: 'first!! love from Brazil, this helped me so much',
		verdict: 'APPROVED',
		reason: 'score 0.02'
	},
	{
		author: 'sub4sub_andy',
		text: 'nice video!! check out my channel, sub4sub anyone?',
		verdict: 'REJECTED',
		reason: 'rule: REGEX promo pattern'
	},
	{
		author: 'drama.tourist',
		text: 'Coming from the drama video. This take is garbage and so are...',
		verdict: 'HELD',
		reason: 'score 0.81, spike detected'
	},
	{
		author: 'regular_tom',
		text: 'lol the sponsor segue was actually smooth this time',
		verdict: 'APPROVED',
		reason: 'score 0.05'
	}
];

/** A comment lands in the queue. */
export function applyArrival(counts: Counts): Counts {
	return { ...counts, incoming: counts.incoming + 1 };
}

/** A verdict settles: enforcement actions feed "actioned", doubt feeds "yours". */
export function applyVerdict(counts: Counts, verdict: Verdict): Counts {
	if (verdict === 'HELD') return { ...counts, yours: counts.yours + 1 };
	if (verdict === 'APPROVED') return counts;
	return { ...counts, actioned: counts.actioned + 1 };
}
