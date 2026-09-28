import { eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { organizations } from '$lib/server/db/schema';
import { getCredits } from '$lib/server/billing/ledger';
import { resolveOpenAiKey } from '$lib/server/openaiKey';

/**
 * History analysis runs real provider/API work at channel scale, so both
 * entry points (moderation history, feedback history) share one access gate:
 * a lifetime org needs a usable organization OpenAI key, every other org
 * needs a positive credit balance (purchased credits or a live subscription
 * allowance). Read failures throw — the caller turns them into a loud 503.
 */
export async function historyAccessError(orgId: string): Promise<'purchase' | 'key' | null> {
	const org = await db.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, orgId)).get();
	if (!org) throw new Error(`organization not found: ${orgId}`);
	if (org.plan === 'lifetime') {
		return (await resolveOpenAiKey(orgId, { throwOnReadError: true }))?.trim() ? null : 'key';
	}
	return (await getCredits(orgId)) > 0 ? null : 'purchase';
}
