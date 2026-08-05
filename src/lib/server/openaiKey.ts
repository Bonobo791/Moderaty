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
 * @param orgId - The channel's org, or null for a pre-account orphan channel.
 * @returns The effective API key, or undefined when neither source has one —
 * the scorers throw loudly on a missing key and the comment lands in the
 * human review queue (I11).
 */
export async function resolveOpenAiKey(orgId: string | null): Promise<string | undefined> {
	if (!orgId) return env.OPENAI_API_KEY;
	let enc: string | null | undefined;
	try {
		const row = await db
			.select({ openaiKeyEnc: organizations.openaiKeyEnc })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.get();
		enc = row?.openaiKeyEnc;
	} catch (error) {
		// Loud fallback: a mid-run DB hiccup must neither abort the batch nor
		// go unnoticed — degrade to the deployment key and log it.
		console.error('failed to read the stored OpenAI key — falling back to the deployment key', { orgId, error });
		return env.OPENAI_API_KEY;
	}
	if (!enc) return env.OPENAI_API_KEY;
	try {
		return decrypt(enc);
	} catch (error) {
		// Loud fallback: a corrupt stored key must not abort the run, but it
		// must never be silent either.
		console.error('stored OpenAI key failed to decrypt — falling back to the deployment key', { orgId, error });
		return env.OPENAI_API_KEY;
	}
}
