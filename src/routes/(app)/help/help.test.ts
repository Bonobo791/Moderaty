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
		expect(helpPage).toMatch(/Analyze feedback history on the Feedback tab only reads comments and groups feedback; it never changes moderation/i);
		expect(helpPage).toMatch(/choose 1, 3, 6, 12, or 24 months/i);
		expect(helpPage).toMatch(/batches of up to 100 comments and continues automatically, even with manual digest cadence/i);
		expect(helpPage).toMatch(/comments already included in a digest are skipped, and retries are not charged twice/i);
		expect(helpPage).toMatch(/turning feedback off pauses the scan; re-enabling it resumes where it stopped/i);
		expect(helpPage).toMatch(/1 free moderation dry run and 1 free feedback dry run/i);
		expect(helpPage).toMatch(/the allowance is used when a preview starts, even if it later fails/i);
		expect(helpPage).toMatch(/DRY_RUN=true/i);
		expect(helpPage).not.toMatch(/fake moderated comments|charge anchors|existing exceptions/i);
	});
});
