import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const helpPage = readFileSync(join(here, '+page.svelte'), 'utf8');
const appLayout = readFileSync(join(here, '..', '+layout.svelte'), 'utf8');

function sectionMarkup(id: string): string {
	const section = helpPage.match(new RegExp(`<section[^>]*id="${id}"[^>]*>([\\s\\S]*?)</section>`));
	expect(section, `Help section ${id}`).not.toBeNull();
	return section![1];
}

const visibleText = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/** Read one topic so a different topic cannot supply its missing disclosures. */
function sectionText(id: string): string {
	return visibleText(sectionMarkup(id));
}

/** Require permission guidance beside the instruction, rather than elsewhere on the page. */
function instructionText(id: string, element: 'p' | 'li', marker: string): string {
	const items = [...sectionMarkup(id).matchAll(new RegExp(`<${element}(?:\\s[^>]*)?>([\\s\\S]*?)</${element}>`, 'g'))];
	const item = items.find((match) => match[1].includes(marker));
	expect(item, `Help instruction ${id}: ${marker}`).toBeDefined();
	return visibleText(item![1]);
}

/** Pin each role's own list item so another role cannot supply a missing capability. */
function roleText(role: 'Members' | 'Admins' | 'Owners'): string {
	const item = sectionMarkup('teams').match(new RegExp(`<li>\\s*<strong>${role}</strong>([\\s\\S]*?)</li>`));
	expect(item, `Help role ${role}`).not.toBeNull();
	return visibleText(item![1]);
}

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

	it.each<{
		id: string; element: 'p' | 'li'; marker: string; permissions: RegExp[];
	}>([
		{ id: 'getting-started', element: 'li', marker: 'Connect YouTube channel', permissions: [/owners and admins.*Connect YouTube channel/i, /members.*ask an owner or admin/i] },
		{ id: 'getting-started', element: 'li', marker: 'Set your sensitivity', permissions: [/free moderation preview/i] },
		{ id: 'channel-controls', element: 'p', marker: 'disconnect channel', permissions: [/owners and admins can use.*disconnect channel/i] },
		{ id: 'feedback', element: 'p', marker: 'recurring questions', permissions: [/owners can enable it.*choose categories.*evidence threshold of 2 to 10 comments.*generate a digest/i] },
		{ id: 'history', element: 'p', marker: 'A history scan on the Feedback tab', permissions: [/only an owner can start feedback history scans or previews/i] },
		{ id: 'billing', element: 'p', marker: 'Manage cards', permissions: [/owners use Manage cards.*Manage subscription/i] },
		{ id: 'billing', element: 'p', marker: 'Automatic top-up', permissions: [/owners configure or disable it in Usage.*buy credits/i] },
		{ id: 'teams', element: 'p', marker: 'Create or manage teams', permissions: [/owners and admins use a shared team to invite teammates/i] },
		{ id: 'teams', element: 'p', marker: 'An invite link', permissions: [/owners and admins can revoke unused invitations/i] },
		{ id: 'privacy', element: 'p', marker: 'Account deletion', permissions: [/channels you connected.*need an owner or admin to reconnect/i] },
		{ id: 'troubleshooting', element: 'li', marker: 'YouTube access expired', permissions: [/owners and admins.*reconnect/i, /members.*ask an owner or admin/i] },
		{ id: 'troubleshooting', element: 'li', marker: 'Digest deferred', permissions: [/ask an owner.*credit or key issue.*Generate now/i] }
	])('qualifies $id instruction: $marker', ({ id, element, marker, permissions }) => {
		const instruction = instructionText(id, element, marker);
		for (const permission of permissions) expect(instruction).toMatch(permission);
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

	it('distinguishes audit actors from rule and AI decision reasons', () => {
		const audit = sectionText('audit');
		expect(audit).toMatch(/actor.*system.*automatic.*user.*manual/i);
		expect(audit).toMatch(/reason.*rule.*AI/i);
		expect(audit).not.toMatch(/actor:\s*rule, AI, or you/i);
	});

	it('directs stored scoring failures to manual review instead of promising automatic rescoring', () => {
		const troubleshooting = sectionText('troubleshooting');
		expect(troubleshooting).toMatch(/quota or timeout.*retr(?:y|ies).*later scheduled checks/i);
		expect(troubleshooting).toMatch(/AI scoring failure.*stored.*review queue.*not automatically.*scored again.*later.*checks.*manually/i);
		expect(troubleshooting).not.toMatch(/quota, scoring, or timeout failure.*retr(?:y|ies)/i);
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

	it('requires a usable lifetime OpenAI key and rejects keyless or operator-funded scoring claims', () => {
		const billing = sectionText('billing');
		expect(billing).toMatch(/lifetime:.*requires your own OpenAI API key/i);
		expect(billing).toMatch(/without a usable key, AI scoring cannot run/i);
		expect(billing).not.toMatch(/(?:AI )?scoring (?:works|runs|continues|is available) without (?:your|a|the customer(?:'|’)?s) (?:own |usable )?(?:OpenAI(?: API)? )?key/i);
		expect(billing).not.toMatch(/(?:operator|Moderaty)[- ](?:provided|funded) (?:AI scoring|scoring|OpenAI(?: API)? key)/i);
	});

	it('discloses members\' moderation controls without granting owner-only feedback access', () => {
		const members = roleText('Members');
		expect(members).toMatch(/review queue.*manage rules.*protected handles/i);
		expect(members).toMatch(/read the audit log.*digests/i);
		expect(members).toMatch(/change sensitivity.*protections/i);
		expect(members).toMatch(/pause.*resume.*moderation/i);
		expect(members).toMatch(/moderation previews/i);
		expect(members).toMatch(/start moderation history scans.*(?:spend|consume).*credits/i);
		expect(members).toMatch(/erase stored.*handles/i);
		expect(members).not.toMatch(/feedback (?:settings|previews|history runs)/i);
	});

	it('discloses admin channel management, member/admin invites, and removal limits', () => {
		const admins = roleText('Admins');
		expect(admins).toMatch(/also connect.*disconnect.*channels.*rename teams/i);
		expect(admins).toMatch(/create or revoke invite links for new members or admins.*never owners/i);
		expect(admins).toMatch(/remove ordinary members/i);
		expect(admins).toMatch(/cannot remove (?:owners or other admins|other admins or owners)/i);
		expect(admins).not.toMatch(/change existing member roles|manage billing|feedback (?:settings|previews)|lifetime OpenAI key/i);
	});

	it('discloses owner role changes, admin removal, and exclusive billing and feedback controls', () => {
		const owners = roleText('Owners');
		expect(owners).toMatch(/also change existing member roles.*promot.*owner/i);
		expect(owners).toMatch(/remove admins.*never owners/i);
		expect(owners).toMatch(/manage billing/i);
		expect(owners).toMatch(/feedback settings.*feedback previews.*digest.*history runs/i);
		expect(owners).toMatch(/lifetime OpenAI key/i);
	});

	it('describes shared-team invitations and last-owner and sole-member safeguards', () => {
		const teams = sectionText('teams');
		expect(teams).toMatch(/shared team.*invite teammates/i);
		expect(teams).toMatch(/invite.*once.*7 days/i);
		expect(teams).toMatch(/last owner cannot be demoted or leave while others remain/i);
		expect(teams).toMatch(/only member.*delete your account/i);
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
		const expectedIds = [
			'getting-started',
			'moderation',
			'rules',
			'channel-controls',
			'review',
			'audit',
			'feedback',
			'history',
			'billing',
			'teams',
			'privacy',
			'troubleshooting'
		];
		const ids = [...helpPage.matchAll(/<section[^>]*id="([^"]+)"/g)].map((match) => match[1]);
		expect(ids).toEqual(expectedIds);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of expectedIds) expect(helpPage).toContain(`href="#${id}"`);
		expect(helpPage).toMatch(/a\s*\{[^}]*color:\s*var\(--text\)/);
		expect(helpPage).toMatch(/a:visited\s*\{[^}]*color:\s*var\(--text-2\)/);
		expect(helpPage).toMatch(/a:hover\s*\{[^}]*color:\s*var\(--accent\)/);
		expect(helpPage).toMatch(/a:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);[^}]*outline-offset:\s*3px/);
	});
});
