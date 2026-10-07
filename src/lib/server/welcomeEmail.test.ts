import { beforeEach, expect, test, vi } from 'vitest';
import { and, eq, DrizzleQueryError } from 'drizzle-orm';
const mocks = vi.hoisted(() => ({
 env: { MODERATY_DEPLOYMENT: 'official-hosted', WELCOME_EMAIL_ENABLED: 'true', APP_URL: 'https://moderaty.com', DRY_RUN: 'false' } as Record<string, string | undefined>,
 send: vi.fn()
}));
vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('./protonMail', async (original) => ({ ...(await original<typeof import('./protonMail')>()), sendProtonMailEmail: mocks.send }));
import { setupTestDb, testDb, seedUser } from './testdb';
import { channels, memberships, organizations, users, welcomeCampaigns, welcomeEmails } from './db/schema';
import { enqueueWelcome, deliverWelcome, sweepWelcomeEmails, previewWelcomeBackfill, backfillWelcomeBatch, WELCOME_CAMPAIGN } from './welcomeEmail';
import { buildWelcomeEmail } from './welcomeEmailTemplate';
import { ProtonMailSubmissionError, ProtonMailPreSubmissionDeadlineError, ProtonMailConfigurationError } from './protonMail';
setupTestDb(['users', 'organizations', 'memberships', 'channels', 'welcome_emails', 'welcome_campaigns', 'welcome_discovery']);
beforeEach(() => {
 mocks.env.MODERATY_DEPLOYMENT = 'official-hosted'; mocks.env.WELCOME_EMAIL_ENABLED = 'true'; mocks.env.APP_URL = 'https://moderaty.com'; mocks.env.DRY_RUN = 'false';
 mocks.send.mockReset().mockResolvedValue({ messageId: '<accepted@moderaty.com>' });
});
const row = (id = 'one') => testDb().db.select().from(welcomeEmails).where(and(eq(welcomeEmails.userId, id), eq(welcomeEmails.campaign, WELCOME_CAMPAIGN))).get();
async function queued(id = 'one') { await seedUser(id); await enqueueWelcome(testDb().db, id, 'signup'); return (await row(id))!; }
const budget = () => Date.now() + 10_000;
async function due(id = 'one') {
 await testDb().db.update(welcomeEmails).set({ nextRetryAt: new Date(0).toISOString(), lastAttemptAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, id));
 await testDb().db.update(welcomeCampaigns).set({ nextAttemptAt: new Date(0).toISOString() });
}

/** A deterministic SMTP barrier shared by race tests; every caller releases it in finally. */
function holdNextSubmission() {
 let release!: () => void; let started!: () => void;
 const ready = new Promise<void>(resolve => { started = resolve; });
 const pending = new Promise<void>(resolve => { release = resolve; });
 mocks.send.mockImplementationOnce(async () => {
  started(); await pending; return { messageId: '<accepted@moderaty.com>' };
 });
 return { ready, release };
}

