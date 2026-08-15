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

// Usage tab: the org's credit balance, consumption, purchase history, bundle
// purchases (owner-only) and auto top-up settings. All money movements land
// in credit_transactions; the page just reads the same ledger the pipeline
// consumes — so a top-up (manual or auto) always moves the counter.

import { fail, isHttpError, isRedirect, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';

import { AUTO_TOPUP_DEFAULT_THRESHOLD } from '$lib/server/billing/autotopup';
import { createCreditCheckout } from '$lib/server/billing/checkout';
import { listCreditTransactions, usageSummary } from '$lib/server/billing/ledger';
import { db } from '$lib/server/db';
import { organizations } from '$lib/server/db/schema';
import { AUTO_TOPUP_CONSENT_TEXT } from '$lib/server/legal';
import { configuredBundles } from '$lib/server/stripe/bundles';
import { requireOrgRole } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.dbDown) {
		return {
			maintenance: true,
			user: null,
			summary: null,
			history: [],
			bundles: [],
			autoTopup: null,
			autoTopupConsentText: AUTO_TOPUP_CONSENT_TEXT
		};
	}
	const user = requireUser(locals);
	const [summary, history, org] = await Promise.all([
		usageSummary(user.orgId),
		listCreditTransactions(user.orgId, 30),
		db
			.select({
				autoTopupEnabled: organizations.autoTopupEnabled,
				autoTopupThreshold: organizations.autoTopupThreshold,
				autoTopupState: organizations.autoTopupState,
				autoTopupFailures: organizations.autoTopupFailures,
				autoTopupLastAttemptAt: organizations.autoTopupLastAttemptAt,
				stripeDefaultPmId: organizations.stripeDefaultPmId,
				creditsRemaining: organizations.creditsRemaining
			})
			.from(organizations)
			.where(eq(organizations.id, user.orgId))
			.get()
	]);
	if (!org) throw new Error(`org not found: ${user.orgId}`);
	return {
		maintenance: false,
		user,
		summary,
		history: history.map((row) => ({
			id: row.id,
			delta: row.delta,
			reason: row.reason,
			refType: row.refType,
			refId: row.refId,
			createdAt: row.createdAt
		})),
		bundles: configuredBundles(),
		autoTopupConsentText: AUTO_TOPUP_CONSENT_TEXT,
		autoTopup: {
			enabled: org.autoTopupEnabled === 1,
			threshold: org.autoTopupThreshold ?? AUTO_TOPUP_DEFAULT_THRESHOLD,
			state: org.autoTopupState ?? 'idle',
			failures: org.autoTopupFailures ?? 0,
			lastAttemptAt: org.autoTopupLastAttemptAt,
			hasCard: Boolean(org.stripeDefaultPmId)
		}
	};
};

export const actions: Actions = {
	/** Owner-only: creates a Stripe Checkout for one credit bundle. */
	buy: async ({ request, locals }) => {
		const user = requireUser(locals);
		const bundleId = String((await request.formData()).get('bundle') ?? '');
		try {
			const url = await createCreditCheckout(user.orgId, user, bundleId);
			throw redirect(303, url);
		} catch (error) {
			// SvelteKit's redirect() is a function that THROWS a Redirect —
			// detect it with isRedirect, never instanceof. Auth failures
			// (HttpError) pass through too — a 403 must stay a 403, never be
			// flattened into a 400 checkout failure.
			if (isRedirect(error) || isHttpError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			console.error(`usage: checkout failed for org ${user.orgId}: ${message}`);
			return fail(400, { error: `Could not start checkout: ${message}` });
		}
	},
	/**
	 * Owner-only: enables/disables auto top-up. Enabling requires the explicit
	 * consent checkbox (Stripe's unscheduled-top-ups compliance requirement) —
	 * the checkbox sentence lives in src/lib/landing/legal.ts and is pinned by
	 * legal.test.ts so the form can never drift from the logged terms.
	 */
	setAutoTopup: async ({ request, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'owner');
		const form = await request.formData();
		const enabled = form.get('enabled') === 'on';
		const thresholdRaw = String(form.get('threshold') ?? '');
		const threshold = Number(thresholdRaw);
		if (!Number.isInteger(threshold) || threshold < 0 || threshold > 1_000_000) {
			return fail(400, { error: 'Auto top-up threshold must be a whole number of credits between 0 and 1,000,000.' });
		}
		if (enabled && form.get('consent') !== 'on') {
			return fail(400, { error: 'You must tick the consent checkbox to enable automatic top-up.' });
		}
		if (enabled) {
			// Re-enabling after SCA/decline failures starts from a clean slate.
			await db
				.update(organizations)
				.set({ autoTopupEnabled: 1, autoTopupThreshold: threshold, autoTopupState: 'idle', autoTopupFailures: 0 })
				.where(eq(organizations.id, user.orgId));
		} else {
			await db
				.update(organizations)
				.set({ autoTopupEnabled: 0 })
				.where(eq(organizations.id, user.orgId));
		}
		return { ok: true };
	}
};
