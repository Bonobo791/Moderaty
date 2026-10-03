#!/usr/bin/env node
// Synthetic content only. This command never creates a database or SMTP client.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/preview-welcome-email.mjs OUTPUT_DIRECTORY');
const output = resolve(process.argv[2]);
const variants = {
	'new-owner': [{ role: 'owner', channels: [] }],
	'member-no-channel': [{ role: 'member', channels: [] }],
	'connected-unused': [{ role: 'owner', channels: [{ active: true, previewUsed: false }] }],
	'connected-used': [{ role: 'owner', channels: [{ active: true, previewUsed: true }] }],
	'mixed-teams': [{ role: 'owner', channels: [] }, { role: 'member', channels: [{ active: true, previewUsed: false }] }],
	'mixed-preview-status': [{ role: 'owner', channels: [{ active: true, previewUsed: true }, { active: false, previewUsed: false }] }]
};
const server = await createServer({ logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
	const { buildWelcomeEmail } = await server.ssrLoadModule('/src/lib/server/welcomeEmailTemplate.ts');
	await mkdir(output, { recursive: true });
	await Promise.all(Object.entries(variants).map(async ([name, teams]) => {
		const email = buildWelcomeEmail({ email: 'preview@example.com', displayName: 'Alex & friends', messageId: '<local-preview@moderaty.com>', appUrl: 'https://moderaty.com', teams });
		await Promise.all([
			writeFile(resolve(output, `${name}.html`), email.htmlPart),
			writeFile(resolve(output, `${name}.txt`), `Subject: ${email.subject}\nReply-To: ${email.replyTo}\n\n${email.textPart}\n`)
		]);
	}));
	console.info(`Wrote ${Object.keys(variants).length} synthetic HTML/plain-text pairs to ${output}`);
} finally { await server.close(); }
