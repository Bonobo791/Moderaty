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

import { eq } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { ENCRYPTION_KEY: 'test-encryption-key' } as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

// testdb must be the first app import: it registers the $lib/server/db mock
// before any module that binds the real database (see its header comment).
import { postForm, setupTestDb, TEST_OWNER, testDb } from '$lib/server/testdb';
import { invites, memberships, organizations, sessions, users } from '$lib/server/db/schema';
import { decrypt } from '$lib/server/crypto';
import { SESSION_COOKIE, type SessionUser } from '$lib/server/session';
import { makeCookies } from '$lib/server/testcookies';

import { actions, load } from './+page.server';

setupTestDb(['sessions', 'invites', 'memberships', 'organizations', 'users']);

const MEMBER: SessionUser = { ...TEST_OWNER, orgRole: 'member' };
const ADMIN: SessionUser = { ...TEST_OWNER, orgRole: 'admin' };

async function seedOwnerOrg() {
	await testDb()
		.db.insert(users)
		.values({ id: TEST_OWNER.id, googleSub: 'sub-user-1', email: TEST_OWNER.email, displayName: TEST_OWNER.displayName });
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'One' });
	await testDb().db.insert(memberships).values({ userId: TEST_OWNER.id, orgId: 'org-1', role: 'owner' });
}

/** Adds a second user as a member of org-1 (shares user-1's session fixtures as needed). */
async function seedTeammate(userId: string, role: 'admin' | 'member' = 'member') {
	await testDb()
		.db.insert(users)
		.values({ id: userId, googleSub: `sub-${userId}`, email: `${userId}@example.com`, displayName: userId });
	await testDb().db.insert(memberships).values({ userId, orgId: 'org-1', role });
}

function ctx(user: SessionUser | null, fields: Record<string, string> = {}, withCookie = true) {
	const cookies = makeCookies();
	if (withCookie) cookies.set(SESSION_COOKIE, 'sess-1', { path: '/' });
	return {
		request: postForm(fields, 'http://localhost/org'),
		locals: { user },
		cookies,
		url: new URL('http://localhost/org')
	} as never;
}

function failure(result: unknown): { status: number; data: { error: string } } {
	return result as { status: number; data: { error: string } };
}

test('load: a database outage returns the maintenance payload instead of a 401', async () => {
	// The layout renders the overlay; the org load must not throw on the
	// null-user outage shape.
	const outageCtx = { locals: { user: null, dbDown: true }, url: new URL('http://localhost/org') } as never;
	const data = (await load(outageCtx)) as {
		maintenance: boolean;
		members: unknown[];
		invites: unknown[];
		user: unknown;
		inviteBase: string;
		hasOpenAiKey: boolean;
	};
	expect(data.maintenance).toBe(true);
	expect(data.user).toBeNull();
	expect(data.members).toEqual([]);
	expect(data.invites).toEqual([]);
	expect(data.inviteBase).toBe('http://localhost/invite/');
	expect(data.hasOpenAiKey).toBe(false);
});

test('load: 401 signed out; members get the roster but no invites; admins get open invites', async () => {
	await seedOwnerOrg();
	await seedTeammate('user-2');
	await testDb().db.insert(invites).values({
		token: 'tok-1',
		orgId: 'org-1',
		role: 'member',
		createdBy: TEST_OWNER.id,
		expiresAt: '2099-01-01T00:00:00.000Z'
	});

	await expect(load(ctx(null))).rejects.toMatchObject({ status: 401 });

	const ownerView = (await load(ctx(TEST_OWNER))) as { members: unknown[]; invites: unknown[]; inviteBase: string };
	expect(ownerView.members).toHaveLength(2);
	expect(ownerView.invites).toHaveLength(1);
	expect(ownerView.inviteBase).toBe('http://localhost/invite/');

	const memberView = (await load(ctx(MEMBER))) as { members: unknown[]; invites: unknown[] };
	expect(memberView.members).toHaveLength(2);
	expect(memberView.invites).toEqual([]); // member role never sees invite management

	const adminView = (await load(ctx(ADMIN))) as { members: unknown[]; invites: unknown[] };
	expect(adminView.members).toHaveLength(2);
	expect(adminView.invites).toHaveLength(1); // admins see invite management, same as owners
});

