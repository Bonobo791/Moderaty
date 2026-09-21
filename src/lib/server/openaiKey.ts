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
 * when one is stored (hosted per-account billing), the deployment's
 * `OPENAI_API_KEY` otherwise (self-host and default hosted path).
 *
 * Lifetime is the exception: BYOK is not optional there — the plan's price
 * cannot fund unbounded operator-side scoring, so a lifetime org without a
 * decryptable stored key resolves `undefined` and the comments queue for
 * human review (I11) instead of silently spending the deployment's key.
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
	} catch (error) {
		// Loud fallback: a mid-run DB hiccup must neither abort the batch nor
		// go unnoticed — degrade to the deployment key and log it. The plan is
		// unreadable here, so the lifetime carve-out cannot apply.
		console.error('failed to read the stored OpenAI key — falling back to the deployment key', { orgId, error });
		return env.OPENAI_API_KEY;
	}
	if (!enc) {
		if (plan === 'lifetime') {
			console.error('lifetime org has no stored OpenAI key — scoring cannot run on the deployment key', { orgId });
			return undefined;
		}
		return env.OPENAI_API_KEY;
	}
	try {
		return decrypt(enc);
	} catch (error) {
		// Loud fallback: a corrupt stored key must not abort the run, but it
		// must never be silent either. On lifetime even the env fallback is
		// off-limits — it would bill the operator for the buyer's usage.
		if (plan === 'lifetime') {
			console.error('stored OpenAI key failed to decrypt — no deployment-key fallback on the lifetime plan', { orgId, error });
			return undefined;
		}
		console.error('stored OpenAI key failed to decrypt — falling back to the deployment key', { orgId, error });
		return env.OPENAI_API_KEY;
	}
}
