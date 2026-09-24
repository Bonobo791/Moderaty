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
