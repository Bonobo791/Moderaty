import { afterEach, beforeEach, expect, test, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({env:{DRY_RUN:'false', ENCRYPTION_KEY:'synthetic-quota-key', GOOGLE_CLIENT_ID:'synthetic-client', GOOGLE_CLIENT_SECRET:'synthetic-secret'}}));
import { setupTestDb, testDb } from './testdb';
import { channels, channelAllowedHandles, rules, moderationActions } from './db/schema';
import { encrypt } from './crypto';
import { runChannel } from './pipeline/run';

setupTestDb(['channels','channel_allowed_handles','rules','comments','moderation_actions','audit_log']);
let page: unknown[];
let lookups: string[];
let writes: string[];
beforeEach(async () => {
	page = []; lookups = []; writes = [];
	await testDb().db.insert(channels).values({id:'owner',title:'Synthetic',refreshTokenEnc:encrypt('synthetic-grant')});
	await testDb().db.insert(channelAllowedHandles).values({channelId:'owner',handle:'protected_handle'});
	await testDb().db.insert(rules).values({channelId:'owner',type:'keyword',pattern:'ban-trigger',action:'ban'});
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === '/token') return Response.json({access_token:'synthetic-token'});
		if (url.pathname.endsWith('/commentThreads')) return Response.json({items:page});
		if (url.pathname.endsWith('/channels')) {
			if (url.searchParams.has('forHandle')) {lookups.push(url.searchParams.get('forHandle')!); return Response.json({items:[{id:'protected-author'}]});}
			return Response.json({items:[{id:'ordinary-author',snippet:{customUrl:'@ordinary_handle'}}]});
		}
		if (url.pathname.endsWith('/comments')) return Response.json({items:[{id:'ordinary-comment',snippet:{authorChannelId:{value:'ordinary-author'}}}]});
		if (url.pathname.endsWith('/setModerationStatus') && init?.method === 'POST') {writes.push(url.href); return new Response(null,{status:204});}
		throw new Error('Unexpected provider request');
	});
});
afterEach(() => vi.unstubAllGlobals());

test('an idle run makes no protected-handle lookups', async () => {
	expect(await runChannel('owner',{forceDryRun:false})).toMatchObject({fetched:0,acted:0,partial:false});
	expect(lookups).toEqual([]);
	expect(writes).toEqual([]);
});

test('scoring and enforcement share current-run proofs, and a repeated page costs no handle lookup', async () => {
	page = [{id:'thread',snippet:{topLevelComment:{id:'ordinary-comment',snippet:{authorChannelId:{value:'ordinary-author'},authorDisplayName:'Different Name',textDisplay:'ban-trigger',publishedAt:'2026-10-09T00:00:00Z'}}}}];
	expect(await runChannel('owner',{forceDryRun:false})).toMatchObject({fetched:1,acted:1,partial:false});
	expect(lookups).toEqual(['protected_handle']);
	expect(writes).toHaveLength(1);
	expect(new URL(writes[0]).searchParams.get('banAuthor')).toBe('true');
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([expect.objectContaining({state:'completed',action:'ban'})]);
	lookups = []; writes = [];
	expect(await runChannel('owner',{forceDryRun:false})).toMatchObject({acted:0,partial:false});
	expect(lookups).toEqual([]);
	expect(writes).toEqual([]);
});
