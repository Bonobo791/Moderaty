import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channelAllowedHandles, channels, comments, moderationActions } from '$lib/server/db/schema';
import { loadProtectedIdentities } from './allowlist';
import { decide } from './pipeline/decisions';
import { stageDecisions } from './pipeline/staging';
import { runEnforcement } from './pipeline/enforcement';
import { prepareRules } from './rules';

setupTestDb(['channels', 'channel_allowed_handles', 'comments', 'moderation_actions', 'audit_log']);
beforeEach(async () => {
	vi.stubGlobal('fetch', async () => Response.json({items:[{id:'protected-author'}]}));
	await testDb().db.insert(channels).values({ id: 'owner', title: 'Synthetic Channel', refreshTokenEnc: 'synthetic-grant' });
});
afterEach(() => vi.unstubAllGlobals());
const resolver = async () => 'protected-author';
const stage = (decisions: Parameters<typeof stageDecisions>[1]) => stageDecisions('owner', decisions, {accessToken:'synthetic-token'});
const rules = prepareRules([{ id: 1, type: 'keyword', pattern: 'ban-trigger', action: 'ban' }]);
const options = { protections: { protectLgbtqia: 0, protectWomen: 0 }, deadline: undefined, openAiKey: undefined };
const comment = { id: 'protected-comment', threadId: 'thread', videoId: null, authorChannelId: 'protected-author', authorName: 'Different Display Name', text: 'ban-trigger', publishedAt: '2026-10-09T00:00:00Z' };

test('new protection replaces a stale ban before staging, with an unprotected ban control', async () => {
	const snapshot = await loadProtectedIdentities('owner');
	const decisions = await Promise.all([comment, { ...comment, id: 'control-comment', authorChannelId: 'other-author' }].map(c => decide(c, rules, snapshot, null, { remaining: 0 }, options)));
	expect(decisions.map(d => d.youtubeAction)).toEqual(['ban', 'ban']);
	// The owner's verification commits after the scoring snapshot was taken.
	await testDb().db.insert(channelAllowedHandles).values({ channelId: 'owner', handle: 'protected_handle' });
	expect(await stage(decisions)).toMatchObject({ acted: 1, queued: 0 });
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([expect.objectContaining({ commentId: 'control-comment', action: 'ban', state: 'pending' })]);
	expect(await testDb().db.select().from(comments).all()).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: 'protected-comment', status: 'approved', decidedBy: 'allowlist', authorName: null, authorChannelId: null }),
		expect.objectContaining({ id: 'control-comment', status: 'rejected', decidedBy: 'rule' })
	]));
	expect(await testDb().db.select().from(auditLog).all()).toEqual([expect.objectContaining({ commentId: 'protected-comment', authorHandle: 'protected_handle', reason: 'protected handle' })]);
	const writes: string[] = [];
	// Only the external YouTube HTTP boundary is replaced. Enforcement and
	// completion transactions remain real, and any unexpected request fails.
	vi.stubGlobal('fetch', async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		expect(url.origin).toBe('https://www.googleapis.com');
		if (url.pathname === '/youtube/v3/channels') return Response.json({items:[{id:'protected-author'}]});
		if (url.pathname === '/youtube/v3/comments') return Response.json({items:[{id:'control-comment',snippet:{authorChannelId:{value:'other-author'}}}]});
		expect(url.pathname).toBe('/youtube/v3/comments/setModerationStatus');
		writes.push(url.href);
		return new Response(null, { status: 204 });
	});
	expect(await runEnforcement('owner', 'synthetic-token', undefined, null, 0)).toMatchObject({ acted: 1 });
	expect(writes).toHaveLength(1);
	expect(new URL(writes[0]).searchParams.get('id')).toBe('control-comment');
	expect(new URL(writes[0]).searchParams.get('banAuthor')).toBe('true');
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([expect.objectContaining({ commentId: 'control-comment', action: 'ban', state: 'completed' })]);
});

test('new unresolved protection replaces stale destructive actions with review holds', async () => {
	const stale = await decide(comment, rules, await loadProtectedIdentities('owner', undefined, resolver), null, { remaining: 0 }, options);
	expect(stale.youtubeAction).toBe('ban');
	await testDb().db.insert(channelAllowedHandles).values({ channelId: 'owner', handle: 'unresolved_handle' });
	vi.stubGlobal('fetch', async () => new Response('synthetic-provider-outage', {status:503}));
	expect(await stage([stale])).toMatchObject({ acted: 1, queued: 1 });
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([expect.objectContaining({ action: 'hold' })]);
	expect(await testDb().db.select().from(comments).all()).toEqual([expect.objectContaining({ status: 'pending', decidedBy: 'none' })]);
});

