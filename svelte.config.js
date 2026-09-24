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