test('committed queue is unique per campaign, version edits do not reenroll, acceptance follows SMTP', async () => {
 await queued(); await enqueueWelcome(testDb().db, 'one', 'signup');
 expect(await testDb().db.select().from(welcomeEmails)).toHaveLength(1);
 mocks.send.mockImplementationOnce(async () => { expect(await row()).toMatchObject({ state: 'in_flight', attempts: 1, acceptedAt: null }); return { messageId: '<accepted@moderaty.com>' }; });
 expect(await deliverWelcome('one', budget())).toBe('accepted');
 expect(await row()).toMatchObject({ state: 'accepted', acceptedAt: expect.any(String), providerMessageId: '<accepted@moderaty.com>', nextRetryAt: null });
 await enqueueWelcome(testDb().db, 'one', 'signup'); await deliverWelcome('one', budget());
 expect(mocks.send).toHaveBeenCalledTimes(1);
});
test('a rolled-back transaction cannot leave a welcome intent', async () => {
 await seedUser('one');
 await expect(testDb().db.transaction(async tx => { await enqueueWelcome(tx, 'one', 'signup'); throw new Error('rollback'); })).rejects.toThrow('rollback');
 expect(await row()).toBeUndefined(); expect(mocks.send).not.toHaveBeenCalled();
});
test('uses the current account address and no consent-log address', async () => {
 await queued(); await testDb().db.update(users).set({ email: 'changed@example.com' }).where(eq(users.id, 'one'));
 await deliverWelcome('one', budget()); expect(mocks.send.mock.calls[0][0].toEmail).toBe('changed@example.com');
});
test.each(['sub@accounts.google.com', 'bad', 'x@y', 'list,a@example.com', 'x\r\n@example.com'])('rejects unusable recipient %s before enrollment', async email => {
 await seedUser('one'); await testDb().db.update(users).set({ email }).where(eq(users.id, 'one'));
 expect(await enqueueWelcome(testDb().db, 'one', 'signup')).toBe(false); expect(await row()).toMatchObject({ state: 'suppressed' });
 await sweepWelcomeEmails(budget()); expect(mocks.send).not.toHaveBeenCalled();
});
test('self-hosted deployments and the explicit send kill switch never send', async () => {
 await queued(); mocks.env.WELCOME_EMAIL_ENABLED = 'false'; expect((await sweepWelcomeEmails(budget())).accepted).toBe(0);
 mocks.env.WELCOME_EMAIL_ENABLED = 'true'; mocks.env.MODERATY_DEPLOYMENT = 'self-hosted';
 await sweepWelcomeEmails(budget()); expect(mocks.send).not.toHaveBeenCalled();
 await seedUser('two'); expect(await enqueueWelcome(testDb().db, 'two', 'signup')).toBe(false); expect(await row('two')).toBeUndefined();
});
test.each(['deleted', 'synthetic', 'suppressed', 'non-hosted'])('rechecks %s before each attempt', async reason => {
 await queued();
 if (reason === 'deleted') await testDb().db.update(users).set({ googleSub: 'deleted:one' }).where(eq(users.id, 'one'));
 if (reason === 'synthetic') await testDb().db.update(users).set({ email: 'one@accounts.google.com' }).where(eq(users.id, 'one'));
 if (reason === 'suppressed') await testDb().db.update(welcomeEmails).set({ state: 'suppressed', suppressionReason: 'operator' }).where(eq(welcomeEmails.userId, 'one'));
 if (reason === 'non-hosted') await testDb().db.update(welcomeEmails).set({ cohort: 'self-hosted' }).where(eq(welcomeEmails.userId, 'one'));
 await deliverWelcome('one', budget()); expect(mocks.send).not.toHaveBeenCalled();
});
test('concurrent claims have one sender and cannot take a live lease', async () => {
 await queued(); const { ready, release } = holdNextSubmission();
 const first = deliverWelcome('one', budget()); await ready;
 try { expect(await deliverWelcome('one', budget())).toBe('deferred'); expect(mocks.send).toHaveBeenCalledTimes(1); }
 finally { release(); await first; }
});
test('expired in-flight leases become ambiguous and never automatically retry', async () => {
 await queued(); await testDb().db.update(welcomeEmails).set({ state: 'in_flight', claimToken: 'crashed', leaseExpiresAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, 'one'));
 expect((await sweepWelcomeEmails(budget())).ambiguous).toBe(1); expect(await row()).toMatchObject({ state: 'ambiguous', lastError: 'abandoned_submission' });
 await sweepWelcomeEmails(budget()); expect(mocks.send).not.toHaveBeenCalled();
});
test('an expired pre-submission claim safely resumes', async () => {
 await queued(); await testDb().db.update(welcomeEmails).set({ state: 'claimed', claimToken: 'crashed', leaseExpiresAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, 'one'));
 await sweepWelcomeEmails(budget()); expect(await row()).toMatchObject({ state: 'accepted', attempts: 1 });
});
test('definite failure backs off with stable identity and bounded attempts', async () => {
 const original = await queued(); mocks.send.mockRejectedValue(new ProtonMailSubmissionError('retryable', 'throttled', 'e-mail could not be sent'));
 for (let attempt = 1; attempt <= 5; attempt++) { await due(); await deliverWelcome('one', budget()); expect((await row())?.attempts).toBe(attempt); }
 expect(await row()).toMatchObject({ state: 'permanent_failure', lastError: 'retry_exhausted', nextRetryAt: null });
 expect(mocks.send.mock.calls.every(call => call[0].messageId === original.messageId)).toBe(true);
 await due(); await deliverWelcome('one', budget()); expect(mocks.send).toHaveBeenCalledTimes(5);
});
test.each([new Error('connection ended after DATA'), new ProtonMailSubmissionError('unknown', 'timeout', 'timed out')])('uncertain submission stays ambiguous: %s', async cause => {
 await queued(); mocks.send.mockRejectedValueOnce(cause); await deliverWelcome('one', budget());
 expect(await row()).toMatchObject({ state: 'ambiguous', nextRetryAt: null }); await sweepWelcomeEmails(budget()); expect(mocks.send).toHaveBeenCalledTimes(1);
});
test('definite rejection is terminal, not marked accepted', async () => {
 await queued(); mocks.send.mockRejectedValueOnce(new ProtonMailSubmissionError('permanent', 'rejected', 'rejected')); await deliverWelcome('one', budget());
 expect(await row()).toMatchObject({ state: 'permanent_failure', acceptedAt: null });
});
test('backfill includes missing, historical unknown and never-sent, but excludes accepted/ambiguous/suppressed; preview is count-only', async () => {
 for (const id of ['missing', 'unknown', 'unsent', 'sent', 'uncertain', 'suppressed', 'invalid']) await seedUser(id);
 for (const [id, state] of [['unknown', 'historical_unknown'], ['unsent', 'never_sent'], ['sent', 'accepted'], ['uncertain', 'ambiguous'], ['suppressed', 'suppressed']] as const) {
  await testDb().db.insert(welcomeEmails).values({ userId: id, campaign: WELCOME_CAMPAIGN, templateVersion: 1, state, source: 'historical_unknown', messageId: `<${id}@moderaty.com>` });
 }
 await testDb().db.update(users).set({ email: 'invalid' }).where(eq(users.id, 'invalid'));
 const before = await testDb().db.select().from(welcomeEmails);
 expect(await previewWelcomeBackfill()).toMatchObject({ total: 7, eligible: 3, excluded: 4, historicalUnknown: 2 });
 expect(await testDb().db.select().from(welcomeEmails)).toEqual(before); expect(mocks.send).not.toHaveBeenCalled();
 let cursor: string | null = null; let enrolled = 0;
 do { const batch = await backfillWelcomeBatch({ afterUserId: cursor, limit: 2 }); enrolled += batch.queued; cursor = batch.nextCursor; } while (cursor);
 expect(enrolled).toBe(3); expect((await row('missing'))?.source).toBe('historical_unknown'); expect((await row('unknown'))?.state).toBe('queued');
 expect((await row('sent'))?.state).toBe('accepted'); expect((await row('uncertain'))?.state).toBe('ambiguous');
 expect((await backfillWelcomeBatch({ limit: 25 })).queued).toBe(0); expect(mocks.send).not.toHaveBeenCalled();
});
test('backfill rejects invalid or unbounded batches', async () => {
 for (const limit of [0, 26, -1, 1.5, NaN]) await expect(backfillWelcomeBatch({ limit })).rejects.toThrow('1–25');
});

