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

// Usage tab: the org's credit balance, consumption, purchase history, bundle
// purchases (owner-only) and auto top-up settings. All money movements land
// in credit_transactions; the page just reads the same ledger the pipeline
// consumes — so a top-up (manual or auto) always moves the counter.

import { error, fail, isHttpError, isRedirect, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { eq } from 'drizzle-orm';

import { AUTO_TOPUP_DEFAULT_THRESHOLD } from '$lib/server/billing/autotopup';
import { createCreditCheckout, createPlanCheckout } from '$lib/server/billing/checkout';
import { createMercadoPagoCreditCheckout } from '$lib/server/mercadopago/checkout';
import { configuredMercadoPagoBundles } from '$lib/server/mercadopago/bundles';
import { listCreditTransactions, orgIsMetered, usageSummary } from '$lib/server/billing/ledger';
import { db } from '$lib/server/db';
import { organizations } from '$lib/server/db/schema';
import { AUTO_TOPUP_CONSENT_TEXT, LEGAL_VERSION } from '$lib/server/legal';
import { configuredBundles } from '$lib/server/stripe/bundles';
import { requireOrgRole } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';

import type { Actions, PageServerLoad } from './$types';

function isStripeCheckoutError(error: unknown): boolean {
	return error !== null && typeof error === 'object' && typeof (error as { type?: unknown }).type === 'string';
}

function checkoutFailure(error: unknown, orgId: string) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`usage: checkout failed for org ${orgId}: ${message}`);
	return fail(400, { error: isStripeCheckoutError(error) ? 'Could not start checkout — please try again.' : `Could not start checkout: ${message}` });
}


export const load: PageServerLoad = async ({ locals }) => {
	if (locals.dbDown) {
		return {
			maintenance: true,
			user: null,
			summary: null,
			mercadoPagoBundles: [],
			metered: false,
			history: [],
			bundles: [],
			autoTopup: null,
			autoTopupConsentText: AUTO_TOPUP_CONSENT_TEXT,
			plans: { hosted: Boolean(env.STRIPE_PRICE_HOSTED_MONTHLY), lifetime: Boolean(env.STRIPE_PRICE_LIFETIME) }
		};
	}
	const user = requireUser(locals);
	try {
		// The org existence check runs FIRST: an account-integrity failure
		// (session pointing at a vanished org) must surface the support
		// instruction, not fall through to maintenance — and not be masked by
		// a ledger 'org not found' from the summary query (coderabbit).
		const org = await db
			.select({
				autoTopupEnabled: organizations.autoTopupEnabled,
				autoTopupThreshold: organizations.autoTopupThreshold,
				autoTopupState: organizations.autoTopupState,
				autoTopupFailures: organizations.autoTopupFailures,
				autoTopupLastAttemptAt: organizations.autoTopupLastAttemptAt,
				stripeDefaultPmId: organizations.stripeDefaultPmId,
				creditsRemaining: organizations.creditsRemaining,
				plan: organizations.plan,
				stripeSubscriptionStatus: organizations.stripeSubscriptionStatus,
				stripeSubscriptionPeriodEnd: organizations.stripeSubscriptionPeriodEnd
			})
			.from(organizations)
			.where(eq(organizations.id, user.orgId))
			.get();
		if (!org) {
			throw error(500, 'account has no organization — contact support');
		}
		const [summary, history, metered] = await Promise.all([
			usageSummary(user.orgId),
			listCreditTransactions(user.orgId, 30),
			orgIsMetered(user.orgId)
		]);
		return {
			maintenance: false,
			user,
			mercadoPagoBundles: configuredMercadoPagoBundles(),
			summary,
			metered,
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
			},
			billing: {
				plan: org.plan,
				subscriptionStatus: org.stripeSubscriptionStatus,
				periodEnd: org.stripeSubscriptionPeriodEnd
			},
			plans: { hosted: Boolean(env.STRIPE_PRICE_HOSTED_MONTHLY), lifetime: Boolean(env.STRIPE_PRICE_LIFETIME) }
		};
	} catch (error) {
		// Deliberate HttpErrors (the missing-org 500 above) must pass through
		// untouched — only genuine database failures degrade to maintenance.
		if (isHttpError(error)) throw error;
		// Loud on the server, a maintenance overlay for the user — never a 500
		// (I12: the (app) layout renders the overlay for this payload instead
		// of SvelteKit's unstyled error page). Mirrors the dashboard load.
		console.error(`usage: load failed for org ${user.orgId}: ${error instanceof Error ? error.message : String(error)}`);
		return {
			maintenance: true,
			user: null,
			summary: null,
			mercadoPagoBundles: [],
			metered: false,
			history: [],
			bundles: [],
			autoTopup: null,
			autoTopupConsentText: AUTO_TOPUP_CONSENT_TEXT,
			plans: { hosted: Boolean(env.STRIPE_PRICE_HOSTED_MONTHLY), lifetime: Boolean(env.STRIPE_PRICE_LIFETIME) }
		};
	}
};

