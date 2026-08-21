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

// MailJet Send API v3.1 client — raw REST over fetch, no SDK (the project's
// dependency policy bans third-party SDKs; this mirrors google.ts). Official
// contract (dev.mailjet.com/email/guides/send-api-v31): POST
// https://api.mailjet.com/v3.1/send with HTTP Basic auth
// (MJ_APIKEY_PUBLIC : MJ_APIKEY_PRIVATE) and a JSON body whose `Messages`
// array carries From/To/Subject and at least one of TextPart/HTMLPart.

import { env } from '$env/dynamic/private';

const MAILJET_SEND_URL = 'https://api.mailjet.com/v3.1/send';
const MAILJET_TIMEOUT_MS = 10_000;
const DEFAULT_FROM_NAME = 'Moderaty';

export interface MailjetConfig {
	apiKey: string;
	secretKey: string;
	fromEmail: string;
	fromName: string;
}

/**
 * Reads the MailJet configuration from the environment, failing loudly at
 * handler start (never at import) when a required key is missing.
 *
 * @returns The validated MailJet credentials and sender identity.
 */
export function loadMailjetConfig(): MailjetConfig {
	const apiKey = env.MJ_APIKEY_PUBLIC;
	const secretKey = env.MJ_APIKEY_PRIVATE;
	const fromEmail = env.MAILJET_FROM_EMAIL;
	if (!apiKey) throw new Error('MJ_APIKEY_PUBLIC is not configured');
	if (!secretKey) throw new Error('MJ_APIKEY_PRIVATE is not configured');
	if (!fromEmail) throw new Error('MAILJET_FROM_EMAIL is not configured');
	const fromName = env.MAILJET_FROM_NAME?.trim();
	return { apiKey, secretKey, fromEmail, fromName: fromName || DEFAULT_FROM_NAME };
}

export interface MailjetMessage {
	toEmail: string;
	toName: string;
	subject: string;
	textPart: string;
	htmlPart: string;
}

export interface MailjetSendResult {
	/** Legacy numeric MailJet message ID; null when the response omits it. */
	messageId: number | null;
	/** MailJet message UUID; null when the response omits it. */
	messageUuid: string | null;
}

/**
 * Sends one e-mail through MailJet.
 *
 * Fails loudly on every failure mode — missing env, network error, timeout,
 * non-OK status, unparseable body, or a MailJet-level rejection — with a
 * generic client-safe message while the raw details go to the server log
 * only (AGENTS.md: never surface raw third-party responses to the client).
 *
 * @param message - The recipient, subject, and text/HTML parts.
 * @returns MailJet's message identifiers for audit, when provided.
 */
export async function sendMailjetMessage(message: MailjetMessage): Promise<MailjetSendResult> {
	const config = loadMailjetConfig();
	const payload = {
		Messages: [
			{
				From: { Email: config.fromEmail, Name: config.fromName },
				To: [{ Email: message.toEmail, Name: message.toName }],
				Subject: message.subject,
				TextPart: message.textPart,
				HTMLPart: message.htmlPart
			}
		]
	};
	const credentials = Buffer.from(`${config.apiKey}:${config.secretKey}`).toString('base64');

	let response: Response;
	try {
		response = await fetch(MAILJET_SEND_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Basic ${credentials}`
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(MAILJET_TIMEOUT_MS)
		});
	} catch (error) {
		// fetch throws on DNS/connection failure and on our own timeout.
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error('mailjet send failed (network):', error);
		throw new Error('verification e-mail could not be sent (network failure)');
	}

	const body = await response.text();
	if (!response.ok) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error(`mailjet send failed: HTTP ${response.status} ${body}`);
		throw new Error(`verification e-mail could not be sent (HTTP ${response.status})`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error('mailjet send failed: invalid JSON response');
		throw new Error('verification e-mail could not be sent (invalid MailJet response)');
	}

	// I1: every field of an external response is nullable — validate shape.
	const messages = (parsed as { Messages?: unknown[] } | null)?.Messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error('mailjet send failed: response carried no Messages array');
		throw new Error('verification e-mail could not be sent (MailJet returned no message)');
	}
	const first = messages[0] as { Status?: unknown; To?: unknown[] } | null;
	if (first?.Status !== 'success') {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error('mailjet send rejected:', JSON.stringify(first ?? null));
		throw new Error('verification e-mail could not be sent (MailJet rejected the message)');
	}
	const to = Array.isArray(first.To) && first.To.length > 0 ? (first.To[0] as { MessageID?: unknown; MessageUUID?: unknown }) : {};
	return {
		messageId: typeof to.MessageID === 'number' ? to.MessageID : null,
		messageUuid: typeof to.MessageUUID === 'string' ? to.MessageUUID : null
	};
}
