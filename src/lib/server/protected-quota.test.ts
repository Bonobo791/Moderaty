import { afterEach, beforeEach, expect, test, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({env:{DRY_RUN:'false', ENCRYPTION_KEY:'synthetic-quota-key', GOOGLE_CLIENT_ID:'synthetic-client', GOOGLE_CLIENT_SECRET:'synthetic-secret'}}));
import { setupTestDb, testDb } from './testdb';
import { channels, channelAllowedHandles, rules, moderationActions, auditLog } from './db/schema';
import { DeadlineExceededError } from './http';
import { encrypt } from './crypto';
import { runChannel } from './pipeline/run';

setupTestDb(['channels','channel_allowed_handles','rules','comments','moderation_actions','audit_log']);
let page: unknown[];
let lookups: string[];
let writes: string[];
let enrichmentFailure: Error | number | undefined;
beforeEach(async () => {
	page = []; lookups = []; writes = []; enrichmentFailure = undefined;
	await testDb().db.insert(channels).values({id:'owner',title:'Synthetic',refreshTokenEnc:encrypt('synthetic-grant')});
	await testDb().db.insert(channelAllowedHandles).values({channelId:'owner',handle:'protected_handle'});
	await testDb().db.insert(rules).values({channelId:'owner',type:'keyword',pattern:'ban-trigger',action:'ban'});
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === '/token') return Response.json({access_token:'synthetic-token'});
		if (url.pathname.endsWith('/commentThreads')) return Response.json({items:page});
		if (url.pathname.endsWith('/channels')) {
			if (url.searchParams.has('forHandle')) {lookups.push(url.searchParams.get('forHandle')!); return Response.json({items:[{id:'protected-author'}]});}
			if (enrichmentFailure instanceof Error) throw enrichmentFailure;
			if (enrichmentFailure) return new Response('synthetic-enrichment-failure',{status:enrichmentFailure});
			return Response.json({items:[{id:'ordinary-author',snippet:{customUrl:'@ordinary_handle'}}]});
		}
		if (url.pathname.endsWith('/comments')) return Response.json({items:[{id:'ordinary-comment',snippet:{authorChannelId:{value:'ordinary-author'}}}]});
		if (url.pathname.endsWith('/setModerationStatus') && init?.method === 'POST') {writes.push(url.href); return new Response(null,{status:204});}
		throw new Error('Unexpected provider request');
	});
});

test.each([false,true])('audit enrichment failure does not prevent rule moderation (configured=%s)', async configured => {
	if (!configured) await testDb().db.delete(channelAllowedHandles);
	enrichmentFailure = 403;
	page = [{id:'thread',snippet:{topLevelComment:{id:'ordinary-comment',snippet:{authorChannelId:{value:'ordinary-author'},authorDisplayName:'Different Name',textDisplay:'ban-trigger',publishedAt:'2026-10-09T00:00:00Z'}}}}];
	expect(await runChannel('owner',{forceDryRun:false})).toMatchObject({fetched:1,acted:1,partial:false,handleLookupError:true});
	expect(writes).toHaveLength(1);
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([expect.objectContaining({state:'completed',action:'ban'})]);
	expect(await testDb().db.select().from(auditLog).all()).toEqual([expect.objectContaining({action:'ban',authorHandle:null})]);
});

test('audit enrichment deadline still stops the run before any moderation write', async () => {
	enrichmentFailure = new DeadlineExceededError();
	page = [{id:'thread',snippet:{topLevelComment:{id:'ordinary-comment',snippet:{authorChannelId:{value:'ordinary-author'},authorDisplayName:'Different Name',textDisplay:'ban-trigger',publishedAt:'2026-10-09T00:00:00Z'}}}}];
	expect(await runChannel('owner',{forceDryRun:false})).toMatchObject({partial:true,stoppedReason:'deadline'});
	expect(writes).toEqual([]);
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([]);
});

test('a background preview persists missing-handle warnings in its visible audit reason', async () => {
	enrichmentFailure = 403;
	page = [{id:'thread',snippet:{topLevelComment:{id:'ordinary-comment',snippet:{authorChannelId:{value:'ordinary-author'},textDisplay:'ban-trigger',publishedAt:'2026-10-09T00:00:00Z'}}}}];
	expect(await runChannel('owner',{forceDryRun:true,window:{boundary:'2026-01-01T00:00:00Z',pageToken:null}})).toMatchObject({dryRun:true,partial:false,handleLookupError:true});
	expect(writes).toEqual([]);
	expect(await testDb().db.select().from(auditLog).all()).toEqual([expect.objectContaining({action:'dry-run',authorHandle:null,reason:expect.stringContaining('YouTube author handles could not be loaded; moderation continued, but some audit entries have no handle.')})]);
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
	expect(lookups).toEqual([]);
	expect(writes).toHaveLength(1);
	expect(new URL(writes[0]).searchParams.get('banAuthor')).toBe('true');
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([expect.objectContaining({state:'completed',action:'ban'})]);
	lookups = []; writes = [];
	expect(await runChannel('owner',{forceDryRun:false})).toMatchObject({acted:0,partial:false});
	expect(lookups).toEqual([]);
	expect(writes).toEqual([]);
});

test('100 configured handles do not require per-handle lookups for verified page authors', async () => {
	await testDb().db.insert(channelAllowedHandles).values(Array.from({length:99},(_,index)=>({channelId:'owner',handle:`protected_${index}`})));
	page = [{id:'thread',snippet:{topLevelComment:{id:'ordinary-comment',snippet:{authorChannelId:{value:'ordinary-author'},textDisplay:'ban-trigger',publishedAt:'2026-10-09T00:00:00Z'}}}}];
	expect(await runChannel('owner',{forceDryRun:false})).toMatchObject({acted:1,partial:false});
	expect(lookups).toEqual([]);
	expect(writes).toHaveLength(1);
});
