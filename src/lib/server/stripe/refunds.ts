import type Stripe from 'stripe';
import { getStripe } from './client';

/** True when the full charge amount was refunded; partial refunds retain their purchase. */
export function chargeFullyRefunded(charge: { amount?: unknown; amount_refunded?: unknown }): boolean {
	return typeof charge.amount === 'number' && charge.amount > 0 && typeof charge.amount_refunded === 'number' && charge.amount_refunded >= charge.amount;
}

/**
 * Refunds a payment intent for a charge that can never grant its purchase —
 * loudly and idempotently. Shared by every "paid but ungrantable" path:
 * sold-out or duplicate lifetime checkouts, a credit purchase fulfilled
 * after the org went lifetime, an auto top-up charge that landed
 * post-upgrade.
 *
 * A refund API failure PROPAGATES after a loud MANUAL REFUND REQUIRED log:
 * swallowing it would ACK the delivery and leave the customer charged
 * until a human reads the log — the caller's retry path (webhook
 * redelivery, sweep) retries under the same idempotency key instead
 * (review). Callers skip the already-refunded and no-payment-intent cases
 * first — nothing a retry could change there.
 */
export async function refundUngrantablePayment(input: {
	paymentIntentId: string;
	idempotencyKey: string;
	/** Human-readable log context, e.g. `checkout cs_1 for org org-1 was PAID but claimed no slot`. */
	label: string;
	/** Persisted on the refund so the terminal charge.refund.updated event routes back to our records. */
	orgId: string;
	checkoutSessionId?: string;
	requestOptions?: Stripe.RequestOptions;
}): Promise<{ id: string; status: 'succeeded' | 'pending' | 'requires_action' }> {
	try {
		// The tags persisted ON the refund let a later terminal-status event
		// (charge.refund.updated → failed/canceled) identify OUR ungrantable
		// refunds and escalate — a pending refund that dies at Stripe must not
		// vanish quietly after we ACKed (codex P1).
		const refund = await getStripe().refunds.create(
			{
				payment_intent: input.paymentIntentId,
				metadata: {
					reason: 'ungrantable',
					org_id: input.orgId,
					...(input.checkoutSessionId ? { checkout_session_id: input.checkoutSessionId } : {})
				}
			},
			{ ...input.requestOptions, idempotencyKey: input.idempotencyKey }
		);
		// Validate the boundary response (I2): refunds.create can RESOLVE a
		// failed/canceled refund — logging success would ACK the delivery and
		// leave the customer charged with no retry (codex P1). 'succeeded' is
		// done; 'pending'/'requires_action' are genuinely in flight at Stripe
		// (retrying under the same idempotency key returns the same object, so
		// treating them as failures would storm forever); anything else means
		// the refund did not and will not happen — loud and retryable.
		if (typeof refund.id !== 'string' || !refund.id.trim()) throw new Error('Stripe returned an invalid refund ID — MANUAL REFUND REQUIRED');
		if (refund.status !== 'succeeded' && refund.status !== 'pending' && refund.status !== 'requires_action') {
			throw new Error(`refund ${refund.id} resolved ${refund.status ?? 'no status'} — MANUAL REFUND REQUIRED`);
		}
		console.error(`stripe: ${input.label} — auto-refunded payment intent ${input.paymentIntentId} (refund ${refund.id}, status ${refund.status})`);
		return { id: refund.id, status: refund.status };
	} catch (error) {
		console.error(`stripe: ${input.label} — auto-refund FAILED, MANUAL REFUND REQUIRED: ${error instanceof Error ? error.message : String(error)}`);
		throw error;
	}
}
