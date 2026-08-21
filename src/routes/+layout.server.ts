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

import type { LayoutServerLoad } from './$types';

import { LOCALE_COOKIE, resolveLocale } from '$lib/i18n/locale';

export const load: LayoutServerLoad = ({ cookies, request }) => ({
	locale: resolveLocale({
		cookie: cookies.get(LOCALE_COOKIE),
		acceptLanguage: request.headers.get('accept-language')
	})
});
