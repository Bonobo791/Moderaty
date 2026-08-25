// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Advanced Digital Marketing LTDA
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

/** Provider-neutral seam for prepaid credit checkout creation.
 *
 * Stripe and Mercado Pago keep their own API clients, credentials, checkout
 * attempts, and webhook adapters. The usage route only needs this result and
 * the ledger remains the single fulfillment authority.
 */
export type PrepaidCheckoutInput = {
	orgId: string;
	attemptId: string;
	bundleId: string;
	credits: number;
	amountCents: number;
	idempotencyKey: string;
	appUrl: string;
};

export type PrepaidCheckout = {
	providerCheckoutId: string;
	checkoutUrl: string;
};

export interface PrepaidCreditProvider {
	readonly id: 'stripe' | 'mercadopago';
	createCheckout(input: PrepaidCheckoutInput): Promise<PrepaidCheckout>;
}

export function providerLedgerRef(provider: PrepaidCreditProvider['id'], paymentId: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(paymentId)) throw new Error(`${provider} payment id is invalid`);
	return `${provider}:${paymentId}`;
}
