// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; see LICENSE.

/**
 * The moderation-sensitivity levels a channel supports. Level 1 scores every
 * comment with the omni classifier only; level 2 adds the tone pass, which
 * holds demeaning, condescending, or sarcastic comments for review (never
 * deletes). Validation, the scoring gate, and the UI must all agree on this
 * one representation — a third level cannot silently appear.
 */
export const TONE_LEVEL_OMNI_ONLY = 1;
export const TONE_LEVEL_OMNI_AND_TONE = 2;

export const TONE_LEVELS = [TONE_LEVEL_OMNI_ONLY, TONE_LEVEL_OMNI_AND_TONE] as const;

export type ToneLevel = (typeof TONE_LEVELS)[number];

export function isToneLevel(value: unknown): value is ToneLevel {
	return value === TONE_LEVEL_OMNI_ONLY || value === TONE_LEVEL_OMNI_AND_TONE;
}
