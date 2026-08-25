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

import { env } from '$env/dynamic/private';

import { bundleById, CREDIT_BUNDLES, type CreditBundle } from '$lib/server/stripe/bundles';

export type MercadoPagoBundle = CreditBundle & { amountCents: number; priceEnv: string };

const PRICE_ENV_BY_BUNDLE: Record<string, string> = {
	credits_100: 'MERCADOPAGO_PRICE_CREDITS_100_BRL_CENTS',
	credits_500: 'MERCADOPAGO_PRICE_CREDITS_500_BRL_CENTS',
	credits_2000: 'MERCADOPAGO_PRICE_CREDITS_2000_BRL_CENTS'
};

function priceEnvFor(bundle: CreditBundle): string {
	const priceEnv = PRICE_ENV_BY_BUNDLE[bundle.id];
	if (!priceEnv) throw new Error(`Mercado Pago has no price configuration for ${bundle.id}`);
	return priceEnv;
}

export function amountCentsFor(bundle: CreditBundle): number {
	const priceEnv = priceEnvFor(bundle);
	const raw = env[priceEnv];
	if (!raw) throw new Error(`${priceEnv} is not configured`);
	const amountCents = Number(raw);
	if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
		throw new Error(`${priceEnv} must be a positive whole number of BRL cents`);
	}
	return amountCents;
}

export function mercadoPagoBundleById(id: string): MercadoPagoBundle {
	const bundle = bundleById(id);
	return { ...bundle, amountCents: amountCentsFor(bundle), priceEnv: priceEnvFor(bundle) };
}

export function configuredMercadoPagoBundles(): MercadoPagoBundle[] {
	return CREDIT_BUNDLES.flatMap((bundle) => {
		const priceEnv = PRICE_ENV_BY_BUNDLE[bundle.id];
		if (!priceEnv) {
			console.error(`mercadopago: no price env mapping for bundle ${bundle.id} — excluded from the catalog`);
			return [];
		}
		if (!env[priceEnv]) return [];
		// A malformed price is a configuration error, not a reason to take the
		// usage page down: log loudly and keep the valid bundles (codex/cubic).
		try {
			return [{ ...bundle, amountCents: amountCentsFor(bundle), priceEnv }];
		} catch (cause) {
			console.error(`mercadopago: bundle ${bundle.id} has a malformed ${priceEnv} — excluded from the catalog:`, cause);
			return [];
		}
	});
}
