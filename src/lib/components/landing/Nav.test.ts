import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Nav from './Nav.svelte';
import { FEEDBACK_URL, GITHUB_URL, LOGIN_URL } from '$lib/landing/links';

const source = readFileSync(new URL('./Nav.svelte', import.meta.url), 'utf8');
const style = source.split('<style>')[1].split('</style>')[0];
const baseStyle = style.split('@media')[0];

function declarations(selector: string) {
	const start = baseStyle.indexOf(`${selector} {`);
	expect(start, `${selector} has base styles`).toBeGreaterThanOrEqual(0);
	return baseStyle.slice(start, baseStyle.indexOf('}', start));
}

describe('landing navigation', () => {
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
		for (const href of [
			'/#top', '/#how-it-works', '/#digest', '/#regulars', '/#numbers',
			'/pricing', '/#faq', GITHUB_URL, FEEDBACK_URL, LOGIN_URL
		]) expect(body).toContain(`href="${href}"`);
		expect(body).toContain('aria-label="Primary"');
		expect(body).toContain('aria-label="Open menu"');
		expect(body).toContain('aria-expanded="false"');
	});
});
