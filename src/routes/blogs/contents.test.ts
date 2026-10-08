import { render } from 'svelte/server';
import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import Article from './how-to-deal-with-hate-comments-on-youtube/+page.svelte';

const article = () => render(Article, {
	props: { data: { locale: 'en', siteOrigin: 'https://moderaty.com' } }
}).body;
const withoutSvelteMarkers = (html: string) => html.replaceAll('<!---->', '');

test('label comparisons remove Svelte markers without hiding unexpected HTML', () => {
	expect(withoutSvelteMarkers('<!----><strong>Section title</strong><!---->'))
		.toBe('<strong>Section title</strong>');
});

test('both contents views link to every article heading in reading order', () => {
	const body = article();
	const headings = [...body.matchAll(/<h2\b[^>]*id="([^"]+)"[^>]*>(.*?)<\/h2>/gs)]
		.map(([, id, label]) => ({ id, label: withoutSvelteMarkers(label) }));
	expect(headings).toHaveLength(10);
	expect(new Set(headings.map(({ id }) => id)).size).toBe(headings.length);
	const menus = [...body.matchAll(/<nav\b[^>]*aria-label="On this page"[^>]*>(.*?)<\/nav>/gs)];
	expect(menus).toHaveLength(2);
	for (const [, menu] of menus) {
		const links = [...menu.matchAll(/<a\b[^>]*href="#([^"]+)"[^>]*>(.*?)<\/a>/gs)]
			.map(([, id, label]) => ({ id, label: withoutSvelteMarkers(label) }));
		expect(links).toEqual(headings);
	}
});

test('mobile contents is a native, initially collapsed disclosure below the article title', () => {
	const body = article();
	const disclosure = body.match(/<details\b([^>]*)>(.*?)<\/details>/s);
	expect(disclosure).not.toBeNull();
	expect(disclosure![1]).not.toMatch(/\bopen(?:\s|=|$)/);
	expect(disclosure![2]).toMatch(/<summary\b[^>]*>.*?On this page.*?<\/summary>/s);
	expect(body.indexOf('<details')).toBeGreaterThan(body.indexOf('</h1>'));
});

test('section targets can receive keyboard focus after following a contents link', () => {
	const headings = [...article().matchAll(/<h2\b([^>]*)>/g)];
	expect(headings).toHaveLength(10);
	for (const [, attributes] of headings) expect(attributes).toContain('tabindex="-1"');
});


test('preserved H3 deep links have a scroll offset larger than the fixed navigation', () => {
	const source = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');
	const css = compile(source, { generate: 'server' }).css!.code;
	const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
	const h3Offset = rules.filter(([, selector]) => selector.includes('h3[id]'))
		.map(([, , declarations]) => Number.parseFloat(declarations.match(/scroll-margin-top:\s*([\d.]+)px/)?.[1] ?? '0'));
	expect(h3Offset.length).toBeGreaterThan(0);
	expect(Math.max(...h3Offset)).toBeGreaterThan(64);
});
