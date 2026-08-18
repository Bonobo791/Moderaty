// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { afterEach, describe, expect, it, vi } from 'vitest';

// svelte.config.js reads process.env.MODERATY_ADAPTER at import time. Each
// dynamic import below gets its own query string so vite-node evaluates the
// module fresh instead of serving a cached copy evaluated under a previous
// env.
async function loadConfig(label: string) {
	const mod = await import('./svelte.config.js?role=' + label);
	return mod.default;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('svelte.config.js adapter selection', () => {
	it('defaults to the Netlify adapter when MODERATY_ADAPTER is unset (existing Netlify builds unchanged)', async () => {
		// Genuinely UNSET, not stubbed to '' — a regression that only treats
		// '' as Netlify but mishandles undefined must fail this test
		// (coderabbit).
		const original = process.env.MODERATY_ADAPTER;
		delete process.env.MODERATY_ADAPTER;
		try {
			const config = await loadConfig('netlify-default');
			expect(config.kit.adapter.name).toBe('@sveltejs/adapter-netlify');
		} finally {
			if (original === undefined) delete process.env.MODERATY_ADAPTER;
			else process.env.MODERATY_ADAPTER = original;
		}
	});

	it('selects the node adapter when MODERATY_ADAPTER=node (Coolify Docker build)', async () => {
		vi.stubEnv('MODERATY_ADAPTER', 'node');
		const config = await loadConfig('coolify-node');
		expect(config.kit.adapter.name).toBe('@sveltejs/adapter-node');
	});

	it('fails loudly on any other value — a build must never silently pick a target', async () => {
		vi.stubEnv('MODERATY_ADAPTER', 'vercel');
		await expect(loadConfig('unrecognized')).rejects.toThrow(/Unknown MODERATY_ADAPTER=vercel/);
	});
});
