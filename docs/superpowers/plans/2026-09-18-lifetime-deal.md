# $49 Lifetime Deal Completion — Implementation Plan

> **For agentic workers:** implement task-by-task inline (no swarm — AGENTS.md).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the $49 lifetime plan so a user marked `plan='lifetime'`
can add their own OpenAI key, is never limited or charged by credits, and the
1,000-slot deal count is surfaced with a deliberate sold-out path.

**Architecture:** Three gaps verified on `dev`: (1) BYOK is fully wired
server-side (`setOpenAiKey`/`clearOpenAiKey`, `resolveOpenAiKey`,
`organizations.openai_key_enc`) but has no UI; (2) lifetime orgs can still buy
credit bundles and enable auto top-up, and `consumeCredit` drains any positive
balance even though their scoring is already unlimited; (3) the sold count
lives only in `stripe_lifetime_slots` with no surface, and the
paid-but-slotless fulfillment race logs "manual refund required".

**Tech Stack:** SvelteKit 2 + Svelte 5, drizzle-orm/libsql, vitest
(`svelte/server` render() for markup pins), stripe SDK (server-only).

**Spec:** Linear project "Complete the $49 Lifetime Deal" — issues MOD-33
through MOD-39 (each task below cites its issue).

## Global Constraints

- Failing test BEFORE every fix; watch it fail, fix, watch it pass, commit
  test+fix together (AGENTS.md).
- Commit after every step: `step <N>: <step name> (MOD-X)`. No attribution
  trailers.
- `npm run check`, `npm run build`, `npm run test` must stay green — never
  commit while red.
- Fail loudly: no silent fallbacks; errors log server-side AND show to the
  user where applicable.
- Approved deps only — no new dependencies. Stripe SDK is server-only.
- I12: every page has loading/empty/error/populated states. I13: every input,
  select, button has a visible label or aria-label; buttons name their target.
- Never serialize the key or ciphertext to the client — `hasOpenAiKey`
  boolean only.
- Env vars via `$env/dynamic/private`, never `process.env`.
- Branch: `lifetime-deal` (off `dev`), worktree `.worktrees/lifetime-deal`.
  End state: PR targeting `dev`; never merge it ourselves.

## File Structure

- `src/routes/(app)/org/+page.svelte` — add owner-only OpenAI key card.
- `src/routes/(app)/org/page.server.test.ts` — SSR pins for the card.
- `src/lib/server/billing/ledger.ts` — export `isUnmeteredPlan`,
  `assertCreditsPurchasable`; `consumeCredit` no-ops for unmetered plans.
- `src/lib/server/billing/checkout.ts` — gate `createCreditCheckout`.
- `src/lib/server/mercadopago/checkout.ts` — gate
  `createMercadoPagoCreditCheckout`.
- `src/lib/server/billing/autotopup.ts` — plan in `AutoTopupState`;
  `basicEligibility` + atomic claim skip unmetered orgs.
- `src/routes/(app)/usage/+page.server.ts` — `setAutoTopup` rejects lifetime;
  load returns `lifetimeSlots`.
- `src/routes/(app)/usage/+page.svelte` — hide credit cards for lifetime;
  slot count + sold-out state on the Plans card.
- `src/lib/server/billing/entitlements.ts` — export `LIFETIME_SOLD_OUT_ERROR`,
  `lifetimeSlotsRemaining()`.
- `src/lib/server/stripe/webhooks.ts` — auto-refund on sold-out lifetime
  fulfillment.
- `AGENTS.md`, `src/lib/landing/legal.test.ts` — reconcile stale BYOK prose.

---

### Task 1: OpenAI key card on the Team page (MOD-33)

**Files:**
- Test: `src/routes/(app)/org/page.server.test.ts`
- Modify: `src/routes/(app)/org/+page.svelte` (new card after "Rename team")

**Interfaces:**
- Consumes: existing actions `?/setOpenAiKey` (field `openAiKey`),
  `?/clearOpenAiKey`; load field `data.hasOpenAiKey` (boolean).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing SSR test** — append to
  `page.server.test.ts` (file already imports `organizations`; add the two
  imports below near the existing `import { actions, load }`):