test('copy escapes personalization and accurately distinguishes channel setup, used preview and member roles', () => {
 const base = { email: 'person@example.com', displayName: '<img src=x onerror=bad()>', messageId: '<preview@moderaty.com>', appUrl: 'https://moderaty.com', teams: [{ role: 'owner' as const, channels: [] }] };
 const fresh = buildWelcomeEmail(base); expect(fresh.htmlPart).not.toContain('<img'); expect(fresh.htmlPart).toContain('&lt;img');
 for (const part of [fresh.textPart, fresh.htmlPart]) { expect(part).toContain('contact@moderaty.com'); expect(part).toContain('https://moderaty.com/contact'); expect(part).toContain('https://moderaty.com/dashboard'); expect(part).toContain('https://moderaty.com/login'); expect(part).toContain('one free attempt per channel'); expect(part).toContain('even if'); }
 expect(fresh.replyTo).toBe('contact@moderaty.com'); expect(fresh.textPart).toContain('separate'); expect(fresh.textPart).toContain('does not change comments on YouTube or consume comment credits');
 const member = buildWelcomeEmail({ ...base, teams: [{ role: 'member', channels: [] }] }); expect(member.textPart).toContain('ask a team owner or admin'); expect(member.textPart).not.toContain('Connect your YouTube channel');
 const used = buildWelcomeEmail({ ...base, teams: [{ role: 'owner', channels: [{ active: true, previewUsed: true }] }] }); expect(used.textPart).toContain('already been used'); expect(used.textPart).not.toContain('Try the free moderation dry run');
 const mixed = buildWelcomeEmail({ ...base, teams: [{ role: 'owner', channels: [] }, { role: 'member', channels: [{ active: true, previewUsed: false }] }] }); expect(mixed.textPart).toContain('where you are an owner or admin'); expect(mixed.textPart).toContain('Try the free moderation dry run');
 expect(fresh.textPart).not.toMatch(/lifetime|\$49|100 credits|five comments/i);
});