test('removing protection after scoring queues the stale approval and clears its protection label', async () => {
	await testDb().db.insert(channelAllowedHandles).values({channelId: 'owner', handle: 'protected_handle'});
	const stale = await decide(comment, rules, await loadProtectedIdentities('owner', undefined, resolver), null, {remaining: 0}, options);
	expect(stale.decidedBy).toBe('allowlist');
	await testDb().db.delete(channelAllowedHandles);
	expect(await stage([stale])).toMatchObject({acted: 1, queued: 1});
	expect(await testDb().db.select().from(comments).all()).toEqual([expect.objectContaining({status: 'pending', decidedBy: 'none'})]);
	expect(await testDb().db.select().from(auditLog).all()).toEqual([expect.objectContaining({action: 'queue', authorHandle: null})]);
});

test('a protection added after staging supersedes a pending ban before YouTube dispatch', async () => {
	const stale = await decide(comment, rules, await loadProtectedIdentities('owner'), null, {remaining:0}, options);
	await stage([stale]);
	await testDb().db.insert(channelAllowedHandles).values({channelId:'owner', handle:'protected_handle'});
	const writes: string[] = [];
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (init?.method === 'POST') {writes.push(url.href); return new Response(null, {status:204});}
		if (url.pathname.endsWith('/channels')) return Response.json({items:[{id:'protected-author'}]});
		if (url.pathname.endsWith('/comments')) return Response.json({items:[{id:comment.id,snippet:{authorChannelId:{value:'protected-author'}}}]});
		throw new Error('Unexpected provider request');
	});
	expect(await runEnforcement('owner', 'synthetic-token', undefined, null, 0)).toMatchObject({acted:0});
	expect(writes).toEqual([]);
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([expect.objectContaining({state:'superseded', action:'ban'})]);
	expect(await testDb().db.select().from(comments).all()).toEqual([expect.objectContaining({status:'approved', decidedBy:'allowlist'})]);
});

test('new protection cancels a dispatched ban before it can be retried', async () => {
	const stale = await decide(comment, rules, await loadProtectedIdentities('owner'), null, {remaining:0}, options);
	await stage([stale]);
	await testDb().db.update(moderationActions).set({state:'dispatched'});
	await testDb().db.insert(channelAllowedHandles).values({channelId:'owner',handle:'protected_handle'});
	const writes: URL[] = [];
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (init?.method === 'POST') {writes.push(url); return new Response(null,{status:204});}
		if (url.pathname.endsWith('/channels')) return Response.json({items:[{id:'protected-author',snippet:{customUrl:'@protected_handle'}}]});
		if (url.pathname.endsWith('/comments')) return Response.json({items:[{id:comment.id,snippet:{authorChannelId:{value:'protected-author'}}}]});
		throw new Error('Unexpected provider request');
	});
	await runEnforcement('owner','synthetic-token',undefined,null,0);
	expect(writes).toEqual([]);
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([expect.objectContaining({state:'cancelling'})]);
	await runEnforcement('owner','synthetic-token',undefined,null,0);
	expect(writes.map(url=>url.searchParams.get('moderationStatus'))).toEqual(['published']);
	expect(writes.every(url=>url.searchParams.get('banAuthor') !== 'true')).toBe(true);
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([expect.objectContaining({state:'superseded'})]);
});

test('author lookup outage still applies unrelated holds while retaining destructive intents for retry', async () => {
	const stale = await decide(comment, rules, await loadProtectedIdentities('owner'), null, {remaining:0}, options);
	await stage([stale, {...stale, comment:{...comment,id:'safe-hold'},status:'held',youtubeAction:'hold'}]);
	await testDb().db.insert(channelAllowedHandles).values({channelId:'owner',handle:'protected_handle'});
	const writes: URL[] = [];
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (init?.method === 'POST') {writes.push(url);return new Response(null,{status:204});}
		return new Response('synthetic-quota-outage',{status:403});
	});
	await expect(runEnforcement('owner','synthetic-token',undefined,null,0)).rejects.toThrow('403');
	expect(writes.map(url=>url.searchParams.get('moderationStatus'))).toEqual(['heldForReview']);
	expect(await testDb().db.select().from(moderationActions).all()).toEqual(expect.arrayContaining([
		expect.objectContaining({commentId:comment.id,state:'pending',action:'ban'}),
		expect.objectContaining({commentId:'safe-hold',state:'completed',action:'hold'})
	]));
});
