/**
 * Shared request shaping for the app's OpenAI chat-completions calls.
 *
 * Reasoning models (o-series, gpt-5*, gpt-6*) reject `temperature` with a
 * 400 — they take `reasoning_effort` instead. `none` keeps these
 * high-volume classification calls on the fast non-reasoning path, the
 * direct analog of `temperature: 0` on the gpt-4.1 family. An env override
 * naming a reasoning model without a `none` effort (e.g. gpt-6.1-sol)
 * fails loudly at the API rather than silently degrading.
 */
const REASONING_MODEL = /^(?:o\d|gpt-[56])/;

export function isReasoningModel(model: string): boolean {
	return REASONING_MODEL.test(model);
}

export function samplingParams(model: string): Record<string, number | string> {
	return isReasoningModel(model) ? { reasoning_effort: 'none' } : { temperature: 0 };
}
