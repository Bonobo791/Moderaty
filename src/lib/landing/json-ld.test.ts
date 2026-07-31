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
import { jsonLd } from './json-ld';

describe('jsonLd script-tag safety', () => {
	it('escapes </script> breakouts in string values', () => {
		const out = jsonLd({ name: 'evil </script><script>alert(1)</script>' });
		expect(out).not.toContain('</script><script>alert(1)');
		expect(out.match(/<\/script>/g)).toHaveLength(1); // only the real closing tag
	});

	it('escapes HTML comment openers so the block cannot be commented out', () => {
		const out = jsonLd({ name: '<!-- sneaky' });
		expect(out).not.toContain('<!--');
	});

	it('still emits valid JSON inside one script block', () => {
		const out = jsonLd({ '@type': 'Thing', name: 'Moderaty' });
		expect(out.startsWith('<script type="application/ld+json">')).toBe(true);
		expect(out.endsWith('</' + 'script>')).toBe(true);
		const json = out.slice('<script type="application/ld+json">'.length, -'</'.length - 'script>'.length);
		expect(JSON.parse(json)).toEqual({ '@type': 'Thing', name: 'Moderaty' });
	});
});