test('load: a membership whose org row vanished still renders with hasOpenAiKey false instead of throwing', async () => {
	// The key lookup is a separate query from the roster; a missing org row
	// (data bug) must degrade to the boolean, never crash the page.
	await seedOwnerOrg();
	await testDb().client.execute('PRAGMA foreign_keys = OFF');
	try {
		await testDb().db.delete(organizations).where(eq(organizations.id, 'org-1'));
	} finally {
		await testDb().client.execute('PRAGMA foreign_keys = ON');
	}
	const view = (await load(ctx(TEST_OWNER))) as { members: unknown[]; hasOpenAiKey: boolean };
	expect(view.members).toHaveLength(1);
	expect(view.hasOpenAiKey).toBe(false);
});

test('rename: member is a raw 403; owner errors are wrapped as form failures', async () => {
	await seedOwnerOrg();
	await expect(actions.rename(ctx(MEMBER, { name: 'New' }))).rejects.toMatchObject({ status: 403 });

	const bad = failure(await actions.rename(ctx(TEST_OWNER, { name: '' })));
	expect(bad.status).toBe(400);
	expect(bad.data.error).toContain('1–80');

	const missing = failure(await actions.rename(ctx(TEST_OWNER, {})));
	expect(missing.status).toBe(400);

	await actions.rename(ctx(TEST_OWNER, { name: 'Renamed' }));
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.name).toBe('Renamed');
});

test('createTeam: bad name fails loudly; success creates a shared org the user owns', async () => {
	await seedOwnerOrg();
	const bad = failure(await actions.createTeam(ctx(TEST_OWNER, { name: '   ' })));
	expect(bad.status).toBe(400);

	const missing = failure(await actions.createTeam(ctx(TEST_OWNER, {})));
	expect(missing.status).toBe(400);

	await actions.createTeam(ctx(TEST_OWNER, { name: 'Second Team' }));
	const mine = await testDb().db.select().from(memberships).where(eq(memberships.userId, TEST_OWNER.id)).all();
	expect(mine).toHaveLength(2);
	const created = mine.find((m) => m.orgId !== 'org-1');
	const newOrg = await testDb().db.select().from(organizations).where(eq(organizations.id, created!.orgId)).get();
	expect(newOrg?.name).toBe('Second Team');
	expect(newOrg?.personalFor).toBeNull();
});

test('invite: member is 403; bad role is a 400 failure; success returns the token', async () => {
	await seedOwnerOrg();
	await expect(actions.invite(ctx(MEMBER, { role: 'member' }))).rejects.toMatchObject({ status: 403 });

	const badRole = failure(await actions.invite(ctx(TEST_OWNER, { role: 'owner' })));
	expect(badRole.status).toBe(400);
	expect(badRole.data.error).toBe('role must be admin or member');

	const good = (await actions.invite(ctx(TEST_OWNER, { role: 'admin' }))) as { ok: true; inviteToken: string };
	expect(good.ok).toBe(true);
	const row = await testDb().db.select().from(invites).where(eq(invites.token, good.inviteToken)).get();
	expect(row?.role).toBe('admin');

	// A member invite is valid too, and a missing role field defaults to member.
	const memberInvite = (await actions.invite(ctx(TEST_OWNER, { role: 'member' }))) as {
		ok: true;
		inviteToken: string;
	};
	const memberRow = await testDb().db.select().from(invites).where(eq(invites.token, memberInvite.inviteToken)).get();
	expect(memberRow?.role).toBe('member');

	const defaulted = (await actions.invite(ctx(TEST_OWNER, {}))) as { ok: true; inviteToken: string };
	const defaultedRow = await testDb().db.select().from(invites).where(eq(invites.token, defaulted.inviteToken)).get();
	expect(defaultedRow?.role).toBe('member');
});

test('invite: a corrupted membership role rethrows raw through guard instead of a fake form failure', async () => {
	// memberships.role has no CHECK constraint; a corrupt value is a data bug
	// and must propagate (asOrgRole's plain Error), not be swallowed into a
	// status-less ActionFailure.
	await seedOwnerOrg();
	await testDb()
		.db.insert(users)
		.values({ id: 'user-9', googleSub: 'sub-user-9', email: 'user-9@example.com', displayName: 'user-9' });
	await testDb().db.insert(memberships).values({ userId: 'user-9', orgId: 'org-1', role: 'bogus' });
	const corrupted: SessionUser = { ...TEST_OWNER, id: 'user-9' };
	await expect(actions.invite(ctx(corrupted, { role: 'member' }))).rejects.toThrow(
		'unknown membership role: bogus'
	);
});

