import { execFileSync } from 'node:child_process';

export function verifyCheckout({ headSha, baseSha }, cwd = process.cwd()) {
	if (![headSha, baseSha].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
		throw new Error('Merge evidence rejected: missing PR checkout revisions');
	}
	const git = (args, discardOutput = false) => {
		try { return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', discardOutput ? 'ignore' : 'pipe', 'pipe'] }); }
		catch { throw new Error('Merge evidence rejected: PR diff could not be independently verified'); }
	};
	if (git(['rev-parse', 'HEAD']).trim() !== headSha) {
		throw new Error('Merge evidence rejected: checkout revision differs from PR head');
	}
	const mergeBase = git(['merge-base', baseSha, headSha]).trim();
	const paths = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', mergeBase, headSha]).split('\0').filter(Boolean);
	git(['diff', '--no-ext-diff', '--no-textconv', '--unified=0', mergeBase, headSha], true);
	const protectedPaths = paths.filter((path) => path.startsWith('scripts/merge-evidence/') ||
		['.merge-evidence.yml', '.github/merge-evidence-policy.yml', '.github/workflows/merge-evidence.yml'].includes(path));
	if (protectedPaths.length) {
		throw new Error(`Merge evidence rejected: owner review required for gate changes: ${protectedPaths.join(', ')}`);
	}
}
