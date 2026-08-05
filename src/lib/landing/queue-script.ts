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

export type RowState = 'incoming' | 'judged' | 'settled';

export type QueueRow = {
	key: number;
	item: QueueItem;
	state: RowState;
};

/** Counters when the loop first appears: the night is already underway. */
export const INITIAL_COUNTS: Counts = { incoming: 39, actioned: 33, yours: 4 };

/** The labeled illustrative night, also the reduced-motion end state. */
export const FINAL_COUNTS: Counts = { incoming: 47, actioned: 41, yours: 6 };

/** [author, text, verdict, reason] — kept as tuples so the data stays scannable. */
const RAW_SCRIPT: [string, string, Verdict, string][] = [
	['dana.plays', 'The pacing in the mid section was your best yet. More of this.', 'APPROVED', 'score 0.04'],
	['CryptoKingdom42', 'I made $8,412 in 3 days thanks to this one method, DM me to...', 'DELETED', 'rule: KEYWORD "crypto"'],
	['UmAckchyually', 'Ackchyually, your point at 4:12 is wrong, and here are 400 words on why...', 'HELD', 'score 0.68, your call'],
	['xX_grassfree_Xx', 'People like you ruin this hobby. It is just dark humor bro, cope...', 'BANNED', 'score 0.97'],
	['bia_souza', 'first!! love from Brazil, this helped me so much', 'APPROVED', 'score 0.02'],
	['sub4sub_andy', 'nice video!! check out my channel, sub4sub anyone?', 'REJECTED', 'rule: REGEX promo pattern'],
	['drama.tourist', 'Coming from the drama video. This take is garbage and so are...', 'HELD', 'score 0.81, spike detected'],
	['regular_tom', 'lol the sponsor segue was actually smooth this time', 'APPROVED', 'score 0.05']
];

export const SCRIPT: QueueItem[] = RAW_SCRIPT.map(([author, text, verdict, reason]) => ({
	author,
	text,
	verdict,
	reason
}));

/** A comment lands in the queue. */
export function applyArrival(counts: Counts): Counts {
	return { ...counts, incoming: counts.incoming + 1 };
}

/**
 * A verdict settles. The tool acts on every comment it judges — approve,
 * delete, ban, reject, hold — so actioned always +1. HELD also lands on the
 * creator's pile, so yours +1 on top. That closes the books on the
 * illustrative night: incoming 47 = actioned 41 + yours 6.
 */
export function applyVerdict(counts: Counts, verdict: Verdict): Counts {
	if (verdict === 'HELD') return { ...counts, actioned: counts.actioned + 1, yours: counts.yours + 1 };
	return { ...counts, actioned: counts.actioned + 1 };
}

/**
 * The completed night, rendered by SSR and no-JS clients so the panel is
 * never empty. The live loop resets to INITIAL_COUNTS and starts over when
 * JS runs with motion allowed.
 */
export function initialQueueState(): { rows: QueueRow[]; counts: Counts } {
	return {
		// Stryker disable next-line UnaryOperator: SCRIPT has exactly 8 entries, so slice(+4) and slice(-4) return the identical tail rows — the mutant is equivalent while the 8-entry script stands.
		rows: SCRIPT.slice(-4).map((item, i) => ({ key: i, item, state: 'settled' })),
		counts: FINAL_COUNTS
	};
}
