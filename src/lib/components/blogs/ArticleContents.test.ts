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

const trackingCases: {
	name: string;
	height?: number;
	documentHeight?: number;
	steps: [number, string][];
}[] = [
	{
		name: 'selects the final section at the scroll limit, then tracks upward scrolling',
		steps: [[3400, 'final'], [3398, 'middle'], [400, 'first']]
	},
	{
		name: 'preserves the 112px heading threshold during normal scrolling',
		steps: [[2887, 'first'], [2888, 'middle'], [400, 'first']]
	},
	{
		name: 'selects the final section within a fractional pixel of the scroll limit',
		steps: [[3399.5, 'final']]
	},
	{
		name: 'does not select the final section on an unscrollable page',
		height: 5000,
		documentHeight: 5000,
		steps: [[0, '']]
	}
];

test.each(trackingCases)('$name', ({ height, documentHeight, steps }) => {
	const contents = contentsTracking(height, documentHeight);
	expect(contents.state.activeId).toBe('');
	for (const [top, expected] of steps) {
		contents.scroll(top);
		expect(contents.state.activeId).toBe(expected);
	}
	contents.cleanup();
});
