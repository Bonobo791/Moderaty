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

import { describe, expect, it } from 'vitest';
import { POLYFORM_URL, CONTACT_URL, FEEDBACK_URL, GITHUB_URL, LOGIN_URL } from './links';

describe('landing links', () => {
	it('points at the Moderaty GitHub repository', () => {
		expect(GITHUB_URL).toBe('https://github.com/Bonobo791/Moderaty');
	});

	it('points at the Featurebase feedback board', () => {
		expect(FEEDBACK_URL).toBe('https://moderaty.featurebase.app/');
	});

	it('points at the PolyForm Shield license text', () => {
		expect(POLYFORM_URL).toBe('https://polyformproject.org/licenses/shield/1.0.0');
	});

	it('routes the contact link into the opt-in contact form page', () => {
		expect(CONTACT_URL).toBe('/contact');
	});

	it('routes every Connect CTA into the real OAuth login flow', () => {
		expect(LOGIN_URL).toBe('/login');
	});
});
