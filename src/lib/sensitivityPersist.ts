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
	// The 502 path's detail IS the generic message — prefixing it again would
	// render the prefix twice (cubic, PR #142).
	const generic = 'Sensitivity could not be saved — try again.';
	return {
		kind: 'reverted',
		selected: serverLevel === TONE_LEVEL_OMNI_AND_TONE ? TONE_LEVEL_OMNI_AND_TONE : TONE_LEVEL_OMNI_ONLY,
		message: !detail
			? generic
			: detail.startsWith('Sensitivity could not be saved')
				? detail
				: `Sensitivity could not be saved — ${detail}`
	};
}
