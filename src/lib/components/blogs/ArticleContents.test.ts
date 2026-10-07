import { readFileSync } from 'node:fs';
import { transpileModule, ScriptTarget } from 'typescript';
import { expect, test } from 'vitest';

const source = readFileSync(new URL('./ArticleContents.svelte', import.meta.url), 'utf8');
const script = source.match(/<script lang="ts">(.*?)<\/script>/s)?.[1];
if (!script) throw new Error('Article contents script was not found');
const { outputText } = transpileModule(script, { compilerOptions: { target: ScriptTarget.ESNext } });

/** Run the real effect and handlers with controllable viewport/heading geometry. */
function contentsTracking(height = 1600, documentHeight = 5000) {
	const positions = { first: 400, middle: 3000, final: 4500 };
	const headings = Object.keys(positions).map((id) => ({ id, title: id }));
	const listeners = new Map<string, () => void>();
	let pendingFrame: (() => void) | undefined;
	let cleanup: (() => void) | undefined;
	const window = {
		innerHeight: height,
		scrollY: 0,
		addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
		removeEventListener: (event: string) => listeners.delete(event)
	};
	const document = {
		documentElement: { scrollHeight: documentHeight },
		getElementById: (id: keyof typeof positions) => ({
			getBoundingClientRect: () => ({ top: positions[id] - window.scrollY })
		})
	};
	const state = new Function('window', 'document', '$props', '$state', '$effect', 'requestAnimationFrame', 'cancelAnimationFrame',
		`${outputText}\nreturn { get activeId() { return activeId; } };`
	)(window, document, () => ({ headings }), (value: unknown) => value,
		(effect: () => () => void) => { cleanup = effect(); },
		(callback: () => void) => { pendingFrame = callback; return 1; },
		() => { pendingFrame = undefined; }
	) as { readonly activeId: string };
	return {
		state,
		scroll: (top: number) => {
			window.scrollY = top;
			listeners.get('scroll')?.();
			const update = pendingFrame;
			pendingFrame = undefined;
			update?.();
		},
		cleanup: () => cleanup?.()
	};
}

test('the final section becomes current at the scroll limit even below the heading threshold', () => {
	const contents = contentsTracking();
	contents.scroll(3400);
	expect(contents.state.activeId).toBe('final');
	contents.scroll(3398);
	expect(contents.state.activeId).toBe('middle');
	contents.scroll(400);
	expect(contents.state.activeId).toBe('first');
	contents.cleanup();
});

test('normal scrolling selects the last heading past the threshold and updates when scrolling upward', () => {
	const contents = contentsTracking();
	expect(contents.state.activeId).toBe('');
	contents.scroll(2887);
	expect(contents.state.activeId).toBe('first');
	contents.scroll(2888);
	expect(contents.state.activeId).toBe('middle');
	contents.scroll(400);
	expect(contents.state.activeId).toBe('first');
	contents.cleanup();
});

test('a fractional pixel at the scroll limit still selects the final section', () => {
	const contents = contentsTracking();
	contents.scroll(3399.5);
	expect(contents.state.activeId).toBe('final');
	contents.cleanup();
});

test('a document without a scrollable viewport does not select the final section on load', () => {
	const contents = contentsTracking(5000, 5000);
	expect(contents.state.activeId).toBe('');
	contents.cleanup();
});
