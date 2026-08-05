// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { describe, expect, it } from 'vitest';
import { AGPL_URL, CONTACT_URL, FEEDBACK_URL, GITHUB_URL, LOGIN_URL } from './links';

describe('landing links', () => {
	it('points at the Moderaty GitHub repository', () => {
		expect(GITHUB_URL).toBe('https://github.com/Bonobo791/Moderaty');
	});

	it('points at the Featurebase feedback board', () => {
		expect(FEEDBACK_URL).toBe('https://moderaty.featurebase.app/');
	});

	it('points at the AGPL license text', () => {
		expect(AGPL_URL).toBe('https://www.gnu.org/licenses/agpl-3.0.html');
	});

	it('points the contact link at the commercial-licensing mailbox', () => {
		expect(CONTACT_URL).toBe('mailto:contact@marketingprowess.simplelogin.com');
	});

	it('routes every Connect CTA into the real OAuth login flow', () => {
		expect(LOGIN_URL).toBe('/login');
	});
});