test('global throttle prevents multiple recipients across overlapping cron ticks', async () => {
 await queued('one'); await queued('two');
 const { ready, release } = holdNextSubmission();
 const first = deliverWelcome('one', budget()); await ready;
 try {
  expect(await deliverWelcome('two', budget())).toBe('deferred'); expect(mocks.send).toHaveBeenCalledTimes(1);
 } finally { release(); await first; }
 expect(await deliverWelcome('two', budget())).toBe('deferred');
 await due('one'); await deliverWelcome('two', budget()); expect(mocks.send).toHaveBeenCalledTimes(2);
});
test('a provider acceptance followed by failed persistence becomes ambiguous after restart', async () => {
 await queued();
 const originalUpdate = testDb().db.update.bind(testDb().db);
 const spy = vi.spyOn(testDb().db, 'update').mockImplementation(((table: unknown) => {
  const builder = originalUpdate(table as typeof welcomeEmails);
  const originalSet = builder.set.bind(builder);
  builder.set = ((values: Record<string, unknown>) => {
   if (values.state === 'accepted') throw new Error('database unavailable after acceptance');
   return originalSet(values);
  }) as typeof builder.set;
  return builder;
 }) as typeof originalUpdate);
 await expect(deliverWelcome('one', budget())).rejects.toThrow('database unavailable after acceptance'); spy.mockRestore();
 expect(await row()).toMatchObject({ state: 'in_flight', acceptedAt: null });
 await testDb().db.update(welcomeEmails).set({ leaseExpiresAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, 'one'));
 await sweepWelcomeEmails(budget()); expect(await row()).toMatchObject({ state: 'ambiguous' }); expect(mocks.send).toHaveBeenCalledTimes(1);
});
test('account deletion erases its welcome record inside account teardown', async () => {
 await queued(); const { deleteUserRecords } = await import('./deletion'); await deleteUserRecords('one');
 expect(await row()).toBeUndefined(); await sweepWelcomeEmails(budget()); expect(mocks.send).not.toHaveBeenCalled();
});
test('current multi-team context respects membership and moderation preview state, independently of feedback', async () => {
 await queued();
 await testDb().db.insert(organizations).values([{ id: 'personal', name: 'Personal' }, { id: 'team', name: 'Team' }, { id: 'other', name: 'Other' }]);
 await testDb().db.insert(memberships).values([{ userId: 'one', orgId: 'personal', role: 'owner' }, { userId: 'one', orgId: 'team', role: 'member' }]);
 await testDb().db.insert(channels).values([{ id: 'visible', orgId: 'team', title: 'Visible', refreshTokenEnc: 'fixture', moderationDryRunUsedAt: new Date(0).toISOString(), feedbackDryRunUsedAt: null }, { id: 'invisible', orgId: 'other', title: 'Hidden', refreshTokenEnc: 'fixture' }]);
 await deliverWelcome('one', budget()); expect(mocks.send.mock.calls[0][0].textPart).toContain('already been used');
 expect(mocks.send.mock.calls[0][0].textPart).not.toContain('Try the free moderation dry run');
});

test('copy does not call all channels paused when an active channel has already used its preview', () => {
 const mail = buildWelcomeEmail({ email: 'person@example.com', displayName: 'Person', messageId: '<preview@moderaty.com>', appUrl: 'https://moderaty.com', teams: [{ role: 'owner', channels: [{ active: true, previewUsed: true }, { active: false, previewUsed: false }] }] });
 expect(mail.textPart).not.toContain('Your connected channels are paused');
 expect(mail.textPart).toContain('remaining free preview');
});

