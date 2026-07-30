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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const queuePage = readFileSync(join(here, '+page.svelte'), 'utf8');
const rulesPage = readFileSync(join(here, '..', 'rules', '+page.svelte'), 'utf8');

describe('queue page states (I12)', () => {
	it('renders action failures in an error-box', () => {
		expect(queuePage).toContain('form?.error');
		expect(queuePage).toMatch(/class="error-box"[^>]*role="alert"/);
	});

	it('uses grammatical guidance copy', () => {
		expect(queuePage).not.toContain('Nothing here is public-facing yet only if previously held');
		expect(queuePage).toContain('These comments are held for review and are not public yet.');
	});
});

describe('rules page states (I12)', () => {
	it('announces form errors to assistive technology', () => {
		expect(rulesPage).toMatch(/class="error-box"[^>]*role="alert"/);
	});
});
