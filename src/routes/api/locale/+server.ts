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

import { json, redirect } from '@sveltejs/kit';

import { isLocale, LOCALE_COOKIE } from '$lib/i18n/locale';
import { cookieSecure } from '$lib/server/oauthState';

function safeReturnTo(value: FormDataEntryValue | null): string {
	// A backslash makes browsers resolve '/\evil.example' as protocol-relative
	// ('//evil.example') — an open redirect (codex).
	if (typeof value !== 'string' || value === '' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value)) {
		throw new Error('locale return path is invalid');
	}
	return value;
}

export async function POST({ request, cookies }) {
	const form = await request.formData();
	const value = form.get('locale');
	if (typeof value !== 'string' || !isLocale(value)) return json({ error: 'Unsupported language.' }, { status: 400 });
	let returnTo: string;
	try {
		returnTo = safeReturnTo(form.get('returnTo'));
	} catch (cause) {
		console.error('locale: invalid return path:', cause);
		return json({ error: 'Invalid return path.' }, { status: 400 });
	}
	cookies.set(LOCALE_COOKIE, value, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookieSecure(),
		maxAge: 60 * 60 * 24 * 365
	});
	throw redirect(303, returnTo);
}
