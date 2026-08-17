// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { afterEach, describe, expect, it, vi } from 'vitest';

// svelte.config.js reads process.env.ADAPTER at import time. Each dynamic
// import below gets its own query string so vite-node evaluates the module
// fresh instead of serving a cached copy evaluated under a previous env.
async function loadConfig(label: string) {
	const mod = await import('./svelte.config.js?role=' + label);
	return mod.default;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('svelte.config.js adapter selection', () => {
	it('defaults to the Netlify adapter when ADAPTER is unset (existing Netlify builds unchanged)', async () => {
		vi.stubEnv('ADAPTER', '');
		const config = await loadConfig('netlify-default');
		expect(config.kit.adapter.name).toBe('@sveltejs/adapter-netlify');
	});

	it('selects the node adapter when ADAPTER=node (Coolify Docker build)', async () => {
		vi.stubEnv('ADAPTER', 'node');
		const config = await loadConfig('coolify-node');
		expect(config.kit.adapter.name).toBe('@sveltejs/adapter-node');
	});

	it('treats any other ADAPTER value as Netlify — never a silent third target', async () => {
		vi.stubEnv('ADAPTER', 'vercel');
		const config = await loadConfig('unrecognized');
		expect(config.kit.adapter.name).toBe('@sveltejs/adapter-netlify');
	});
});
