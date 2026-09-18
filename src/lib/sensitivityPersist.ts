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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { TONE_LEVEL_OMNI_AND_TONE, TONE_LEVEL_OMNI_ONLY, type ToneLevel } from '$lib/toneLevels';

/** What a finished setToneLevel submit means for the control's state. */
export type PersistOutcome =
	| { kind: 'applied' }
	| { kind: 'reverted'; selected: ToneLevel; message: string };

/**
 * Maps an enhance result to the switch's visible outcome (MOD-10): success
 * shows `Applied`; anything else reverts the knob to the persisted server
 * level AND produces visible copy — a failed save can never look like a
 * successful one. `serverLevel` is the last value the load serialized, so
 * the reverted control always reflects what the database actually holds.
 */
export function persistOutcome(
	result: { type: string; data?: { error?: unknown } },
	serverLevel: number
): PersistOutcome {
	if (result.type === 'success') return { kind: 'applied' };
	const detail = typeof result.data?.error === 'string' ? result.data.error : null;
	return {
		kind: 'reverted',
		selected: serverLevel === TONE_LEVEL_OMNI_AND_TONE ? TONE_LEVEL_OMNI_AND_TONE : TONE_LEVEL_OMNI_ONLY,
		message: detail
			? `Sensitivity could not be saved — ${detail}`
			: 'Sensitivity could not be saved — try again.'
	};
}
