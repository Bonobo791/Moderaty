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

	it('escapes every "<" as the six characters \\u003c, preserving the data', () => {
		const out = jsonLd({ name: 'a<b<c' });
		expect(out).toContain('a\\u003cb\\u003cc');
		expect(out).not.toContain('a<b<c');
		const json = out.slice('<script type="application/ld+json">'.length, -'</'.length - 'script>'.length);
		expect(JSON.parse(json)).toEqual({ name: 'a<b<c' });
	});

	it('still emits valid JSON inside one script block', () => {
		const out = jsonLd({ '@type': 'Thing', name: 'Moderaty' });
		expect(out.startsWith('<script type="application/ld+json">')).toBe(true);
		expect(out.endsWith('</' + 'script>')).toBe(true);
		const json = out.slice('<script type="application/ld+json">'.length, -'</'.length - 'script>'.length);
		expect(JSON.parse(json)).toEqual({ '@type': 'Thing', name: 'Moderaty' });
	});
});
