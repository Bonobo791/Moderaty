/**
 * Shared request shaping for the app's OpenAI chat-completions calls.
 *
 * Reasoning models (o-series, gpt-5*, gpt-6*) reject `temperature` with a
 * 400 — they take `reasoning_effort` instead. `low` keeps these
 * high-volume classification calls cheap while allowing a short reasoning
 * pass; it is also the lowest effort every reasoning family accepts, so
 * env overrides to o-series or gpt-5 models keep working.
 */
const REASONING_MODEL = /^(?:o\d|gpt-[56])/;

export function isReasoningModel(model: string): boolean {
	return REASONING_MODEL.test(model);
}

export function samplingParams(model: string): Record<string, number | string> {
	return isReasoningModel(model) ? { reasoning_effort: 'low' } : { temperature: 0 };
}
