import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compile, parse } from 'svelte/compiler';
import { render } from 'svelte/server';
import { ModuleKind, transpileModule } from 'typescript';
import { expect, it } from 'vitest';
import Reveal from '../Reveal.svelte';
import type CostMath from './CostMath.svelte';
import * as cost from '$lib/landing/cost';

const source = readFileSync(new URL('./CostMath.svelte', import.meta.url), 'utf8');

/** Supply form input state; execute the real estimator and render the actual result markup. */
function renderEstimate(moderation: number, digest: number) {
	const inputState: Record<string, number> = { moderationCount: moderation, digestCount: digest };
	const ast = parse(source, { modern: true });
	const edits = ast.instance?.content.body
		.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : [])
		.flatMap((node) => {
			if (node.id.type !== 'Identifier' || !(node.id.name in inputState)) return [];
			if (node.init?.type !== 'CallExpression') throw new Error('Calculator input state was not found');
			const initial = node.init.arguments[0];
			if (!initial || !('start' in initial) || !('end' in initial)) throw new Error('Calculator initial value was not found');
			return [{ start: initial.start as number, end: initial.end as number, value: inputState[node.id.name] }];
		}) ?? [];
	if (edits.length !== 2) throw new Error('Both calculator inputs must be supplied');
	const template = edits.toSorted((a, b) => b.start - a.start).reduce(
		(text, edit) => text.slice(0, edit.start) + String(edit.value) + text.slice(edit.end), source
	);
	const { outputText } = transpileModule(compile(template, { generate: 'server', runes: true }).js.code, {
		compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: false }
	});
	const dependencies: Record<string, unknown> = {
		'svelte/internal/server': createRequire(import.meta.url)('svelte/internal/server'),
		'$app/state': { page: { data: { locale: 'en' } } },
		'../Reveal.svelte': { default: Reveal },
		'$lib/landing/cost': cost
	};
	const exports: { default?: typeof CostMath } = {};
	new Function('require', 'exports', outputText)((id: string) => {
		if (!(id in dependencies)) throw new Error(`Unexpected calculator import: ${id}`);
		return dependencies[id];
	}, exports);
	if (!exports.default) throw new Error('Calculator renderer was not found');
	return render(exports.default).body;
}

const MONTHLY_CASES = [
	{ moderation: 0, digest: 0, total: '$5.00', credits: '0', topup: '$0.00' },
	{ moderation: 80, digest: 20, total: '$5.00', credits: '0', topup: '$0.00' },
	{ moderation: 100, digest: 100, total: '$25.40', credits: '500', topup: '$20.40' }
];

it.each(MONTHLY_CASES)('identifies the full monthly total for $moderation moderation / $digest digest classifications', ({ moderation, digest, total }) => {
	const body = renderEstimate(moderation, digest);
	const headline = body.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/)?.[1];
	expect(headline).toContain(total);
	expect(headline).toContain('estimated monthly total');
	expect(headline).not.toContain('estimated purchases');
});

it.each(MONTHLY_CASES)('shows subscription separately from top-up for $moderation moderation / $digest digest classifications', ({ moderation, digest, credits, topup }) => {
	const body = renderEstimate(moderation, digest).replace(/<!--[\s\S]*?-->/g, '');
	expect(body).toMatch(/<dt\b[^>]*>Subscription<\/dt>\s*<dd\b[^>]*>\$5\.00<\/dd>/);
	expect(body).toContain(`${credits} credits (${topup})`);
});