```ts
import { render } from 'svelte/server';
import Page from './+page.svelte';

function renderOrgPage(user: SessionUser | null, hasOpenAiKey = false) {
	return render(Page, {
		props: {
			data: {
				user,
				members: [],
				invites: [],
				inviteBase: 'http://localhost/invite/',
				hasOpenAiKey,
				maintenance: false
			},
			form: null
		} as never
	}).body;
}

test('OpenAI key card: owner sees a labeled set-key form; saved state swaps to a remove form', async () => {
	const unset = renderOrgPage(TEST_OWNER, false);
	expect(unset).toContain('action="?/setOpenAiKey"');
	expect(unset).toMatch(/<label for="openai-key">/);
	expect(unset).toContain('name="openAiKey"');
	expect(unset).not.toContain('action="?/clearOpenAiKey"');

	const set = renderOrgPage(TEST_OWNER, true);
	expect(set).toContain('action="?/clearOpenAiKey"');
	expect(set).not.toContain('action="?/setOpenAiKey"');
	// The key itself is never rendered — the page only ever sees a boolean.
});

test('OpenAI key card: members and admins never see the form (actions are owner-only)', async () => {
	for (const user of [MEMBER, ADMIN]) {
		const body = renderOrgPage(user, false);
		expect(body).not.toContain('setOpenAiKey');
		expect(body).not.toContain('openAiKey');
	}
});
```

- [ ] **Step 2: Run, watch it fail**

Run: `npx vitest run "src/routes/(app)/org/page.server.test.ts"`
Expected: FAIL — `action="?/setOpenAiKey"` not found.