export const actions: Actions = {
	/** Owner-only: creates a Stripe Checkout for one credit bundle. */
	buy: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const bundleId = String(form.get('bundle') ?? '');
		const attemptId = String(form.get('attempt_id') ?? '');
		try {
			const url = await createCreditCheckout(user.orgId, user, bundleId, attemptId);
			throw redirect(303, url);
		} catch (error) {
			// SvelteKit's redirect() is a function that THROWS a Redirect —
			// detect it with isRedirect, never instanceof. Auth failures
			// (HttpError) pass through too — a 403 must stay a 403, never be
			// flattened into a 400 checkout failure.
			if (isRedirect(error) || isHttpError(error)) throw error;
			// Never surface RAW Stripe error text to the client (it can leak
			// card/bank details): a Stripe SDK error always carries a `type`,
			// and those get a generic message. Internal validation failures
			// (unknown bundle, missing APP_URL…) keep their specific, safe
			// message so the user can act on them. Full details go to the
			// server log either way.
			return checkoutFailure(error, user.orgId);
		}
	},
	/** Owner-only: creates a Mercado Pago BRL prepaid credit checkout. */
	buyMercadoPago: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const bundleId = String(form.get('bundle') ?? '');
		const attemptId = String(form.get('attempt_id') ?? '');
		try {
			const url = await createMercadoPagoCreditCheckout(user.orgId, user, bundleId, attemptId);
			throw redirect(303, url);
		} catch (cause) {
			if (isRedirect(cause) || isHttpError(cause)) throw cause;
			console.error(`usage: Mercado Pago checkout failed for org ${user.orgId}:`, cause);
			return fail(400, { error: 'Could not start Mercado Pago checkout — please try again.' });
		}
	},
	/** Owner-only: creates a hosted subscription or lifetime Checkout. */
	buyPlan: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const plan = String(form.get('plan') ?? '');
		const attemptId = String(form.get('attempt_id') ?? '');
		if (plan !== 'hosted' && plan !== 'lifetime') return fail(400, { error: 'Unknown billing plan.' });
		try {
			const url = await createPlanCheckout(user.orgId, user, plan, attemptId);
			throw redirect(303, url);
		} catch (error) {
			if (isRedirect(error) || isHttpError(error)) throw error;
			return checkoutFailure(error, user.orgId);
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
		// An ABSENT threshold field must fail, not silently become 0:
		// Number('') === 0 passes every check below and would set "top up
		// below zero", stopping replenishment (codex 6161).
		if (thresholdRaw.trim() === '') {
			return fail(400, { error: 'Auto top-up threshold must be a whole number of credits between 0 and 1,000,000.' });
		}
		const threshold = Number(thresholdRaw);
		if (!Number.isInteger(threshold) || threshold < 0 || threshold > 1_000_000) {
			return fail(400, { error: 'Auto top-up threshold must be a whole number of credits between 0 and 1,000,000.' });
		}
		// Consent is required only on the disabled→enabled TRANSITION: the page
		// hides the checkbox once enabled, so an already-enabled org updating
		// its threshold submits enabled=on without consent and must never 400.
		// The evidence is also written once, on that same transition — a
		// threshold tweak must not rewrite the original authorization record.
		const current = await db
			.select({
				autoTopupEnabled: organizations.autoTopupEnabled,
				autoTopupState: organizations.autoTopupState
			})
			.from(organizations)
			.where(eq(organizations.id, user.orgId))
			.get();
		const wasEnabled = current?.autoTopupEnabled === 1;
		if (enabled && !wasEnabled && form.get('consent') !== 'on') {
			return fail(400, { error: 'You must tick the consent checkbox to enable automatic top-up.' });
		}
		if (enabled) {
			// Consent evidence — Stripe's save-and-reuse compliance: keep a
			// record of the written agreement. The exact checkbox sentence
			// (rendered from AUTO_TOPUP_CONSENT_TEXT itself so the form can
			// never drift), the legal version it was rendered under, the user
			// who ticked it, and when. Written on the enable transition and
			// NEVER cleared by disabling — the authorization record survives
			// for dispute defense.
			// Re-enabling after SCA/decline failures starts from a clean slate.
			const evidence =
				!wasEnabled
					? {
							autoTopupConsentText: AUTO_TOPUP_CONSENT_TEXT,
							autoTopupConsentVersion: LEGAL_VERSION,
							autoTopupConsentedBy: user.id,
							autoTopupConsentedAt: new Date().toISOString()
						}
					: {};
			// The claim reset is scoped: the enable TRANSITION (and the
			// recovery of a failure-disabled org) starts from a clean slate,
			// but a threshold-only update while a charge is IN FLIGHT must
			// preserve the claim — resetting it would let the sweep create a
			// second PaymentIntent for the same shortage (coderabbit).
			const resetClaim = !wasEnabled || current?.autoTopupState === 'disabled';
			await db
				.update(organizations)
				.set({
					autoTopupEnabled: 1,
					autoTopupThreshold: threshold,
					...(resetClaim ? { autoTopupState: 'idle', autoTopupFailures: 0 } : {}),
					...evidence
				})
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