test('revokeInvite: member is 403; unknown token is a wrapped 404', async () => {
	await seedOwnerOrg();
	await expect(actions.revokeInvite(ctx(MEMBER, { token: 'tok-1' }))).rejects.toMatchObject({ status: 403 });
	const gone = failure(await actions.revokeInvite(ctx(TEST_OWNER, { token: 'tok-nope' })));
	expect(gone.status).toBe(404);

	// A missing token field takes the same 404 path as any nonexistent token.
	const noField = failure(await actions.revokeInvite(ctx(TEST_OWNER, {})));
	expect(noField.status).toBe(404);
});

test('revokeInvite: owner revokes an open invite by token', async () => {
	await seedOwnerOrg();
	await testDb().db.insert(invites).values({
		token: 'tok-1',
		orgId: 'org-1',
		role: 'member',
		createdBy: TEST_OWNER.id,
		expiresAt: '2099-01-01T00:00:00.000Z'
	});
	await actions.revokeInvite(ctx(TEST_OWNER, { token: 'tok-1' }));
	const gone = await testDb().db.select().from(invites).where(eq(invites.token, 'tok-1')).get();
	expect(gone).toBeUndefined();
});

test('setRole: non-owner is 403; last-owner demotion is a wrapped 400', async () => {
	await seedOwnerOrg();
	const admin: SessionUser = { ...TEST_OWNER, orgRole: 'admin' };
	await expect(actions.setRole(ctx(admin, { userId: 'user-2', role: 'member' }))).rejects.toMatchObject({ status: 403 });

	const demote = failure(await actions.setRole(ctx(TEST_OWNER, { userId: TEST_OWNER.id, role: 'member' })));
	expect(demote.status).toBe(400);
	expect(demote.data.error).toContain('last owner');

	// A missing userId field is a wrapped 404, never cast through.
	const noTarget = failure(await actions.setRole(ctx(TEST_OWNER, { role: 'admin' })));
	expect(noTarget.status).toBe(404);
});

test('remove: self-removal is a wrapped 400 pointing at Leave team', async () => {
	await seedOwnerOrg();
	const self = failure(await actions.remove(ctx(TEST_OWNER, { userId: TEST_OWNER.id })));
	expect(self.status).toBe(400);
	expect(self.data.error).toContain('Leave team');

	// A missing userId field is a wrapped 404, never cast through.
	const noTarget = failure(await actions.remove(ctx(TEST_OWNER, {})));
	expect(noTarget.status).toBe(404);

	await seedTeammate('user-2');
	await actions.remove(ctx(TEST_OWNER, { userId: 'user-2' }));
	const gone = await testDb()
		.db.select()
		.from(memberships)
		.where(eq(memberships.userId, 'user-2'))
		.all();
	expect(gone).toHaveLength(0);
});

test('leave: missing cookie fails 401; sole member is a wrapped 400', async () => {
	await seedOwnerOrg();
	const noCookie = failure(await actions.leave(ctx(TEST_OWNER, {}, false)));
	expect(noCookie.status).toBe(401);
	expect(noCookie.data.error).toBe('sign-in required');

	const sole = failure(await actions.leave(ctx(TEST_OWNER)));
	expect(sole.status).toBe(400);
	expect(sole.data.error).toContain('only member');
});

test('leave: a successful leave 303s to the dashboard (post-leave /org would 404 on the stale locals)', async () => {
	// PR #52 review (Codacy): locals are frozen for the request, so rendering
	// /org after leaving the active team would re-list members of the team the
	// user just left and 404. Redirect to a fresh request instead.
	await seedOwnerOrg();
	// A second owner in org-1, so leaving is permitted.
	await testDb()
		.db.insert(users)
		.values({ id: 'user-2', googleSub: 'sub-user-2', email: 'user-2@example.com', displayName: 'user-2' });
	await testDb().db.insert(memberships).values({ userId: 'user-2', orgId: 'org-1', role: 'owner' });
	await testDb()
		.db.insert(sessions)
		.values({ id: 'sess-1', userId: TEST_OWNER.id, activeOrgId: 'org-1', expiresAt: '2099-01-01T00:00:00.000Z' });

	await expect(actions.leave(ctx(TEST_OWNER))).rejects.toMatchObject({ status: 303, location: '/dashboard' });
	const gone = await testDb().db.select().from(memberships).where(eq(memberships.userId, TEST_OWNER.id)).all();
	expect(gone).toHaveLength(0);
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get();
	expect(sess?.activeOrgId).toBeNull();
});