- [ ] **Step 3: Add the card** — in `+page.svelte`, inside `{#if isOwner}` —
  place it after the "Rename team" card block (rename is `isAdminUp`; the key
  card is owner-only, matching the actions' `requireOrgRole(user, 'owner')`):

```svelte
{#if isOwner}
	<div class="card">
		<h2 style="margin-top:0">OpenAI key</h2>
		{#if data.hasOpenAiKey}
			<p class="muted">
				A team OpenAI key is saved — AI scoring runs on it instead of the deployment's key.
			</p>
			<form method="POST" action="?/clearOpenAiKey" use:enhance>
				<button class="btn danger small" type="submit">Remove the saved OpenAI key</button>
			</form>
		{:else}
			<p class="muted">
				Score comments with your own OpenAI key instead of the deployment's. The key is
				validated with OpenAI before it is saved, stored encrypted, and never shown again.
			</p>
			<form method="POST" action="?/setOpenAiKey" use:enhance>
				<label for="openai-key">OpenAI API key (starts with sk-)</label>
				<input id="openai-key" type="password" name="openAiKey" maxlength="200" required />
				<button class="btn secondary small" type="submit">Save OpenAI key</button>
			</form>
		{/if}
	</div>
{/if}
```

- [ ] **Step 4: Run, watch it pass** — same command; both new tests green
  alongside the existing action tests.

- [ ] **Step 5: Commit**

```bash
git add "src/routes/(app)/org/+page.svelte" "src/routes/(app)/org/page.server.test.ts"
git commit -m "step 1: OpenAI key card on the Team page (MOD-33)"
```

---

### Task 2: Reconcile BYOK docs and legal posture (MOD-34)

**Files:**
- Modify: `AGENTS.md` (Accounts & Sessions paragraph)
- Modify: `src/lib/landing/legal.test.ts` (stale describe-block comment)

**Decisions taken (conservative — recorded on MOD-34 for the maintainer):**
- Terms §6.1(c) unchanged: "AI scoring run by us" stays the DEFAULT; the BYOK
  card is an unadvertised owner opt-in. Amending Terms would need a
  `LEGAL_VERSION` bump + re-consent — maintainer call, not this task.
- No lifetime-BYOK marketing claims added — the `legal.test.ts` guards stay
  and keep forbidding them.

**Work:**
- `AGENTS.md`: the paragraph already says hosted accounts "can additionally
  set a per-account OpenAI key on the Team page" — true after Task 1. Tighten
  to reflect reality: the card is owner-only and applies to any hosted org
  (hosted subscription AND lifetime).
- `legal.test.ts`: the describe comment claims "there is no per-account key
  flow — hosted scoring (lifetime included) runs on the deployment's
  env.OPENAI_API_KEY". Correct it: the per-account key flow exists
  (owner-only, `organizations.openai_key_enc` → `resolveOpenAiKey`); the test
  still guards that marketing never PROMISES it for lifetime.
- No assertion changes — the `RETIRED` patterns and §6.1(c) pins stay
  green (they forbid marketing claims, not the feature).

- [ ] **Step 1: Failing check** — confirm current comment is stale; no code
  test needed for comment/docs, but run the file to prove assertions still
  hold after the comment edit:

Run: `npx vitest run src/lib/landing/legal.test.ts`

- [ ] **Step 2: Edits, re-run green, commit**

```bash
git add AGENTS.md src/lib/landing/legal.test.ts
git commit -m "step 2: reconcile BYOK docs with the shipped key flow (MOD-34)"
```

---

### Task 3: Block credit purchases and auto top-up for lifetime orgs (MOD-35)

**Files:**
- Modify: `src/lib/server/billing/ledger.ts` — `isUnmeteredPlan`,
  `assertCreditsPurchasable`
- Modify: `src/lib/server/billing/checkout.ts` — gate in
  `createCreditCheckout` before `createCheckoutAttempt`
- Modify: `src/lib/server/mercadopago/checkout.ts` — same gate before
  `loadOrCreateAttempt`
- Modify: `src/lib/server/billing/autotopup.ts` — `plan` in
  `AutoTopupState`/`readAutoTopupState`; `basicEligibility` + atomic-claim
  WHERE skip unmetered orgs
- Modify: `src/routes/(app)/usage/+page.server.ts` — `setAutoTopup` rejects
  enable for lifetime
- Modify: `src/routes/(app)/usage/+page.svelte` — hide Buy credits / Mercado
  Pago / Automatic top-up cards for `billing.plan === 'lifetime'`
- Test: `src/routes/(app)/usage/usage.test.ts`,
  `src/lib/server/billing/ledger.test.ts`,
  `src/lib/server/billing/autotopup.test.ts`

**Interfaces:**
- Produces: `isUnmeteredPlan(plan: string | null | undefined): boolean`,
  `assertCreditsPurchasable(orgId: string): Promise<void>` (throws
  `'the lifetime plan includes unlimited moderated comments — credit purchases are not available'`),
  `AutoTopupState.plan: string | null` — all consumed by this task only.

- [ ] **Step 1: Failing tests**

`usage.test.ts` (add near the buy tests; the file's `seedOrg` accepts
overrides and `buy`/`buyMercadoPago`-equivalent helpers exist — for MP use
`actions.buyMercadoPago`):

```ts
test('a lifetime org cannot open a credit checkout (Stripe or Mercado Pago)', async () => {
	await seedOrg({ plan: 'lifetime', creditsRemaining: 0 });
	const stripeRes = (await buy('credits_100')) as { status?: number };
	expect(stripeRes.status).toBeGreaterThanOrEqual(400);
	expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	const mpRes = (await actions.buyMercadoPago({ request: postForm({ bundle: 'mp_100' }), locals: { user: OWNER } } as never)) as { status?: number };
	expect(mpRes.status).toBeGreaterThanOrEqual(400);
});

test('a lifetime org cannot enable auto top-up; disabling stays allowed', async () => {
	await seedOrg({ plan: 'lifetime', creditsRemaining: 0, autoTopupEnabled: 1, autoTopupState: 'idle' });
	const res = (await setAutoTopup({ enabled: 'on', threshold: '100', consent: 'on' })) as { status: number; data: { error: string } };
	expect(res.status).toBe(400);
	const off = await setAutoTopup({ threshold: '100' });
	expect(off).toMatchObject({ ok: true });
});
```

`autotopup.test.ts` (follow existing mock/seed style in that file):

```ts
test('auto top-up never triggers for a lifetime org even when enabled and below threshold', async () => {
	// seed org-1: plan 'lifetime', autoTopupEnabled 1, creditsRemaining 0,
	// stripeCustomerId + stripeDefaultPmId set, state 'idle'
	expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
	// assert paymentIntents.create was never called
});
```

`ledger.test.ts`:

```ts
test('assertCreditsPurchasable throws for a lifetime org, passes otherwise', async () => {
	await seedOrg('org-1', null, null); // existing helper
	await expect(assertCreditsPurchasable('org-1')).resolves.toBeUndefined();
	await testDb().db.update(organizations).set({ plan: 'lifetime' }).where(eq(organizations.id, 'org-1'));
	await expect(assertCreditsPurchasable('org-1')).rejects.toThrow(/lifetime/);
});
```

- [ ] **Step 2: Run, watch them fail**

Run: `npx vitest run src/routes/\(app\)/usage/usage.test.ts src/lib/server/billing/autotopup.test.ts src/lib/server/billing/ledger.test.ts`
Expected: the new tests FAIL (checkout opens / auto top-up triggers /
function missing).

- [ ] **Step 3: Implement**

`ledger.ts` — export a predicate + the guard (UNMETERED_PLANS already exists):

```ts
export function isUnmeteredPlan(plan: string | null | undefined): boolean {
	return UNMETERED_PLANS.has(plan ?? '');
}

export async function assertCreditsPurchasable(orgId: string): Promise<void> {
	const row = await db.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, orgId)).get();
	if (!row) throw new Error(`org not found: ${orgId}`);
	if (isUnmeteredPlan(row.plan)) throw new Error('the lifetime plan includes unlimited moderated comments — credit purchases are not available');
}
```

`billing/checkout.ts` — inside `createCreditCheckout`, after the APP_URL
check, before `createCheckoutAttempt`:

```ts
	await assertCreditsPurchasable(orgId);
```

`mercadopago/checkout.ts` — inside `createMercadoPagoCreditCheckout`, after
`webhookSecret()`/`mercadoPagoBundleById`, before `loadOrCreateAttempt`:

```ts
	await assertCreditsPurchasable(orgId);
```

`autotopup.ts` — `AutoTopupState` gains `plan: string | null`;
`readAutoTopupState` selects `organizations.plan`; in `basicEligibility`,
first branch:

```ts
	if (isUnmeteredPlan(org.plan)) {
		// An enabled flag on an unmetered plan is a data anomaly — say so,
		// then skip: unlimited orgs never buy credits.
		if (org.enabled === 1) console.error(`auto top-up skipped for unmetered org (plan ${org.plan}) despite enabled flag`);
		return false;
	}
```

and add `ne(organizations.plan, 'lifetime')` to the atomic claim's `where`
(closes the upgrade-during-flight race; `ne` is already imported there —
verify import list).

`usage/+page.server.ts` — extend the `current` select in `setAutoTopup` with
`plan: organizations.plan`; after `wasEnabled` is computed:

```ts
	if (enabled && isUnmeteredPlan(current?.plan)) {
		return fail(400, { error: 'Your lifetime plan includes unlimited moderated comments — auto top-up is not needed.' });
	}
```

`usage/+page.svelte` — wrap the "Buy credits", "Buy with Mercado Pago", and
"Automatic top-up" cards in `{#if data.billing?.plan !== 'lifetime'}`, and
show an explanatory line instead (I12: not silently different):

```svelte
{#if data.billing?.plan === 'lifetime'}
	<div class="card">
		<h2 style="margin-top:0">Buy credits</h2>
		<p class="muted">Your lifetime plan includes unlimited moderated comments — credits are not needed.</p>
	</div>
{:else}
	…existing three cards…
{/if}
```

- [ ] **Step 4: Run, watch them pass** — same vitest command.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/billing/ledger.ts src/lib/server/billing/checkout.ts src/lib/server/mercadopago/checkout.ts src/lib/server/billing/autotopup.ts "src/routes/(app)/usage/+page.server.ts" "src/routes/(app)/usage/+page.svelte" src/lib/server/billing/ledger.test.ts src/lib/server/billing/autotopup.test.ts "src/routes/(app)/usage/usage.test.ts"
git commit -m "step 3: lifetime orgs cannot buy credits or auto top up (MOD-35)"
```

---

### Task 4: consumeCredit no-ops for unmetered plans (MOD-36)

**Decision (recorded on the issue):** option (a) — `UNMETERED_PLANS` orgs
never consume: `consumeCredit` returns `false` before inserting a ledger row.
A lifetime org's pre-upgrade balance freezes instead of burning 1-per-comment
for zero benefit. Usage stats stay 0 — consistent with NULL-balance unmetered
orgs today (their consume rows are already insert-then-delete).

**Files:**
- Modify: `src/lib/server/billing/ledger.ts` — early return in
  `consumeCredit`
- Test: `src/lib/server/billing/ledger.test.ts`

- [ ] **Step 1: Failing test** (in `describe('consumeCredit')` — `seedOrg`
  helper there takes `(id, credits, customerId)`; extend inline for plan):

```ts
test('an unmetered (lifetime) org never consumes a credit, even holding a balance', async () => {
	await seedOrg('org-1', 500, 'cus_1');
	await testDb().db.update(organizations).set({ plan: 'lifetime' }).where(eq(organizations.id, 'org-1'));
	expect(await consumeCredit(testDb().db as never, 'org-1', 'comment-1')).toBe(false);
	const org = await testDb().db.select({ creditsRemaining: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(500); // frozen — unlimited scoring doesn't burn the stranded balance
	expect(await testDb().db.select().from(creditTransactions)).toHaveLength(0); // no ledger noise
});
```

- [ ] **Step 2: Run, watch it fail** — today returns `true` and balance 499.

Run: `npx vitest run src/lib/server/billing/ledger.test.ts`

- [ ] **Step 3: Implement** — in `consumeCredit`, right after the org
  existence check:

```ts
	// Unmetered plans (lifetime) never consume: their scoring is unlimited,
	// so a stranded pre-upgrade balance must not burn for nothing (MOD-36).
	if (isUnmeteredPlan(org.plan)) return false;
```

- [ ] **Step 4: Run, watch it pass; full billing files re-run**
  (`ledger.test.ts` + `staging`/`run` pipeline tests for regressions:
  `npx vitest run src/lib/server/billing src/lib/server/pipeline`)

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/billing/ledger.ts src/lib/server/billing/ledger.test.ts
git commit -m "step 4: consumeCredit no-ops for unmetered plans (MOD-36)"
```

---

### Task 5: Surface the slot count and sold-out state (MOD-37)

**Files:**
- Modify: `src/lib/server/billing/entitlements.ts` — `lifetimeSlotsRemaining`
- Modify: `src/routes/(app)/usage/+page.server.ts` — load returns it
- Modify: `src/routes/(app)/usage/+page.svelte` — Plans card count + sold-out
  + owned state
- Test: `src/lib/server/billing/entitlements.test.ts`,
  `src/routes/(app)/usage/usage.test.ts`

**Interfaces:**
- Produces: `lifetimeSlotsRemaining(): Promise<number>` (count of
  `stripe_lifetime_slots` rows with `active_org_id IS NULL`); load field
  `lifetimeSlots: number | null` (null in the maintenance payload).
- Scope decision: `/usage` only. The public `/pricing` page keeps the
  "first 1,000" claim — a live public counter is a maintainer/product
  decision, recorded on the issue.

- [ ] **Step 1: Failing tests**

`entitlements.test.ts` (file already seeds slots via `setupTestDb` including
`stripe_lifetime_slots` — verify table list; claim two slots by updating
`activeOrgId`):

```ts
test('lifetimeSlotsRemaining counts only unclaimed slots', async () => {
	expect(await lifetimeSlotsRemaining()).toBe(LIFETIME_SLOT_LIMIT);
	await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
	await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-2', activeEntitlementId: 2 }).where(eq(stripeLifetimeSlots.slot, 2));
	expect(await lifetimeSlotsRemaining()).toBe(LIFETIME_SLOT_LIMIT - 2);
});
```

`usage.test.ts`:

```ts
test('load surfaces the remaining lifetime slot count', async () => {
	await seedOrg();
	const data = (await load({ locals: { user: OWNER } } as never)) as { lifetimeSlots: number };
	expect(data.lifetimeSlots).toBe(LIFETIME_SLOT_LIMIT); // testdb seeds all 1,000 free — add stripe_lifetime_slots to setupTestDb table list
});
```

- [ ] **Step 2: Run, watch them fail.**

- [ ] **Step 3: Implement**

`entitlements.ts` (add `count` to the drizzle import):

```ts
/** Unclaimed lifetime slots — the deal's remaining inventory (MOD-37). */
export async function lifetimeSlotsRemaining(): Promise<number> {
	const row = await db.select({ n: count() }).from(stripeLifetimeSlots).where(isNull(stripeLifetimeSlots.activeOrgId)).get();
	return row?.n ?? 0;
}
```

`+page.server.ts` — in `load`, add `lifetimeSlots` to the `Promise.all` and
the return; `maintenanceData()` gets `lifetimeSlots: null`.

`+page.svelte` — inside the Plans card's `{#if data.plans.lifetime}` branch:

```svelte
{#if data.billing?.plan === 'lifetime'}
	<p class="muted">You have the lifetime plan — unlimited moderated comments.</p>
{:else if data.lifetimeSlots === 0}
	<p class="muted">The lifetime plan is sold out — all 1,000 claimed.</p>
{:else}
	<form method="POST" action="?/buyPlan" …existing…></form>
	<p class="muted">
		Unlimited comments while the lifetime plan is available.
		{#if typeof data.lifetimeSlots === 'number'}{1000 - data.lifetimeSlots} of 1,000 claimed.{/if}
	</p>
{/if}
```

- [ ] **Step 4: Run, watch them pass.**

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/billing/entitlements.ts src/lib/server/billing/entitlements.test.ts "src/routes/(app)/usage/+page.server.ts" "src/routes/(app)/usage/+page.svelte" "src/routes/(app)/usage/usage.test.ts"
git commit -m "step 5: surface lifetime slot count and sold-out state (MOD-37)"
```

---

### Task 6: Auto-refund paid-but-slotless lifetime checkouts (MOD-38)

**Decision:** option (a) — auto-refund via `stripe.refunds.create` on the
payment intent. A user who paid $49 and got nothing gets money back without a
human reading a log line. Idempotency key anchored on the checkout session id
(`refund:lifetime-soldout:${sessionId}`) dedupes webhook + success-page +
Stripe retries; a `charge.refunded` check covers replays past the 24h
idempotency horizon.

**Files:**
- Modify: `src/lib/server/billing/entitlements.ts` — export
  `LIFETIME_SOLD_OUT_ERROR`
- Modify: `src/lib/server/stripe/webhooks.ts` — catch the sold-out throw in
  `fulfillCheckout`, refund, still return `'rejected'`
- Test: `src/lib/server/stripe/webhooks.test.ts` — add `refundsCreate` mock

**Interfaces:**
- Consumes: `claimLifetimeSlot` (throws `LIFETIME_SOLD_OUT_ERROR`),
  `getPaymentIntentAndCharge` (returns `{ paymentIntent, charge }`).
- Produces: `refundSlotlessLifetime(...)` — module-private helper.

- [ ] **Step 1: Failing tests** — add `refundsCreate: vi.fn()` to `mocks` and
  `refunds: { create: mocks.refundsCreate }` to the `getStripe()` mock:

```ts
test('a paid lifetime checkout that finds no slot auto-refunds and stays rejected', async () => {
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
	// Claim every slot so claimLifetimeSlot throws sold-out.
	await testDb().client.execute('UPDATE stripe_lifetime_slots SET active_org_id = \'other\'');
	mocks.sessionsRetrieve.mockResolvedValue(session({ metadata: { org_id: 'org-1', product: 'lifetime', bundle: undefined }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
	expect(await fulfillCheckout('cs_lifetime')).toBe('rejected');
	expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_1' }, { idempotencyKey: 'refund:lifetime-soldout:cs_lifetime' });
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.plan).not.toBe('lifetime');
	expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toHaveLength(0);
});

test('an already-refunded charge is not refunded twice', async () => {
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
	await testDb().client.execute('UPDATE stripe_lifetime_slots SET active_org_id = \'other\'');
	mocks.sessionsRetrieve.mockResolvedValue(session({ metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: { id: 'ch_1', refunded: true } } }));
	expect(await fulfillCheckout('cs_lifetime')).toBe('rejected');
	expect(mocks.refundsCreate).not.toHaveBeenCalled();
});
```

(Careful with `session()` fixture: it defaults `metadata.bundle` — override
`metadata` wholesale with `{ org_id, product: 'lifetime' }` as existing
lifetime tests do.)

- [ ] **Step 2: Run, watch them fail** — sold-out currently throws out of
  `fulfillCheckout` (unhandled), and `refundsCreate` doesn't exist.

- [ ] **Step 3: Implement**

`entitlements.ts`: `export const LIFETIME_SOLD_OUT_ERROR = 'lifetime plan is sold out';`

`webhooks.ts` — wrap the claim:

```ts
		let result;
		try {
			result = await claimLifetimeSlot({
				orgId,
				checkoutSessionId: sessionId,
				paymentIntentId: paymentIntent?.id,
				chargeId: typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : charge?.id
			});
		} catch (error) {
			if (!(error instanceof Error && error.message === LIFETIME_SOLD_OUT_ERROR)) throw error;
			await refundSlotlessLifetime(sessionId, orgId, paymentIntent, charge);
			return 'rejected';
		}
```

and the helper (fail loudly, never throw — the webhook must ACK; a retry can
never mint a slot):

> **Reconciled during PR review (2026-09):** the shipped helper is
> `refundUngrantableCheckout(sessionId, orgId, paymentIntent, charge, reason)`
> — generalized beyond sold-out to duplicate lifetime checkouts and credit
> purchases fulfilled after the org went lifetime — and its refund-API
> failure now PROPAGATES after the MANUAL REFUND REQUIRED log. Swallowing a
> transient refund failure would ACK the delivery and leave the customer
> charged until a human reads the log; the 500 makes Stripe redeliver and
> retry the refund under the same idempotency key. Ungrantable outcomes
> return the `'refunded'` verdict (distinct from `'rejected'`) so
> `/usage/success` shows a deliberate refunded state, and the idempotency
> key is `refund:ungrantable:${sessionId}`. The no-payment-intent and
> already-refunded paths still ACK — nothing a retry could change.

```ts
/** A paid lifetime checkout that found no slot gets its money back — loudly, idempotently. */
async function refundSlotlessLifetime(
	sessionId: string,
	orgId: string,
	paymentIntent: Stripe.PaymentIntent | null,
	charge: Stripe.Charge | null | undefined
): Promise<void> {
	if (!paymentIntent?.id) {
		console.error(`stripe: lifetime checkout ${sessionId} for org ${orgId} was PAID but claimed no slot and has no payment intent — MANUAL REFUND REQUIRED`);
		return;
	}
	if (charge?.refunded === true) {
		console.error(`stripe: lifetime checkout ${sessionId} for org ${orgId} was slotless but charge ${charge.id} is already refunded`);
		return;
	}
	try {
		await getStripe().refunds.create(
			{ payment_intent: paymentIntent.id },
			{ idempotencyKey: `refund:lifetime-soldout:${sessionId}` }
		);
		console.error(`stripe: lifetime checkout ${sessionId} for org ${orgId} was PAID but claimed no slot — auto-refunded payment intent ${paymentIntent.id}`);
	} catch (error) {
		console.error(`stripe: lifetime checkout ${sessionId} auto-refund FAILED for org ${orgId} — MANUAL REFUND REQUIRED: ${error instanceof Error ? error.message : String(error)}`);
	}
}
```

- [ ] **Step 4: Run, watch them pass** +
  `npx vitest run src/lib/server/stripe` for regressions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/billing/entitlements.ts src/lib/server/stripe/webhooks.ts src/lib/server/stripe/webhooks.test.ts
git commit -m "step 6: auto-refund slotless lifetime checkouts (MOD-38)"
```

---

### Task 7: End-to-end verification (MOD-39)

- [ ] **Step 1:** `npm run check` — 0 errors.
- [ ] **Step 2:** `npm run build` — clean.
- [ ] **Step 3:** `npm run test` — full suite green (baseline was 1822).
- [ ] **Step 4:** Linear hygiene — mark MOD-33..38 done with a note; leave
  MOD-39 open pending human smoke (dev-deploy purchase needs a Stripe test
  card + live deployment — recorded on the issue).
- [ ] **Step 5:** push `lifetime-deal`, open PR targeting `dev` (house:
  never merge own PR — it stays open for the human).

## Self-Review

- Spec coverage: MOD-33→T1, MOD-34→T2, MOD-35→T3, MOD-36→T4, MOD-37→T5,
  MOD-38→T6, MOD-39→T7. All seven issues mapped.
- Placeholder scan: decision points resolved conservatively and recorded
  (T2: no legal change; T4: freeze; T5: /usage only; T6: auto-refund).
- Type consistency: `isUnmeteredPlan`/`assertCreditsPurchasable` exported
  from `ledger.ts`; `lifetimeSlotsRemaining` from `entitlements.ts`;
  `LIFETIME_SOLD_OUT_ERROR` exported. `AutoTopupState.plan: string | null`.
