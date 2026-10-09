import { beforeEach, expect, test } from 'vitest';
import { setupTestDb, testDb } from '$lib/server/testdb';
import { channelAllowedHandles } from '$lib/server/db/schema';
import { loadProtectedIdentities } from './allowlist';
import { decide } from './pipeline/decisions';
import { prepareRules } from './rules';

setupTestDb(['channel_allowed_handles']);
const comment = { id: 'comment', threadId: 'thread', videoId: null, authorChannelId: 'verified-author', authorName: 'Different Display Name', text: 'ban-trigger', publishedAt: '2026-10-09T00:00:00Z' };
const options = { protections: { protectLgbtqia: 0, protectWomen: 0 }, deadline: undefined, openAiKey: undefined };
let holder: string | null = null;
beforeEach(() => {holder = null;});
async function decision(overrides = {}) {
	return decide({ ...comment, ...overrides }, prepareRules([{ id: 1, type: 'keyword', pattern: 'ban-trigger', action: 'ban' }]), await loadProtectedIdentities('owner', undefined, async () => {if (!holder) throw new Error('Lookup unavailable'); return holder;}), null, { remaining: 0 }, options);
}
async function protect(resolvedChannelId: string | null) {
	holder = resolvedChannelId;
	await testDb().db.insert(channelAllowedHandles).values({ channelId: 'owner', handle: 'protected_handle' });
}
test('verified identity beats a ban rule despite a different display name', async () => {
	await protect('verified-author');
	expect(await decision()).toMatchObject({ decidedBy: 'allowlist', youtubeAction: null, comment: { authorHandle: 'protected_handle' } });
});
test('copying a protected handle into the display name never grants protection', async () => {
	await protect('verified-author');
	expect(await decision({ authorChannelId: 'other-author', authorName: '@protected_handle' })).toMatchObject({ decidedBy: 'rule', youtubeAction: 'ban' });
});
test.each([null, 'verified-author'])('missing author ID queues when protection is configured (%s)', async (identity) => {
	await protect(identity);
	expect(await decision({ authorChannelId: '' })).toMatchObject({ status: 'pending', youtubeAction: 'hold', auditAction: 'queue' });
});
test('an unresolved legacy protection prevents automatic bans', async () => {
	await protect(null);
	expect(await decision()).toMatchObject({ status: 'pending', youtubeAction: 'hold', reason: 'protected identity unresolved' });
});
test('protection configured on another owner channel does not affect this channel', async () => {
	await testDb().db.insert(channelAllowedHandles).values({ channelId: 'other-owner', handle: 'protected_handle' });
	expect(await decision()).toMatchObject({ youtubeAction: 'ban' });
});

test('the newest configured handle labels an identity shared by two entries', async () => {
	holder = 'verified-author';
	await testDb().db.insert(channelAllowedHandles).values([
		{ channelId: 'owner', handle: 'old_handle' },
		{ channelId: 'owner', handle: 'new_handle' }
	]);
	expect(await decision()).toMatchObject({ comment: { authorHandle: 'new_handle' } });
});
