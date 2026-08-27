# TODO
-Create log drain in coolify
Here's the full runbook. ~10 minutes, mostly in Axiom.

## 1. Axiom setup (app.axiom.co)

1. Create a free account if you don't have one.
2. **Datasets → New Dataset** — name it `moderaty`.
3. **Settings → API Tokens → New Token** — name e.g. `coolify-drain`, scope it to **Ingest** on the `moderaty` dataset only. Copy the token (shown once).

## 2. Coolify — server level (one time)

1. Coolify dashboard → **Servers** → the VPS running `moderaty-prod`/`moderaty-dev`.
2. **Log Drains** tab → enable.
3. Select **Axiom**, paste the API token and dataset name `moderaty`, save.

## 3. Coolify — per app (both apps)

For each of `moderaty-prod` and `moderaty-dev`:

1. Open the app → **Advanced** tab → **Drain Logs** → enable.
2. **Restart** the app — drains only attach on container start, per the [Coolify docs](https://coolify.io/docs/knowledge-base/drain-logs).

## 4. Verify

1. On `moderaty-dev`, fire one cron tick (`curl -H "Authorization: Bearer <CRON_SECRET>" https://<dev-domain>/api/cron`) or just browse a few pages.
2. In Axiom → `moderaty` dataset → you should see container stdout arriving within seconds: cron tick logs, request logs, any server errors.

## What this gets you

Everything the app writes to stdout/stderr — which is all our logging (`console.error` on failed dry runs, cron errors, OAuth failures) — lands in Axiom, searchable and persistent, instead of evaporating with the container. That's the durable answer to "how do I see server errors": Axiom's query UI (or alerts, if you later want e.g. a notification on `dry run failed`).

One note: the drain ships **container** logs, so the in-container cron ticker (`dev-cron.mjs`) output is included too. Nothing in the repo needs to change — this is pure Coolify/Axiom config, so no commit, no doc update required unless you want it recorded in `docs/COOLIFY_BUNNY.md` (say the word and I'll add a short §"Log drain" there).

-There needs to be an area to actually sign up for the recurring subscription and also the $49 lifetime deal. 
-There needs to be a way to cancel any subscriptions or auto top-ups

Deferred product work, quality refactors, and release-step items. The
SonarQube/Codacy quality sections below reflect the state after the
2026-08-20 S3776 triage (all criticals fixed on `dev`); the analyzers
re-evaluate on the next `dev → main` merge.

## Product features

- [x] Contact page with company name and email — implemented in
      `src/routes/contact/` and covered by route/server tests.
- [x] Add manual cost calculators to the homepage and Pricing page; users can
      enter last-month volume or three months of volume for a low/high range
      (`src/lib/landing/cost.ts`, `CostMath.svelte`).
- [ ] Add calculator that pulls real data from YouTube to determine costs —
      a forecast that gives a range of potential costs for the next month with
      a disclaimer that this is a 95% probability of being in the shown range.
- [x] Auto-recharge functionality and consent language — implemented in
      `src/lib/server/billing/autotopup.ts` and the Usage page.
- [x] Channel disconnect and full data removal — implemented in the channel
      detail route, not the old dashboard design location.
- [ ] Publish the Portuguese (`pt-BR`) product and legal translation with
      locale handling, deterministic formatting, and consent-version updates.
- [x] Add Mercado Pago as a second billing provider without changing Stripe
      behavior; the first slice is BRL prepaid checkout with idempotent signed
      webhooks. A provider-neutral checkout seam lives in
      `src/lib/server/billing/providers.ts`; full refund/dispute reconciliation
      is now covered for Mercado Pago, while auto top-up remains Stripe-only.
- [ ] Replace legal operator placeholders (`[legal name]`, CNPJ, and address)
      in Terms and Privacy before production launch.

## Deferred quality refactors (low value; keep the suite green)

Test/script helpers and large test files flagged by Lizard (Codacy) nloc/ccn —
refactor only when the file is touched anyway; no security/correctness impact.

- [ ] `src/lib/server/testdb.ts` — `createTestDb` is ~198 lines (limit 100):
      split the per-table seeding helpers.
- [ ] `scripts/seed-dev.mjs` — `seedChannel` ~75 lines (limit 50).
- [ ] `src/routes/consent/consent.test.ts` — `captureAction` ~383 lines
      (test helper).
- [ ] `src/routes/connect-channel/connect-channel.test.ts` — `loadWith`
      ~109 lines (test helper).
- [ ] Large test files (Lizard file-nloc): `pipeline.test.ts` (~1905),
      `org.test.ts` (~951), `deletion.test.ts` (~1061), `youtube.test.ts`
      (~762), `pipeline.reconciliation.pbt.test.ts` (~844), `actions.test.ts`
      (~784), `billing/autotopup.test.ts` (~714). Split helpers out or accept
      the metric (tests).
- [ ] `src/lib/server/pipeline.ts:307` — SonarQube MINOR S1940: use `<=`
      instead of `!… < …` (trivial, no behavior change).
- [ ] Locale on prerendered legal pages: `terms`/`privacy`/`dpa` export
      `prerender = true`, so the root layout's locale is baked at build time
      for those pages (codex, deferred as architectural — revisit when the
      pt-BR legal translation ships).

## Documentation and release readiness
- [ ] Triage the seven existing Svelte warnings in the UI components and
      account page.

## Codacy dashboard cleanups (settings clicks — no code)

- [ ] Delete the custom **"Enforce Access to RAC_\* Tables in SQL Queries"**
      pattern in Codacy → Code patterns (leftover from another project; the
      repo-side `.codacy.yml` Semgrep `drizzle/**` exclusion already hides the
      26 false positives).
- [ ] Mark "won't fix" (per-issue) for the remaining false positives: XSS on
      test HTML assertions, `contact.ts:285` escaped email template,
      `rules.ts:151` I6-gated `new RegExp`, package.json variant versions,
      `.agents/skills-src/*/skill_prehook.py` broad-`except`/`pass` (hooks must
      exit 0), `app.css` unknown rules, `tsconfig.json` JSONC parse artifact,
      `package-lock.json` file-length, `netlify-migrate.test.mjs` /
      `pre-push-gate.mjs` / `tonePrompt.js` "looks like JS template string".

