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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Webhook route behavior: signature verification is the ONLY auth, and a
// missing STRIPE_SECRET_KEY is a SERVER configuration error (500), never a
// 400 "invalid signature" — the SDK throw must not be swallowed by the
// verification catch (codex review finding).

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_SECRET_KEY: 'sk_test' } as Record<string, string | undefined>,
	constructEvent: vi.fn(),
	handleStripeEvent: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/stripe/webhooks', () => ({ handleStripeEvent: mocks.handleStripeEvent }));
vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => {
		// Mirrors the real client: getStripe() throws when the secret key is
		// absent — the route must validate BEFORE the verification try, or the
		// throw is misreported as a 400 invalid signature.
		if (!mocks.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
		return { webhooks: { constructEvent: mocks.constructEvent } };
	}
}));

import { POST } from './+server';

beforeEach(() => {
	mocks.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
	mocks.env.STRIPE_SECRET_KEY = 'sk_test';
	mocks.constructEvent.mockReset();
	mocks.constructEvent.mockReturnValue({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
	mocks.handleStripeEvent.mockReset();
	mocks.handleStripeEvent.mockResolvedValue(true);
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function webhookRequest(): Request {
	return new Request('https://app.example/api/stripe/webhook', {
		method: 'POST',
		headers: { 'stripe-signature': 't=1,v1=sig' },
		body: '{"payload":true}'
	});
}

test('verifies the signature and answers 200 for a valid delivery', async () => {
	const res = await POST({ request: webhookRequest() } as never);
	expect(res.status).toBe(200);
	expect(mocks.constructEvent).toHaveBeenCalledWith('{"payload":true}', 't=1,v1=sig', 'whsec_test');
});

/** Calls the handler and returns the thrown HttpError instead of letting it escape. */
async function postCatching(): Promise<{ status: number; body?: { message?: string } }> {
	return POST({ request: webhookRequest() } as never).catch((e: { status: number; body?: { message?: string } }) => e);
}

test('a missing STRIPE_SECRET_KEY answers 500 (server config), never 400 invalid signature', async () => {
	mocks.env.STRIPE_SECRET_KEY = undefined;
	const res = await postCatching();
	expect(res.status).toBe(500);
	// The SDK was never constructed — a config error is not a signature failure.
	expect(mocks.constructEvent).not.toHaveBeenCalled();
});

test('a bad signature answers 400 invalid signature', async () => {
	mocks.constructEvent.mockImplementation(() => {
		throw new Error('No signatures found matching the expected signature');
	});
	const res = await postCatching();
	expect(res.status).toBe(400);
});