test('setRole: an invalid role from the form is a wrapped 400, never cast through', async () => {
	// PR #52 review (CodeRabbit): the action passed a raw form string into
	// setMemberRole; the lib rejects unknown roles, and the route must surface
	// that as a form failure.
	await seedOwnerOrg();
	await seedTeammate('user-2');
	const bad = failure(await actions.setRole(ctx(TEST_OWNER, { userId: 'user-2', role: 'superadmin' })));
	expect(bad.status).toBe(400);
	const kept = await testDb().db.select().from(memberships).where(eq(memberships.userId, 'user-2')).all();
	expect(kept[0].role).toBe('member');
});

test('remove: a member caller is 403 at the route, same as the other admin-gated actions', async () => {
	// PR #52 review (CodeRabbit): remove was the only admin-gated action
	// without a route-level requireOrgRole.
	await seedOwnerOrg();
	await seedTeammate('user-2');
	await expect(actions.remove(ctx(MEMBER, { userId: 'user-2' }))).rejects.toMatchObject({ status: 403 });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Stubs global fetch (the live OpenAI key check) and records each call. */
function stubOpenAi(status: number) {
	const calls: { url: unknown; init: RequestInit | undefined }[] = [];
	vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
		calls.push({ url, init });
		return new Response('{}', { status });
	});
	return calls;
}

async function storedKey(orgId = 'org-1') {
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, orgId)).get();
	return org?.openaiKeyEnc ?? null;
}

test('setOpenAiKey: owner stores an encrypted key after live validation; the page only ever exposes a boolean', async () => {
	await seedOwnerOrg();
	const calls = stubOpenAi(200);

	const res = await actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: 'sk-test-org-key' }));
	expect(res).toMatchObject({ ok: true });

	const ciphertext = await storedKey();
	expect(ciphertext).toBeTruthy();
	expect(ciphertext).not.toContain('sk-test-org-key');
	expect(decrypt(ciphertext!)).toBe('sk-test-org-key');
	expect(calls[0].url).toBe('https://api.openai.com/v1/models');
	expect(calls[0].init?.headers).toMatchObject({ authorization: 'Bearer sk-test-org-key' });

	// Never serialize secrets to the client: only the boolean leaves the server.
	const view = (await load(ctx(TEST_OWNER))) as Record<string, unknown>;
	expect(view.hasOpenAiKey).toBe(true);
	const serialized = JSON.stringify(view);
	expect(serialized).not.toContain('sk-test-org-key');
	expect(serialized).not.toContain(ciphertext!);
});

test('setOpenAiKey: non-owner is 403 and nothing is stored or validated', async () => {
	await seedOwnerOrg();
	const calls = stubOpenAi(200);
	await expect(actions.setOpenAiKey(ctx(MEMBER, { openAiKey: 'sk-x' }))).rejects.toMatchObject({ status: 403 });
	expect(await storedKey()).toBeNull();
	expect(calls).toHaveLength(0);
});

test('setOpenAiKey: a key without the sk- prefix fails 400 before any OpenAI call', async () => {
	await seedOwnerOrg();
	const calls = stubOpenAi(200);
	const bad = failure(await actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: 'not-a-key' })));
	expect(bad.status).toBe(400);
	expect(bad.data.error).toBe('Enter a valid OpenAI API key (it starts with sk-).');
	expect(await storedKey()).toBeNull();
	expect(calls).toHaveLength(0);

	// A missing field fails the same way.
	const missing = failure(await actions.setOpenAiKey(ctx(TEST_OWNER, {})));
	expect(missing.status).toBe(400);
	expect(missing.data.error).toBe('Enter a valid OpenAI API key (it starts with sk-).');
});

test('setOpenAiKey: surrounding whitespace is trimmed before validation and storage', async () => {
	await seedOwnerOrg();
	const calls = stubOpenAi(200);
	const res = await actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: '  sk-trimmed-key  ' }));
	expect(res).toMatchObject({ ok: true });
	expect(decrypt((await storedKey())!)).toBe('sk-trimmed-key');
	expect(calls[0].init?.headers).toMatchObject({ authorization: 'Bearer sk-trimmed-key' });
});

