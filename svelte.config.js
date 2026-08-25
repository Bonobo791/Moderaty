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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import adapterNetlify from '@sveltejs/adapter-netlify';
import adapterNode from '@sveltejs/adapter-node';

// Two supported deployment targets (docs/COOLIFY_BUNNY.md):
// - Netlify (default): MODERATY_ADAPTER unset — every existing Netlify build
//   is unchanged.
// - Coolify (self-hosted): the Dockerfile builds with MODERATY_ADAPTER=node.
// The choice is made at BUILD time, so a single repo serves both targets.
// Any other value fails loudly — a build must never silently pick a target.
const deployTarget = process.env.MODERATY_ADAPTER;
if (deployTarget && deployTarget !== 'node') {
	throw new Error(
		`Unknown MODERATY_ADAPTER=${deployTarget} — use 'node' (Coolify) or leave it unset (Netlify)`
	);
}
const useNode = deployTarget === 'node';

export default {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in Svelte 6.
		runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
		// Keep the direction-contract HTML comment in the root layout auditable
		// in the production build (impeccable new-work contract).
		preserveComments: true
	},
	kit: {
		adapter: useNode ? adapterNode() : adapterNetlify()
	}
};
