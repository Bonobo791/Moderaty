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
});