test('setOpenAiKey: keys over 200 characters are rejected; exactly 200 is accepted', async () => {
	await seedOwnerOrg();
	const calls = stubOpenAi(200);
	const tooLong = failure(await actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: `sk-${'x'.repeat(198)}` })));
	expect(tooLong.status).toBe(400);
	expect(tooLong.data.error).toBe('Enter a valid OpenAI API key (it starts with sk-).');
	expect(await storedKey()).toBeNull();

	const boundary = await actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: `sk-${'x'.repeat(197)}` }));
	expect(boundary).toMatchObject({ ok: true });
	expect(decrypt((await storedKey())!)).toBe(`sk-${'x'.repeat(197)}`);
	// Only the boundary key reached OpenAI; the over-long key never left the server.
	expect(calls).toHaveLength(1);
});

test('setOpenAiKey: OpenAI rejecting the key fails 400 and stores nothing', async () => {
	await seedOwnerOrg();
	stubOpenAi(401);
	const bad = failure(await actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: 'sk-bad-key' })));
	expect(bad.status).toBe(400);
	expect(bad.data.error).toBe('OpenAI rejected that key — check it and try again.');
	expect(await storedKey()).toBeNull();
});

test('setOpenAiKey: OpenAI forbidding the key (403) fails 400 and stores nothing', async () => {
	await seedOwnerOrg();
	stubOpenAi(403);
	const bad = failure(await actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: 'sk-forbidden' })));
	expect(bad.status).toBe(400);
	expect(bad.data.error).toBe('OpenAI rejected that key — check it and try again.');
	expect(await storedKey()).toBeNull();
});

test('setOpenAiKey: an OpenAI server error fails 502, logs the status, and stores nothing', async () => {
	await seedOwnerOrg();
	stubOpenAi(500);
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.useFakeTimers();
	try {
		const pending = actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: 'sk-server-error' }));
		await vi.advanceTimersByTimeAsync(20_000); // fetchWithRetry backoff on 5xx
		const bad = failure(await pending);
		expect(bad.status).toBe(502);
		expect(bad.data.error).toBe('OpenAI could not validate the key right now — try again in a moment.');
	} finally {
		vi.useRealTimers();
	}
	expect(await storedKey()).toBeNull();
	expect(spy).toHaveBeenCalledWith('OpenAI key validation returned a non-OK status:', 500);
});

test('setOpenAiKey: an unreachable OpenAI fails 502 and logs only a message, never the key or a raw error object', async () => {
	// CWE-532: the caught fetch error is an object whose dump can carry request
	// detail; the log must be a plain message string so the key can never leak.
	await seedOwnerOrg();
	vi.stubGlobal('fetch', async () => {
		throw new Error('fetch failed');
	});
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.useFakeTimers();
	try {
		const pending = actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: 'sk-secret-key' }));
		await vi.advanceTimersByTimeAsync(20_000); // fetchWithRetry backoff
		const bad = failure(await pending);
		expect(bad.status).toBe(502);
		expect(bad.data.error).toBe('Could not reach OpenAI to validate the key — try again in a moment.');
	} finally {
		vi.useRealTimers();
	}
	expect(await storedKey()).toBeNull();
	expect(spy).toHaveBeenCalled();
	expect(spy).toHaveBeenCalledWith('OpenAI key validation request failed:', 'fetch failed');
	for (const call of spy.mock.calls) {
		for (const arg of call) expect(arg).not.toBeInstanceOf(Error);
		expect(JSON.stringify(call)).not.toContain('sk-secret-key');
	}
});

test('clearOpenAiKey: owner wipes the stored key; non-owner is 403', async () => {
	await seedOwnerOrg();
	stubOpenAi(200);
	await actions.setOpenAiKey(ctx(TEST_OWNER, { openAiKey: 'sk-test-org-key' }));
	expect(await storedKey()).toBeTruthy();

	await expect(actions.clearOpenAiKey(ctx(MEMBER))).rejects.toMatchObject({ status: 403 });
	expect(await storedKey()).toBeTruthy();

	const cleared = await actions.clearOpenAiKey(ctx(TEST_OWNER));
	expect(cleared).toMatchObject({ ok: true });
	expect(await storedKey()).toBeNull();
	const view = (await load(ctx(TEST_OWNER))) as { hasOpenAiKey: boolean };
	expect(view.hasOpenAiKey).toBe(false);
});
