import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compile, parse } from 'svelte/compiler';
import { render } from 'svelte/server';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
import Nav from './Nav.svelte';
import Icon from './Icon.svelte';
import * as links from '$lib/landing/links';
import { FEEDBACK_URL, GITHUB_URL, LOGIN_URL } from '$lib/landing/links';

const source = readFileSync(new URL('./Nav.svelte', import.meta.url), 'utf8');
const style = source.split('<style>')[1].split('</style>')[0];
const baseStyle = style.split('@media')[0];
const destinations = [
	'/#how-it-works', '/#digest', '/#regulars', '/#numbers',
	'/pricing', '/#faq', GITHUB_URL, FEEDBACK_URL, LOGIN_URL
];

type TemplateNode = {
	type: string;
	name?: string;
	children?: TemplateNode[];
	attributes?: { name: string; value: boolean | { data?: string; expression?: { start: number; end: number } }[] }[];
};

function descendants(node: TemplateNode): TemplateNode[] {
	return [node, ...(node.children ?? []).flatMap(descendants)];
}

/** Execute the real callbacks and render the actual template at their resulting state, without a DOM dependency. */
function menuInteraction(templateSource = source) {
	const source = templateSource;
	const ast = parse(source, { modern: true });
	const initial = ast.instance?.content.body
		.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : [])
		.find((node) => node.id.type === 'Identifier' && node.id.name === 'open')?.init;
	if (initial?.type !== 'CallExpression') throw new Error('Navigation open state was not found');
	const value = initial.arguments[0];
	if (!value || !('start' in value) || !('end' in value) || typeof value.start !== 'number' || typeof value.end !== 'number') {
		throw new Error('Navigation initial state was not found');
	}
	// Only the initial state is supplied by the test; all conditional markup and bindings remain real.
	const template = source.slice(0, value.start) + 'initialOpen' + source.slice(value.end);
	const { outputText } = transpileModule(compile(template, { generate: 'server', runes: true }).js.code, {
		compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: false }
	});
	const dependencies: Record<string, unknown> = {
		'svelte/internal/server': createRequire(import.meta.url)('svelte/internal/server'),
		'./Icon.svelte': { default: Icon }, '$lib/landing/links': links
	};
	const load = (id: string) => {
		if (!(id in dependencies)) throw new Error(`Unexpected navigation import: ${id}`);
		return dependencies[id];
	};
	const elements = descendants(parse(source).html as TemplateNode);
	const button = elements.find((node) => node.name === 'button');
	const mobile = elements.find((node) => node.name === 'nav' && node.attributes?.some(
		(attr) => attr.name === 'aria-label' && Array.isArray(attr.value) && attr.value[0]?.data === 'Mobile'
	));
	const link = mobile && descendants(mobile).find((node) => node.name === 'a');
	let open = false;
	const click = (node: TemplateNode | undefined, href?: string) => {
		const attr = node?.attributes?.find((attr) => attr.name === 'onclick');
		const expression = attr && Array.isArray(attr.value) ? attr.value[0]?.expression : undefined;
		if (!expression) throw new Error('Navigation click handler was not found');
		open = new Function('open', 'l', `(${source.slice(expression.start, expression.end)})(); return open;`)(open, { href });
	};
	return {
		clickButton: () => click(button),
		clickLink: (href: string) => click(link, href),
		body: () => {
			const exports: { default?: typeof Nav } = {};
			new Function('require', 'exports', 'initialOpen', outputText)(load, exports, open);
			if (!exports.default) throw new Error('Navigation renderer was not found');
			return render(exports.default).body;
		}
	};
}

function declarations(selector: string) {
	const start = baseStyle.indexOf(`${selector} {`);
	expect(start, `${selector} has base styles`).toBeGreaterThanOrEqual(0);
	return baseStyle.slice(start, baseStyle.indexOf('}', start));
}

describe('landing navigation', () => {
	it('marks desktop and expanded mobile CTAs with distinct reviewed placements', () => {
		const menu = menuInteraction();
		menu.clickButton();
		const body = menu.body();
		assertMarkers(body);
	});
	it('rejects swapped desktop/mobile attribution even when every marker remains present', () => {
		const swapped = source.replaceAll('nav_mobile', 'swapped_placement').replaceAll("'nav'", "'nav_mobile'")
			.replaceAll('data-moderaty-placement="nav"', 'data-moderaty-placement="nav_mobile"').replaceAll('swapped_placement', 'nav');
		const menu = menuInteraction(swapped); menu.clickButton();
		expect(() => assertMarkers(menu.body())).toThrow();
	});
	it('keeps explicit space between the brand, primary links, and connection action', () => {
		expect(declarations('.nav-inner')).toMatch(/gap:\s*24px;/);
		expect(declarations('.links')).toMatch(/gap:\s*20px;/);
		for (const selector of ['.wordmark', '.links', '.nav-actions']) {
			expect(declarations(selector)).toMatch(/flex-shrink:\s*0;/);
		}
	});

	it('uses the compact menu until the single-line desktop navigation fits', () => {
		expect(style).toMatch(/@media\s*\(min-width:\s*1152px\)/);
		expect(style).not.toMatch(/@media\s*\(min-width:\s*1024px\)/);
		for (const selector of ['.wordmark', '.link', '.cta']) {
			expect(declarations(selector)).toMatch(/white-space:\s*nowrap;/);
		}
	});

	it('preserves every destination and the labeled expandable menu', () => {
		const body = render(Nav).body;
		for (const href of ['/#top', ...destinations]) expect(body).toContain(`href="${href}"`);
		expect(body).toContain('aria-label="Primary"');
		expect(body).toContain('aria-label="Open menu"');
		expect(body).toContain('aria-expanded="false"');
	});

	it('opens the compact menu with every destination and closes after internal navigation or another toggle', () => {
		const menu = menuInteraction();
		expect(menu.body()).not.toContain('aria-label="Mobile"');
		for (const href of destinations.slice(0, 6)) {
			menu.clickButton();
			const body = menu.body();
			expect(body).toContain('aria-label="Close menu"');
			expect(body).toContain('aria-expanded="true"');
			const mobile = body.match(/<nav[^>]*aria-label="Mobile"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
			expect([...mobile.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual(destinations);
			menu.clickLink(href);
			expect(menu.body()).not.toContain('aria-label="Mobile"');
			expect(menu.body()).toContain('aria-expanded="false"');
		}
		menu.clickButton();
		menu.clickButton();
		expect(menu.body()).toContain('aria-label="Open menu"');
		expect(menu.body()).not.toContain('aria-label="Mobile"');
	});
});

function assertMarkers(body: string) {
	const mobile = body.match(/<nav[^>]*aria-label="Mobile"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? '';
	const expected = [
		{ href: LOGIN_URL, event: 'connect_click' }, { href: '/pricing', event: 'pricing_click' }, { href: GITHUB_URL, event: 'source_click' }
	];
	for (const [markup, placement] of [[body.replace(mobile, ''), 'nav'], [mobile, 'nav_mobile']]) {
		const actual = [...markup.matchAll(/<a\b([^>]*)>/g)].filter((match) => match[1].includes('data-moderaty-event='))
			.map((match) => ({
				href: match[1].match(/href="([^"]+)"/)?.[1], event: match[1].match(/data-moderaty-event="([^"]+)"/)?.[1],
				placement: match[1].match(/data-moderaty-placement="([^"]+)"/)?.[1]
			})).sort((a, b) => String(a.event).localeCompare(String(b.event)));
		expect(actual).toEqual(expected.map((pair) => ({ ...pair, placement })).sort((a, b) => a.event.localeCompare(b.event)));
	}
}