test('count-only status and recurring cron health keep ambiguous outcomes visible until reconciliation', async () => {
 await queued(); mocks.send.mockRejectedValueOnce(new Error('uncertain'));
 await deliverWelcome('one', budget());
 const { welcomeQueueStatus } = await import('./welcomeEmail');
 expect(await welcomeQueueStatus()).toEqual({ ambiguous: 1 });
 expect((await sweepWelcomeEmails(budget())).ambiguous).toBe(1);
});

test.each([{ suppressionReason: 'operator' }, { acceptedAt: '2026-01-01T00:00:00.000Z' }])('a terminal marker on a queued row cannot block later recipients: %o', async terminal => {
 await queued('one'); await queued('two');
 await testDb().db.update(welcomeEmails).set({ ...terminal, nextRetryAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, 'one'));
 await sweepWelcomeEmails(budget()); expect(await row('two')).toMatchObject({ state: 'accepted' }); expect(mocks.send).toHaveBeenCalledTimes(1);
});


test('a deadline proven to precede transport submission defers without consuming send attempts', async () => {
 await queued(); mocks.send.mockRejectedValueOnce(new ProtonMailPreSubmissionDeadlineError());
 expect(await deliverWelcome('one', budget())).toBe('deferred');
 expect(await row()).toMatchObject({ state: 'queued', attempts: 0, lastAttemptAt: null, lastError: 'deadline_before_submission', claimToken: null });
});

test('deleted accounts cannot acquire fresh welcome metadata through enrollment', async () => {
 await seedUser('one'); const { deleteUserRecords } = await import('./deletion'); await deleteUserRecords('one');
 expect(await enqueueWelcome(testDb().db, 'one', 'historical_unknown')).toBe(false);
 expect(await row()).toBeUndefined();
});
test('a deletion committed after the backfill page read is rechecked inside each enrollment transaction', async () => {
 await seedUser('one'); const { deleteUserRecords } = await import('./deletion');
 const originalTransaction = testDb().db.transaction.bind(testDb().db); let deleted = false;
 const spy = vi.spyOn(testDb().db, 'transaction').mockImplementation((async (callback, ...rest) => {
  if (!deleted) { deleted = true; await deleteUserRecords('one'); }
  return originalTransaction(callback, ...rest);
 }) as typeof originalTransaction);
 try {
  expect(await backfillWelcomeBatch({ limit: 1 })).toMatchObject({ scanned: 1, queued: 0 });
  expect((await testDb().db.select().from(users).where(eq(users.id, 'one')).get())?.googleSub).toBe('deleted:one');
  expect(await row()).toBeUndefined();
 } finally { spy.mockRestore(); }
});


test.each([
 new ProtonMailConfigurationError('PROTON_SMTP_TOKEN is not configured'),
 new ProtonMailSubmissionError('retryable', 'authentication', 'authentication failure'),
 new ProtonMailSubmissionError('retryable', 'tls', 'TLS failure'),
 new ProtonMailSubmissionError('retryable', 'dns', 'DNS failure')
])('a deployment-wide transport outage never exhausts a recipient budget: %s', async cause => {
 await queued(); mocks.send.mockRejectedValue(cause);
 for (let index = 0; index < 7; index++) { await due(); await deliverWelcome('one', budget()); }
 expect(await row()).toMatchObject({ state: 'queued', attempts: 0, claimToken: null });
 await due(); mocks.send.mockResolvedValueOnce({ messageId: '<accepted@moderaty.com>' });
 expect(await deliverWelcome('one', budget())).toBe('accepted');
});
test.each([
 [new ProtonMailConfigurationError('missing token'), 'configuration'],
 [new ProtonMailSubmissionError('retryable', 'authentication', 'auth failure'), 'authentication'],
 [new ProtonMailSubmissionError('retryable', 'tls', 'TLS failure'), 'tls'],
 [new ProtonMailSubmissionError('retryable', 'dns', 'DNS failure'), 'dns']
])('transport outages put a durable campaign cooldown on the next user: %s', async (cause, category) => {
 await queued('one'); await queued('two'); mocks.send.mockRejectedValueOnce(cause);
 expect((await sweepWelcomeEmails(budget())).errors).toBe(1);
 expect(await deliverWelcome('two', budget())).toBe('deferred');
 expect(mocks.send).toHaveBeenCalledTimes(1);
 expect(await row('one')).toMatchObject({ state: 'queued', attempts: 0, lastError: category });
});

