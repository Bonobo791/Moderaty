import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const helpPage = readFileSync(join(here, '+page.svelte'), 'utf8');
const appLayout = readFileSync(join(here, '..', '+layout.svelte'), 'utf8');

describe('help tab (reversibility disclosure)', () => {
	it('is linked from the app nav', () => {
		expect(appLayout).toContain('href="/help"');
	});

	it('states the permanence of deletes and author bans, matching Terms §9.4', () => {
		expect(helpPage).toMatch(/deleted comments? cannot be (?:restored|reversed|undone)/i);
		expect(helpPage).toMatch(/author bans? cannot be (?:lifted|reversed|undone)/i);
	});

	it('points to the audit log for undoing hold and reject actions', () => {
		expect(helpPage).toMatch(/audit log/i);
		expect(helpPage).toMatch(/hold/i);
		expect(helpPage).toMatch(/reject/i);
	});

	it('distinguishes moderation history from read-only feedback history and states preview limits', () => {
		expect(helpPage).toMatch(/Analyze history on the Overview tab can apply moderation actions to older comments/i);
		expect(helpPage).toMatch(/a history scan on the Feedback tab only reads comments and groups feedback; it never changes moderation/i);
		expect(helpPage).toMatch(/choose 1, 3, 6, 12, or 24 months/i);
		expect(helpPage).toMatch(/batches of up to 100 comments and keeps going automatically, even when digests are set to manual/i);
		expect(helpPage).toMatch(/comments already included in a digest are skipped, and retries are not charged twice/i);
		expect(helpPage).toMatch(/turning feedback off pauses the scan; re-enabling it resumes where it stopped/i);
		expect(helpPage).toMatch(/1 free moderation dry run and 1 free feedback dry run/i);
		expect(helpPage).toMatch(/the allowance is used when a preview starts, even if it later fails/i);
		expect(helpPage).toMatch(/DRY_RUN=true/i);
		expect(helpPage).not.toMatch(/fake moderated comments|charge anchors|existing exceptions/i);
	});
});

// These pins cover the user-facing instructions, especially permissions,
// billing, and destructive-action boundaries. Removing an available feature
// or replacing a safety disclosure with an inaccurate promise must fail.
describe('help covers the available product', () => {
	const text = helpPage.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

	it('separates identity sign-in from YouTube channel consent', () => {
		expect(text).toMatch(/Google sign-in.*separate.*YouTube.*permission/i);
		expect(text).toMatch(/Connect YouTube channel/i);
		expect(text).toMatch(/multiple channels.*choose/i);
		expect(text).toMatch(/never.*repl(?:y|ies).*post/i);
	});

	it('explains both sensitivity modes and the strict protection switches', () => {
		expect(text).toContain('EDGE LORD');
		expect(text).toContain('STRICT');
		expect(text).toMatch(/tone.*hides.*never.*deletes.*bans/i);
		expect(text).toMatch(/LGBTQIA\+.*women/i);
	});

	it('explains rule precedence and protected handles', () => {
		expect(text).toMatch(/keyword.*regex.*blocked-user.*channel ID/i);
		expect(text).toMatch(/protected handles.*100.*skip.*rules.*AI/i);
		expect(text).toMatch(/rule matches and protected handles.*(?:do not|never).*credit/i);
	});

	it('distinguishes pausing from destructive disconnection', () => {
		expect(text).toMatch(/pause.*new comments.*unchecked/i);
		expect(text).toMatch(/resume.*connection.*saved/i);
		expect(text).toMatch(/disconnect.*erases.*rules.*comments.*history.*no restore/i);
	});

	it('explains review actions, hold confirmation, and audit paging', () => {
		expect(text).toMatch(/Approve.*Reject.*Delete.*Ban author/i);
		expect(text).toMatch(/may remain public.*hold is confirmed/i);
		expect(text).toMatch(/Older.*Newest/i);
	});

	it('documents digest controls and distinguishes free preview sizes', () => {
		expect(text).toMatch(/weekly.*100 new comments.*manual/i);
		expect(text).toMatch(/2 to 10 comments/i);
		expect(text).toMatch(/moderation preview.*all time/i);
		expect(text).toMatch(/feedback previews cover the first page, up to 100 comments/i);
		expect(text).toMatch(/owner.*(?:generate|run).*digest/i);
	});

	it('makes billing, conditional payment availability, and lifetime BYOK clear', () => {
		expect(text).toMatch(/automatic top-up.*consent/i);
		expect(text).toMatch(/Mercado Pago.*when.*(?:offered|shown).*Usage/i);
		expect(text).toMatch(/lifetime.*own OpenAI.*Team/i);
		expect(text).toMatch(/OpenAI.*(?:bills|costs|charges).*separately/i);
		expect(text).toMatch(/Manage cards.*Manage subscription/i);
	});

	it('describes team permissions and single-use invitations', () => {
		expect(text).toMatch(/members.*review queue.*rules/i);
		expect(text).toMatch(/admins.*channels.*invite/i);
		expect(text).toMatch(/owners.*billing.*feedback/i);
		expect(text).toMatch(/invite.*once.*7 days/i);
	});

	it('covers privacy, support, current language coverage, and restricted licensing', () => {
		expect(text).toMatch(/handles.*30 days.*Erase handles now/i);
		expect(text).toMatch(/account deletion.*permanent/i);
		expect(text).toMatch(/consent.*10 years/i);
		expect(text).toMatch(/Brazilian Portuguese.*signed-in app.*English/i);
		expect(text).toMatch(/source-available.*PolyForm Shield.*commercial restrictions/i);
		for (const href of ['/dashboard', '/org', '/usage', '/account', '/contact', '/pricing', '/privacy', '/dpa']) {
			expect(helpPage).toContain(`href="${href}"`);
		}
	});

	it('offers in-page navigation to every help section', () => {
		const ids = [...helpPage.matchAll(/<section[^>]*id="([^"]+)"/g)].map((match) => match[1]);
		expect(ids.length).toBeGreaterThanOrEqual(10);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(helpPage).toContain(`href="#${id}"`);
		expect(helpPage).toMatch(/a\s*\{[^}]*color:\s*var\(--text\)/);
		expect(helpPage).toMatch(/a:visited\s*\{[^}]*color:\s*var\(--text-2\)/);
		expect(helpPage).toMatch(/a:hover\s*\{[^}]*color:\s*var\(--accent\)/);
		expect(helpPage).toMatch(/a:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);[^}]*outline-offset:\s*3px/);
	});
});
