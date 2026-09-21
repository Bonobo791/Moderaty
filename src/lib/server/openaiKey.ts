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

import { env } from '$env/dynamic/private';
import { eq } from 'drizzle-orm';

import { decrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { organizations } from '$lib/server/db/schema';

/**
 * Resolves the OpenAI key a channel run scores with: the org's own BYOK key
 * when one is stored AND the plan is lifetime, the deployment's
 * `OPENAI_API_KEY` otherwise (self-host and metered hosted path).
 *
 * Lifetime is the exception in both directions: BYOK is required there —
 * the plan's price cannot fund unbounded operator-side scoring, so a
 * lifetime org without a decryptable stored key resolves `undefined` and
 * the comments queue for human review (I11) instead of silently spending
 * the deployment's key. In reverse, a key stored while eligible keeps
 * sitting in the table after the plan ends (refund, dispute); scoring must
 * not keep billing the ex-lifetime customer's OpenAI account, so
 * non-lifetime plans ignore the stored key entirely (codex P1). The Team
 * page still offers removal — stored is not used, used is never invisible.
 *
 * @param orgId - The channel's org, or null for a pre-account orphan channel.
 * @returns The effective API key, or undefined when neither source has one —
 * the scorers throw loudly on a missing key and the comment lands in the
 * human review queue (I11).
 */
export async function resolveOpenAiKey(orgId: string | null): Promise<string | undefined> {
	if (!orgId) return env.OPENAI_API_KEY;
	let enc: string | null | undefined;
	let plan: string | undefined;
	try {
		const row = await db
			.select({ openaiKeyEnc: organizations.openaiKeyEnc, plan: organizations.plan })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.get();
		enc = row?.openaiKeyEnc;
		plan = row?.plan;
		// A missing row is an integrity violation, not a normal state — the
		// plan is unreadable, so fail closed exactly like a failed read: the
		// org could be lifetime and the deployment key is not theirs to burn.
		if (!row) {
			console.error('organization not found — plan unknown, so no deployment-key fallback (a lifetime org would burn it)', { orgId });
			return undefined;
		}
	} catch (error) {
		// Loud, and NO fallback: a mid-run DB hiccup must neither abort the
		// batch nor go unnoticed — resolve nothing and let the scorer defer
		// the comments to the review queue (I11). The plan is unreadable, so
		// the org could be lifetime — returning the deployment key here would
		// spend operator money the Terms promise never to spend (codeant P1).
		console.error('failed to read the stored OpenAI key — plan unknown, so no deployment-key fallback (a lifetime org would burn it)', { orgId, error });
		return undefined;
	}
	if (!enc) {
		if (plan === 'lifetime') {
			console.error('lifetime org has no stored OpenAI key — scoring cannot run on the deployment key', { orgId });
			return undefined;
		}
		return env.OPENAI_API_KEY;
	}
	if (plan !== 'lifetime') {
		// The set action is plan-gated, but a key can outlive the plan
		// (lifetime refund/dispute downgrades the org without clearing the
		// ciphertext). A metered org must score on the deployment key —
		// using the stored one bills a customer who no longer bought BYOK.
		console.error('stored OpenAI key ignored — BYOK keys serve only the lifetime plan', { orgId });
		return env.OPENAI_API_KEY;
	}
	try {
		return decrypt(enc);
	} catch (error) {
		// Only a lifetime org reaches this point — a corrupt stored key
		// resolves nothing rather than spending the deployment key.
		console.error('stored OpenAI key failed to decrypt — no deployment-key fallback on the lifetime plan', { orgId, error });
		return undefined;
	}
}
