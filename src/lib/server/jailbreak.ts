import { env } from '$env/dynamic/private';
import { runGuardrails, type GuardrailLLMContext, type GuardrailResult } from '@openai/guardrails';

import { assertBeforeDeadline, DeadlineExceededError, fetchWithRetry, jsonResponse } from '$lib/server/http';

const CONFIDENCE_THRESHOLD = 0.7;
const CHAT_COMPLETIONS_URL = new URL('/v1/chat/completions', 'https://api.openai.com');

type ChatCompletionsAdapter = {
	chat: {
		completions: {
			create: (params: unknown, init?: RequestInit) => Promise<unknown>;
		};
	};
};

function llmContext(apiKey: string, deadline?: number): GuardrailLLMContext {
	const adapter: ChatCompletionsAdapter = {
		chat: {
			completions: {
				create: async (params, init) => {
					const requestInit: RequestInit = {
						method: 'POST',
						headers: {
							Authorization: `Bearer ${apiKey}`,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify(params),
						...(init?.signal ? { signal: init.signal } : {})
					};
					const response = await fetchWithRetry(CHAT_COMPLETIONS_URL, requestInit, deadline);
					return jsonResponse(response, 'jailbreak detection');
				}
			}
		}
	};
	return { guardrailLlm: adapter as unknown as GuardrailLLMContext['guardrailLlm'] };
}

function validatedVerdict(result: GuardrailResult): { flagged: boolean; confidence: number } {
	const info = result.info;
	if (!info || typeof info !== 'object' || Array.isArray(info) || info.guardrail_name !== 'Jailbreak') {
		throw new Error('Jailbreak guardrail returned invalid result information');
	}
	if (
		typeof result.tripwireTriggered !== 'boolean' ||
		typeof info.flagged !== 'boolean' ||
		typeof info.confidence !== 'number' ||
		!Number.isFinite(info.confidence) ||
		info.confidence < 0 ||
		info.confidence > 1
	) {
		throw new Error('Jailbreak guardrail returned invalid flag or confidence');
	}
	if (result.tripwireTriggered !== (info.flagged && info.confidence >= CONFIDENCE_THRESHOLD)) {
		throw new Error('Jailbreak guardrail returned an inconsistent tripwire status');
	}
	return {
		flagged: info.flagged === true && info.confidence >= CONFIDENCE_THRESHOLD,
		confidence: info.confidence
	};
}

function validateResults(results: GuardrailResult[]): { flagged: boolean; confidence: number } {
	if (!Array.isArray(results) || results.length !== 1) throw new Error('Jailbreak guardrail returned an invalid result count');
	const result = results[0];
	if (!result || typeof result !== 'object' || result.executionFailed === true) {
		throw new Error('Jailbreak guardrail execution failed');
	}
	return validatedVerdict(result);
}

export async function detectJailbreak(
	text: string,
	apiKey: string,
	deadline?: number
): Promise<{ flagged: boolean; confidence: number }> {
	if (!apiKey) throw new Error('OPENAI_API_KEY is required');
	assertBeforeDeadline(deadline);

	let results: GuardrailResult[];
	try {
		results = await runGuardrails(
			text,
			{
				guardrails: [{
					name: 'Jailbreak',
					config: {
						model: env.OPENAI_JAILBREAK_MODEL ?? 'gpt-4.1-mini',
						confidence_threshold: CONFIDENCE_THRESHOLD,
						include_reasoning: false
					}
				}]
			},
			llmContext(apiKey, deadline),
			true
		);
	} catch (error) {
		if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineExceededError();
		throw error;
	}
	assertBeforeDeadline(deadline);
	return validateResults(results);
}
