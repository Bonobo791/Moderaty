import { test, expect } from './support/fixture';
import { writeFile } from 'node:fs/promises';
import { protectedHandle, protectedDisplayName, protectedAuthorId, controlAuthorId } from './support/youtube-fixtures.mjs';

test('a UI-added protected handle survives reload and prevents a ban despite a different display name', async ({ app, page, context }, testInfo) => {
	const browserErrors: string[] = [];
	const unexpectedBrowserRequests: string[] = [];
	page.on('pageerror', error => browserErrors.push(error.message));
	await context.route('**/*', async route => {
		const url = new URL(route.request().url());
		if (url.origin === app.baseURL) await route.continue();
		else { unexpectedBrowserRequests.push(url.href); await route.abort('blockedbyclient'); }
	});
	await context.addCookies([{ name: 'moderaty_session', value: app.token, url: app.baseURL, httpOnly: true, sameSite: 'Lax' }]);
	await page.goto(`${app.baseURL}/channels/${app.channelId}/rules`);
	await expect(page.getByRole('heading', { name: 'Protected handles', exact: true })).toBeVisible();
	await page.getByRole('textbox', { name: 'Protected handle', exact: true }).fill(protectedHandle);
	await page.getByRole('button', { name: 'Add handle', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Remove protected handle protected_creator', exact: true })).toBeVisible();
	await page.reload();
	await expect(page.getByRole('button', { name: 'Remove protected handle protected_creator', exact: true })).toBeVisible();
	await expect(page.locator('code').filter({ hasText: /^@protected_creator$/ })).toBeVisible();
	expect((await app.state()).handles[0]).not.toHaveProperty('resolvedChannelId');
	expect((await app.state()).handles).toEqual([expect.objectContaining({ channelId: app.channelId, handle: 'protected_creator' })]);
	const screenshotPath = testInfo.outputPath('protected-handle-persisted.png');
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await testInfo.attach('protected-handle-after-reload', { path: screenshotPath, contentType: 'image/png' });
	// The identities must never collapse into matching display-name fixtures.
	expect(protectedDisplayName).not.toBe(protectedHandle);
	expect(protectedAuthorId).not.toBe(controlAuthorId);

	const observed = await app.run();
	const evidencePath = testInfo.outputPath('moderation-evidence.json');
	await writeFile(evidencePath, JSON.stringify(observed, null, 2));
	await testInfo.attach('moderation-evidence', { path: evidencePath, contentType: 'application/json' });
	const banRequests = observed.requests.filter(request => {
		const url = new URL(request.url);
		return request.method === 'POST' && url.pathname === '/youtube/v3/comments/setModerationStatus' && url.searchParams.get('banAuthor') === 'true';
	});
	const bannedIds = banRequests.flatMap(request => (new URL(request.url).searchParams.get('id') ?? '').split(','));

	// Positive control FIRST: prove real rule matching, durable action staging,
	// enforcement and provider serialization ran, before testing an absence.
	expect(observed.comments.find(row => row.id === 'control-comment')).toMatchObject({ status: 'rejected', decidedBy: 'rule' });
	expect(observed.actions.find(row => row.commentId === 'control-comment')).toMatchObject({ action: 'ban', state: 'completed' });
	expect(observed.audits).toContainEqual(expect.objectContaining({ commentId: 'control-comment', action: 'ban', authorHandle:'unprotected_creator' }));
	expect(bannedIds).toContain('control-comment');
	expect(observed.result).toMatchObject({ fetched: 2, queued: 0, partial: false, skipped: false, dryRun: false });
	expect(observed.comments.every(row => row.authorName === null && row.authorChannelId === null)).toBe(true);
	expect(observed.blockedRequests).toEqual([]);
	expect(browserErrors).toEqual([]);
	expect(unexpectedBrowserRequests).toEqual([]);

	// Soft assertions retain every symptom of the same identity mismatch.
	expect.soft(observed.comments.find(row => row.id === 'protected-comment')).toMatchObject({ status: 'approved', decidedBy: 'allowlist' });
	expect.soft(observed.actions.filter(row => row.commentId === 'protected-comment')).toEqual([]);
	expect.soft(bannedIds).not.toContain('protected-comment');
	expect.soft(observed.audits).toContainEqual(expect.objectContaining({ commentId: 'protected-comment', action: 'approve', reason: 'protected handle', authorHandle: 'protected_creator' }));
	expect.soft(observed.result.acted).toBe(1);
});