test('channel context is refreshed after the fresh account read', async () => {
 await queued();
 await testDb().db.insert(organizations).values({ id: 'team', name: 'Team' });
 await testDb().db.insert(memberships).values({ userId: 'one', orgId: 'team', role: 'owner' });
 const originalSelect = testDb().db.select.bind(testDb().db);
 const spy = vi.spyOn(testDb().db, 'select').mockImplementation(((fields?: Parameters<typeof originalSelect>[0]) => {
  const builder = Reflect.apply(originalSelect, testDb().db, fields === undefined ? [] : [fields]) as ReturnType<typeof originalSelect>; const originalFrom = builder.from.bind(builder);
  builder.from = ((table: typeof users) => {
   const query = originalFrom(table);
   if (table === users) {
    const originalGet = query.get.bind(query);
    query.get = (async () => {
     const account = await originalGet();
     await testDb().db.update(memberships).set({ role: 'member' }).where(eq(memberships.userId, 'one'));
     await testDb().db.insert(channels).values({ id: 'newly-connected', orgId: 'team', title: 'New', refreshTokenEnc: 'fixture', moderationDryRunUsedAt: new Date(0).toISOString() });
     return account;
    }) as typeof query.get;
   }
   return query;
  }) as typeof builder.from;
  return builder;
 }) as unknown as typeof originalSelect);
 try { await deliverWelcome('one', budget()); }
 finally { spy.mockRestore(); }
 expect(mocks.send.mock.calls[0][0].textPart).toContain('already been used');
 expect(mocks.send.mock.calls[0][0].textPart).not.toContain('Try the free moderation dry run');
});


test.each([
 new ProtonMailConfigurationError('missing token'),
 new ProtonMailSubmissionError('retryable', 'authentication', 'auth failure'),
 new ProtonMailSubmissionError('retryable', 'tls', 'TLS failure'),
 new ProtonMailSubmissionError('retryable', 'dns', 'DNS failure')
])('transport outages preserve the existing nonzero attempt history exactly: %s', async cause => {
 await queued();
 const previousAttempt = new Date(Date.now() - 3_600_000).toISOString();
 await testDb().db.update(welcomeEmails).set({ state: 'retryable_failure', attempts: 2, lastAttemptAt: previousAttempt, nextRetryAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, 'one'));
 mocks.send.mockRejectedValueOnce(cause);
 expect(await deliverWelcome('one', budget())).toBe('failed');
 expect(await row()).toMatchObject({ state: 'queued', attempts: 2, lastAttemptAt: previousAttempt, claimToken: null, acceptedAt: null });
});


test.each([
 new Error('uncertain'),
 new ProtonMailSubmissionError('retryable', 'throttled', 'throttled'),
 new ProtonMailSubmissionError('retryable', 'authentication', 'auth failure')
])('a lost claim cannot report a failure transition it did not persist: %s', async cause => {
 await queued();
 mocks.send.mockImplementationOnce(async () => {
  await testDb().db.update(welcomeEmails).set({ state: 'suppressed', claimToken: null, suppressionReason: 'operator' }).where(eq(welcomeEmails.userId, 'one'));
  throw cause;
 });
 expect(await sweepWelcomeEmails(budget())).toMatchObject({ ambiguous: 0, errors: 0 });
 expect(await row()).toMatchObject({ state: 'suppressed', suppressionReason: 'operator' });
});
test('an explicitly uncertain outcome remains ambiguous even with a transport-outage category', async () => {
 await queued(); mocks.send.mockRejectedValueOnce(new ProtonMailSubmissionError('unknown', 'tls', 'uncertain TLS outcome'));
 expect(await deliverWelcome('one', budget())).toBe('ambiguous');
 expect(await row()).toMatchObject({ state: 'ambiguous', nextRetryAt: null });
});

