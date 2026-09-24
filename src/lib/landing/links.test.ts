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
