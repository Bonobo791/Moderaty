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

import { expect, test, vi } from 'vitest';

vi.mock('$lib/server/oauthState', () => ({ cookieSecure: () => true }));

import { POST } from './+server';

function cookies() {
	return { set: vi.fn() };
}

test('sets a validated locale cookie and redirects to the same-site path', async () => {
	const cookieJar = cookies();
	const form = new FormData();
	form.set('locale', 'pt-BR');
	form.set('returnTo', '/terms#s1');
	await expect(POST({ request: new Request('https://moderaty.example/api/locale', { method: 'POST', body: form }), cookies: cookieJar } as never)).rejects.toMatchObject({ status: 303, location: '/terms#s1' });
	expect(cookieJar.set).toHaveBeenCalledWith('moderaty_locale', 'pt-BR', expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax' }));
});

test('rejects unsupported locales and external return paths', async () => {
	const unsupported = new FormData();
	unsupported.set('locale', 'fr');
	unsupported.set('returnTo', '/');
	const unsupportedResponse = await POST({ request: new Request('https://moderaty.example/api/locale', { method: 'POST', body: unsupported }), cookies: cookies() } as never);
	expect(unsupportedResponse.status).toBe(400);
	const external = new FormData();
	external.set('locale', 'en');
	external.set('returnTo', 'https://evil.example');
	const externalResponse = await POST({ request: new Request('https://moderaty.example/api/locale', { method: 'POST', body: external }), cookies: cookies() } as never);
	expect(externalResponse.status).toBe(400);
});

test('rejects backslash return paths — browsers resolve /\\evil.example as protocol-relative', async () => {
	const form = new FormData();
	form.set('locale', 'en');
	form.set('returnTo', '/\\evil.example');
	const response = await POST({ request: new Request('https://moderaty.example/api/locale', { method: 'POST', body: form }), cookies: cookies() } as never);
	expect(response.status).toBe(400);
});
