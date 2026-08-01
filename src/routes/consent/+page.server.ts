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
	clearPendingConsent,
	readPendingConsent
} from '$lib/server/legal';
import { cookieSecure } from '$lib/server/oauthState';
import { createSession, SESSION_COOKIE } from '$lib/server/session';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies }) => {
	const pending = readPendingConsent(cookies);
	// No parked identity — nothing to consent to; restart the sign-in flow.
	if (!pending) throw redirect(302, '/login');
	return {
		kind: pending.kind,
		displayName: pending.kind === 'new' ? pending.displayName : null,
		marketingText: MARKETING_CHECKBOX_TEXT
	};
};

export const actions: Actions = {
	default: async ({ cookies, request, getClientAddress }) => {
		const pending = readPendingConsent(cookies);
		if (!pending) return fail(400, { error: 'Your sign-in session expired — please sign in again.' });

		const form = await request.formData();
		if (form.get('consent') !== 'on') {
			return fail(400, {
				error: 'You must confirm you are at least 18 and agree to the Terms of Service, Privacy Policy, and Data Processing Agreement to continue.'
			});
		}
		// Marketing is a separate, unbundled opt-in (LGPD) — unticked means no.
		const marketingOptIn = form.get('marketing') === 'on' ? 1 : 0;

		let userId: string;
		if (pending.kind === 'new') {
			// The account is created ONLY now that the contract has formed. The
			// orphan claim is one-time initialization — only the FIRST user ever
			// (users holding exactly this one row after the insert) takes the
			// pre-accounts ownerless channels. The count is part of the UPDATE
			// itself, so a concurrent first sign-up whose transaction is
			// serialized after this one sees count=2 and claims nothing. The
			// conflict-tolerant insert + re-select absorbs a concurrent
			// same-sub sign-up.
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
				await tx
					.update(channels)
					.set({ userId: user.id })
					.where(and(isNull(channels.userId), sql`(select count(*) from ${users}) = 1`));
				await tx.insert(consents).values({
					userId: user.id,
					docVersion: LEGAL_VERSION,
					checkboxText: CONSENT_CHECKBOX_TEXT,
					ip: getClientAddress(),
					userAgent: request.headers.get('user-agent') ?? '',
					marketingOptIn
				});
				return user;
			});
			userId = created.id;
		} else {
			const user = await db.select({ id: users.id }).from(users).where(eq(users.id, pending.userId)).get();
			if (!user) return fail(400, { error: 'Your sign-in session expired — please sign in again.' });
			await db.insert(consents).values({
				userId: user.id,
				docVersion: LEGAL_VERSION,
				checkboxText: CONSENT_CHECKBOX_TEXT,
				ip: getClientAddress(),
				userAgent: request.headers.get('user-agent') ?? '',
				marketingOptIn
			});
			userId = user.id;
		}

		const { token, expiresAt } = await createSession(userId);
		cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: cookieSecure(),
			expires: new Date(expiresAt)
		});
		clearPendingConsent(cookies);
		throw redirect(302, '/dashboard');
	}
};
