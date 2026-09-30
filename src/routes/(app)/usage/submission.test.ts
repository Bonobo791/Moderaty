import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import { transpileModule } from 'typescript';
import { expect, test, vi } from 'vitest';

// Exercise the page's actual callback: SSR rendering does not run enhance.
function submissionState(source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8')) {
	const script = parse(source).instance;
	if (!script) throw new Error('Usage page script was not found');
	const handler = script.content.body.find(
		(node: { type: string; id?: { name: string } }) =>
			node.type === 'FunctionDeclaration' && node.id?.name === 'submitting'
	);
	if (!handler) throw new Error('Usage submission handler was not found');
	const { outputText } = transpileModule(source.slice(handler.start, handler.end), {});
	return new Function(`let pending = false; let enableTopup; ${outputText}; return {
		submitting, set enableTopup(value) { enableTopup = value; }, get enableTopup() { return enableTopup; }, get pending() { return pending; }
	};`)() as {
		submitting: () => (args: { update: () => Promise<void> }) => Promise<void>;
		pending: boolean;
		enableTopup: boolean | undefined;
	};
}

test('returning from another checkout leaves the 500-comment purchase enabled', async () => {
	const state = submissionState();
	const firstCheckout = state.submitting();
	expect(state.pending).toBe(true);
	// SvelteKit's external navigation never resolves. The page can be restored
	// from the browser's back/forward cache while this promise is still pending.
	const redirect = vi.fn(() => new Promise<void>(() => {}));
	void firstCheckout({ update: redirect });
	expect(redirect).toHaveBeenCalledOnce();
	expect(state.pending).toBe(false);

	const buy500 = state.submitting();
	expect(state.pending).toBe(true);
	const update = vi.fn(async () => {});
	await buy500({ update });
	expect(update).toHaveBeenCalledOnce();
	expect(state.pending).toBe(false);
});

test('failed or completed submissions discard the local checkbox override before form reset', async () => {
	const state = submissionState();
	state.enableTopup = true;
	await state.submitting()({ update: async () => { expect(state.enableTopup).toBeUndefined(); } });
	expect(state.enableTopup).toBeUndefined();
});

test('a renamed submission handler reports a clear harness error', () => {
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(() => submissionState(source.replace('function submitting(', 'function renamed('))).toThrow('Usage submission handler was not found');
});