test.each(['one@foo-.bar.com', 'one@foo.-bar.com', `one@${'a'.repeat(64)}.com`])('suppresses an invalid DNS label before enrollment: %s', async email => {
 await seedUser('one'); await testDb().db.update(users).set({ email }).where(eq(users.id, 'one'));
 expect(await enqueueWelcome(testDb().db, 'one', 'signup')).toBe(false);
 expect(await row()).toMatchObject({ state: 'suppressed', suppressionReason: 'invalid_recipient' });
});
test('recipient recheck rejects a newly invalid domain label before SMTP', async () => {
 await queued(); await testDb().db.update(users).set({ email: 'one@foo-.bar.com' }).where(eq(users.id, 'one'));
 expect(await deliverWelcome('one', budget())).toBe('suppressed'); expect(mocks.send).not.toHaveBeenCalled();
});

test.each(['one@example.xn--p1ai', 'one@xn--e1afmkfd.xn--p1ai'])('valid IDNA A-label recipients enroll and reach SMTP: %s', async email => {
 await seedUser('one'); await testDb().db.update(users).set({ email }).where(eq(users.id, 'one'));
 expect(await enqueueWelcome(testDb().db, 'one', 'signup')).toBe(true);
 expect(await deliverWelcome('one', budget())).toBe('accepted');
 expect(mocks.send.mock.calls[0][0].toEmail).toBe(email);
});

test.each(['one@example.xn--a', 'one@example.xn--', 'one@example.123'])('invalid IDNA and numeric TLDs stay excluded: %s', async email => {
 await seedUser('one'); await testDb().db.update(users).set({ email }).where(eq(users.id, 'one'));
 expect(await enqueueWelcome(testDb().db, 'one', 'signup')).toBe(false);
 expect(await row()).toMatchObject({ suppressionReason: 'invalid_recipient' });
});

test('recipient deletion during pending SMTP cannot release campaign pacing', async () => {
 await queued('one'); await queued('two');
 const { ready, release } = holdNextSubmission();
 const first = deliverWelcome('one', budget());
 // Account deletion intentionally makes acceptance persistence fail; observe it immediately.
 const outcome = first.catch(cause => cause);
 await ready;
 try {
  const { deleteUserRecords } = await import('./deletion'); await deleteUserRecords('one');
  expect(await row('one')).toBeUndefined();
  expect(await deliverWelcome('two', budget())).toBe('deferred');
  expect(mocks.send).toHaveBeenCalledTimes(1);
 } finally { release(); await outcome; }
});

test('deleting the failed recipient cannot erase the transport outage cooldown', async () => {
 await queued('one'); await queued('two'); mocks.send.mockRejectedValueOnce(new ProtonMailConfigurationError('missing token'));
 expect(await deliverWelcome('one', budget())).toBe('failed');
 const { deleteUserRecords } = await import('./deletion'); await deleteUserRecords('one');
 expect(await deliverWelcome('two', budget())).toBe('deferred');
 expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('bad membership context is suppressed and cannot poison every subsequent sweep', async () => {
 await queued('one'); await queued('two');
 await testDb().db.insert(organizations).values({ id: 'bad-team', name: 'Team' });
 await testDb().db.insert(memberships).values({ userId: 'one', orgId: 'bad-team', role: 'unexpected-role' });
 const log = vi.spyOn(console, 'error').mockImplementation(() => {});
 try {
  expect(await sweepWelcomeEmails(budget())).toMatchObject({ errors: 1 });
  expect(await row('one')).toMatchObject({ state: 'suppressed', suppressionReason: 'invalid_membership', claimToken: null, leaseExpiresAt: null, attempts: 0 });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('[welcome]'), { category: 'invalid_membership' });
  await due('one');
  expect(await sweepWelcomeEmails(budget())).toMatchObject({ accepted: 1 });
  expect(await row('two')).toMatchObject({ state: 'accepted' });
 } finally { log.mockRestore(); }
});

test('malformed origin produces a sanitized actionable category without claiming a user', async () => {
 await queued(); mocks.env.APP_URL = 'private-origin-value';
 const log = vi.spyOn(console, 'error').mockImplementation(() => {});
 try {
  expect(await sweepWelcomeEmails(budget())).toMatchObject({ errors: 1 });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('[welcome]'), { category: 'configuration' });
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-origin-value');
  expect(await row()).toMatchObject({ state: 'queued', claimToken: null });
 } finally { log.mockRestore(); }
});

