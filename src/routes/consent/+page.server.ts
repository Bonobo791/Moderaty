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

import { error, fail, redirect } from '@sveltejs/kit';

import { randomBytes } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { channels, consents, users } from '$lib/server/db/schema';
import {
	CONSENT_CHECKBOX_TEXT,
	LEGAL_VERSION,
	MARKETING_CHECKBOX_TEXT,
	REFUND_NOTICE_TEXT,
	clearPendingConsent,
	readPendingConsent
} from '$lib/server/legal';
import { cookieSecure } from '$lib/server/oauthState';
import { ensurePersonalOrg } from '$lib/server/org';
import { createSession, SESSION_COOKIE } from '$lib/server/session';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies, url }) => {
	const state = url.searchParams.get('state');
	const pending = state ? readPendingConsent(cookies, state) : null;
	// No parked identity for this flow — nothing to consent to; restart sign-in.
	if (!pending) throw redirect(302, '/login');
	return {
		kind: pending.kind,
		displayName: pending.kind === 'new' ? pending.displayName : null,
		consentText: CONSENT_CHECKBOX_TEXT,
		marketingText: MARKETING_CHECKBOX_TEXT,
		refundText: REFUND_NOTICE_TEXT
	};
};

export const actions: Actions = {
	default: async ({ cookies, request, url, getClientAddress }) => {
		const state = url.searchParams.get('state');
		const pending = state ? readPendingConsent(cookies, state) : null;
		if (!pending) return fail(400, { error: 'Your sign-in session expired — please sign in again.' });

		const form = await request.formData();
		if (form.get('consent') !== 'on') {
			return fail(400, {
				error: 'You must confirm you are at least 18 and agree to the Terms of Service, Privacy Policy, and Data Processing Agreement to continue.'
			});
		}
		// Marketing is a separate, unbundled opt-in (LGPD) — unticked means no.
		const marketingOptIn = form.get('marketing') === 'on' ? 1 : 0;

		// One builder for the evidentiary row so the new-account and
		// re-acceptance paths cannot drift apart. The e-mail is recorded here
		// because it is part of the retention evidence: on account deletion the
		// users row is fully anonymized and the e-mail survives ONLY in this
		// log (LGPD Art. 16, III — blocked from any other use, erased after 10
		// years by the cron sweep).
		const consentRecord = (userId: string, email: string) => ({
			userId,
			email,
			docVersion: LEGAL_VERSION,
			checkboxText: CONSENT_CHECKBOX_TEXT,
			ip: getClientAddress(),
			userAgent: request.headers.get('user-agent') ?? '',
			marketingOptIn
		});

		let userId: string;
		let session: { token: string; expiresAt: string };
		if (pending.kind === 'new') {
			// The account is created ONLY now that the contract has formed. The
			// orphan claim is one-time initialization — only the FIRST user ever
			// (users holding exactly this one row after the insert) takes the
			// pre-accounts ownerless channels. The count is part of the UPDATE
			// itself, so a concurrent first sign-up whose transaction is
			// serialized after this one sees count=2 and claims nothing. The
			// conflict-tolerant insert + re-select absorbs a concurrent
			// same-sub sign-up; ensurePersonalOrg makes that race idempotent
			// too. Every user needs a personal org — session resolution fails
			// loudly on zero memberships. User, personal org, consent record,
			// and first session commit as ONE unit — a session-write failure
			// rolls everything back and the parked cookie lets the same
			// submission retry cleanly.
			const created = await db.transaction(async (tx) => {
				await tx
					.insert(users)
					.values({
						id: randomBytes(16).toString('hex'),
						googleSub: pending.sub,
						email: pending.email,
						displayName: pending.displayName
					})
					.onConflictDoNothing();
				const user = await tx.select().from(users).where(eq(users.googleSub, pending.sub)).get();
				if (!user) throw error(500, 'account creation failed — please retry');
				const orgId = await ensurePersonalOrg(tx, user);
				// Orphan claim (first user ever): channels land in their personal org.
				await tx
					.update(channels)
					.set({ userId: user.id, orgId })
					.where(and(isNull(channels.userId), sql`(select count(*) from ${users}) = 1`));
				await tx.insert(consents).values(consentRecord(user.id, pending.email));
				return { user, session: await createSession(user.id, tx, orgId) };
			});
			userId = created.user.id;
			session = created.session;
		} else {
			const user = await db
				.select({ id: users.id, email: users.email })
				.from(users)
				.where(eq(users.id, pending.userId))
				.get();
			if (!user) return fail(400, { error: 'Your sign-in session expired — please sign in again.' });
			session = await db.transaction(async (tx) => {
				await tx.insert(consents).values(consentRecord(user.id, user.email));
				return createSession(user.id, tx);
			});
			userId = user.id;
		}

		const { token, expiresAt } = session;
		cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: cookieSecure(),
			expires: new Date(expiresAt)
		});
		clearPendingConsent(cookies, state as string);
		throw redirect(302, '/dashboard');
	}
};
