import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import { transpileModule } from 'typescript';
import { expect, test, vi } from 'vitest';

// Exercise the page's actual callback: SSR rendering does not run enhance.
function submissionState() {
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	const handler = parse(source).instance!.content.body.find(
		(node: { type: string; id?: { name: string } }) =>
			node.type === 'FunctionDeclaration' && node.id?.name === 'submitting'
	)!;
	const { outputText } = transpileModule(source.slice(handler.start, handler.end), {});
	return new Function(`let pending = false; ${outputText}; return {
		submitting, get pending() { return pending; }
	};`)() as {
		submitting: () => (args: { update: () => Promise<void> }) => Promise<void>;
		pending: boolean;
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