test('cron health is a bounded ambiguity indicator while operator status retains full counts', async () => {
 for (const id of ['one', 'two', 'three']) {
  await queued(id); await testDb().db.update(welcomeEmails).set({ state: 'ambiguous' }).where(eq(welcomeEmails.userId, id));
 }
 const execute = vi.spyOn(testDb().client, 'execute');
 try {
  expect((await sweepWelcomeEmails(budget())).ambiguous).toBe(1);
  expect(JSON.stringify(execute.mock.calls)).not.toMatch(/count\(\*\)/i);
 } finally { execute.mockRestore(); }
 const { welcomeQueueStatus } = await import('./welcomeEmail');
 expect(await welcomeQueueStatus()).toEqual({ ambiguous: 3 });
});

test('ambiguity health remains a presence flag when a new unknown outcome joins an existing row', async () => {
 await queued('old'); await testDb().db.update(welcomeEmails).set({ state: 'ambiguous' }).where(eq(welcomeEmails.userId, 'old'));
 await queued('new'); mocks.send.mockRejectedValueOnce(new Error('uncertain'));
 expect((await sweepWelcomeEmails(budget())).ambiguous).toBe(1);
});

test('simultaneous fresh claims for distinct recipients share one campaign slot', async () => {
 await queued('one'); await queued('two');
 const results = await Promise.all([deliverWelcome('one', budget()), deliverWelcome('two', budget())]);
 expect(results.sort()).toEqual(['accepted', 'deferred']);
 expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('existing ambiguity stays visible if the recovery budget runs out', async () => {
 await queued('uncertain'); await testDb().db.update(welcomeEmails).set({ state: 'ambiguous' }).where(eq(welcomeEmails.userId, 'uncertain'));
 await queued('expired'); await testDb().db.update(welcomeEmails).set({ state: 'claimed', claimToken: 'expired', leaseExpiresAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, 'expired'));
 const now = Date.now(); const deadline = now + 1000;
 const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(deadline);
 try { expect((await sweepWelcomeEmails(deadline)).ambiguous).toBe(1); }
 finally { clock.mockRestore(); }
 expect(mocks.send).not.toHaveBeenCalled();
});

test('sender-policy rejection preserves retry history and pauses other recipients', async () => {
 await queued('one'); await queued('two');
 const previousAttempt = new Date(Date.now() - 3_600_000).toISOString();
 await testDb().db.update(welcomeEmails).set({ attempts: 2, lastAttemptAt: previousAttempt }).where(eq(welcomeEmails.userId, 'one'));
 mocks.send.mockRejectedValueOnce(new ProtonMailSubmissionError('retryable', 'sender_rejected', 'sender rejected'));
 expect(await deliverWelcome('one', budget())).toBe('failed');
 expect(await row('one')).toMatchObject({ state: 'queued', attempts: 2, lastAttemptAt: previousAttempt, lastError: 'sender_rejected' });
 expect(await deliverWelcome('two', budget())).toBe('deferred');
 expect(mocks.send).toHaveBeenCalledTimes(1);
 expect(Date.parse((await row('one'))!.nextRetryAt!) - Date.now()).toBeGreaterThan(14 * 60_000);
});


test.each(['health', 'recovery'] as const)('a %s database failure cannot expose SQL or bound values through the welcome sweep', async stage => {
 await queued();
 if (stage === 'recovery') await testDb().db.update(welcomeEmails).set({ state: 'in_flight', claimToken: 'private-claim-fixture', leaseExpiresAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, 'one'));
 const cause = new DrizzleQueryError('SELECT private_query WHERE claim_token = ?', ['private-claim-fixture'], Object.assign(new Error('database busy'), { code: 'SQLITE_BUSY' }));
 const operation = vi.spyOn(testDb().db, stage === 'health' ? 'select' : 'update').mockImplementationOnce(() => { throw cause; });
 const log = vi.spyOn(console, 'error').mockImplementation(() => {});
 try {
  const failure = await sweepWelcomeEmails(budget()).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.cause).toBeUndefined();
  expect(failure.message).toBe('Welcome email sweep failed; inspect server diagnostics');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('[welcome]'), { category: 'database_busy' });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private_query|private-claim-fixture/);
  expect(mocks.send).not.toHaveBeenCalled();
 } finally { operation.mockRestore(); log.mockRestore(); }
 if (stage === 'recovery') expect(await row()).toMatchObject({ state: 'in_flight', claimToken: 'private-claim-fixture' });
});
