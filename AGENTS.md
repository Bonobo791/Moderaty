# Repository Guidelines

## Agent Role

Act as a pragmatic repository contributor: make the smallest safe change,
validate it, and leave unrelated work untouched.

# Rules
Always fail loudly. 
NEVER write fallbacks that are silent.
ALWAYS write fallbacks that are loud, log to the server, and show to the user.
Always run codacy before committing any work.
Every test must fail if the real logic is wrong. If a test still passes when the function returns garbage, rewrite the test.
DO NOT copy and paste code. DO create reusable code.

## Git & Review Workflow (execution plan v3, section 0)

Human review happens via pull requests. Executor rules:

- **One branch per phase**, created from an up-to-date `main`:
  `phase-a-scaffold`, `phase-b-database`, `phase-c-server-libs`,
  `phase-d-tests`, `phase-e-auth-cron`, `phase-f-ui`, `phase-g-design`,
  `phase-h-e2e`.
- **Commit after every step** with message `step <N>: <step name>`.
- **Never open a PR while `npm run check`, `npm run build`, or `npm run test`
  is red.** The PR is the proof of green, not the place to discover red.
- After a phase's last step passes its Verify: push, open the PR to `main`,
  then **STOP** until the human confirms the merge. Resume with
  `git checkout main && git pull` and the next phase branch.
- **Never** push to `main` directly, never merge your own PR, never `--force`.
- **Every review finding (human or bot) gets a failing test BEFORE its fix.**
  Add the reproducing test to the phase branch, watch it fail, then fix, watch
  it pass, commit both together (`fix: phase <X> review — <what>`), push, stop
  for re-review. A fix without its reproducing test is not done.

## Invariants (execution plan v3, section 4.1 — re-read before every step)

- **I1 — Everything external is optional.** Treat every field of every
  YouTube/Google/OpenAI response as nullable. A malformed *item* is skipped
  (and counted); a malformed *response* throws. Never abort a batch over one
  bad item.
- **I2 — Validate at every boundary.** Out-of-range or wrong-typed external
  data = that API call failed. Never clamp, never pass through.
- **I3 — DB before remote.** Record the intended enforcement action locally
  (`status='action_pending'`, `pendingAction=<action>`) BEFORE any YouTube
  write; confirm after. A crash in between is reconciled next run.
- **I4 — Idempotency.** Re-running any step is safe: comments dedupe by
  `comments.id`; YouTube moderation calls are naturally idempotent;
  reconciliation is driven by `action_pending` rows.
- **I5 — Never overwrite a caller's AbortSignal.** Compose with
  `AbortSignal.any([caller, timeout])` (see `src/lib/server/http.ts`).
- **I6 — User regexes are validated by recheck before compiling.** Every
  user-supplied pattern must pass `recheck` plus the syntax guards in
  `src/lib/server/rules.ts` (backreferences, duplicate alternation, length);
  unsafe or unprovable (`unknown`) patterns are rejected loudly at the form.
  Never compile a user pattern without this validation.
  (Reconciled: plan v3 mandated the `re2` engine; `main` adopted recheck
  validation + native compile as the accepted approach — same ReDoS
  guarantee, no native dependency. Do not swap engines without a maintainer
  decision.)
- **I7 — Expand-migrate-contract.** New columns are nullable; the migration
  (`npm run db:migrate`) is run and verified BEFORE code that reads those
  columns is exercised.
- **I8 — Dry run changes nothing durable.** With `DRY_RUN=true`: no YouTube
  writes, no `comments` inserts, no cursor/checkpoint updates. Only
  `audit_log` rows with action `dry-run`.
- **I9 — Tests are the spec.** No PR opens while checks/tests are red.
- **I10 — Bounded runs.** One channel per cron invocation (least-recently-run
  first), one page (≤100 comments) per run. Bursts drain across runs via the
  persisted checkpoint — never skipped, never unbounded.
- **I11 — AI failure → human queue.** If moderation scoring fails or returns
  invalid data, that comment lands in the review queue (`decidedBy='none'`).
  Never auto-approve, never auto-reject, never abort the batch.
- **I12 — Every page has all four states.** Loading (skeleton), empty
  (EmptyState component), error (`.error-box`), and populated. No blank
  screens, no raw unstyled errors.
- **I13 — Interactive elements are labeled.** Every input, select, and button
  has a visible label or an `aria-label`; action buttons name their target
  ("Reject comment by Ann", not "Reject"). Focus states are never removed
  without a visible replacement.

## Review Rules (learned from PR #4)

Security:

- Never return secrets, tokens, or raw third-party API responses to the
  client. Log full details on the server; return a generic error message.
- OAuth flows must use a `state` parameter: random value, HttpOnly cookie,
  verified in the callback.
- Routes that enroll, modify, or trigger privileged work must authenticate
  the caller and check ownership before acting.

Reliability:

- Validate required environment variables at handler start and throw a
  descriptive `error(500, ...)`; never use non-null assertions (`env.X!`).
  Failing loudly means failing with a clear message.
- In SvelteKit server code, read env vars via `$env/dynamic/private`
  (or `$env/static/private`), never `process.env`.
- Check `res.ok` before calling `.json()` on any external API response,
  and fail loudly on non-OK statuses.
- Build URLs with `new URL(path, base)` instead of string interpolation.

Architecture:

- Never replace an existing concurrency/scaling mechanism (leases, queues,
  batching) with a simpler synchronous loop. If a plan step conflicts with
  merged behavior, stop and reconcile with main instead of overwriting it.
- Cron/background work must isolate per-item failures and stay within
  serverless time limits.

Process:

- Keep PR title, description, and diff in sync; do not merge while a step's
  Verify failed or reviewer HIGH/P1 findings are unresolved.
- New complex server logic ships with tests for behavior (token exchange
  failure paths, auth rejection, per-channel error capture), per the
  existing test rule.

## Project Structure

Moderaty is a SvelteKit 2 app using Svelte 5 and TypeScript. Routes live in
`src/routes/`; reusable code belongs in `src/lib/`, with server-only modules in
`src/lib/server/`. Put static files in `static/`. Configure adapter-netlify in
`svelte.config.js`; Netlify deploys endpoints as standard Node Functions. Keep
`vite.config.ts` for Vite-only settings. Do not edit
generated `.svelte-kit/` files or commit build output.

The cron trigger is a Netlify Scheduled Function in
`netlify/functions/cron.mjs` (every minute during early operation — raise to
`*/15 * * * *` when user volume grows; calls `GET $APP_URL/api/cron`
with the secret in an `Authorization: Bearer` header; the endpoint also keeps
the plan-documented `?secret=` query form for manual triggers). Deployment
steps live in [DEPLOY.md](DEPLOY.md).

Approved dependencies only (execution plan v3): `drizzle-orm`,
`@libsql/client`, the SvelteKit adapter, `recheck` (runtime); `drizzle-kit`,
`vitest` (dev). No auth libraries, no googleapis SDK, no OpenAI SDK, no CSS
frameworks, no zod. UI copy uses the brand **Moderaty** — the string `yt-mod`
must not appear in `src/`.

## Accounts & Sessions

Moderaty is multi-user. Sign-in is Google identity only
(`/api/auth/google/login`, scopes `openid email profile`); YouTube channel
connection is a separate consent (`/api/auth/google`, `youtube.force-ssl`)
that requires a session and attaches the channel to the caller. Sessions are
DIY by design — **no auth library**: `src/lib/server/session.ts` (random
32-byte token, `sessions` table, httpOnly `moderaty_session` cookie, 30-day
sliding expiry). `src/hooks.server.ts` populates `locals.user`; the `(app)`
layout redirects signed-out visitors to `/login`; every form action must call
`requireUser(locals)` and scope every channel query/mutation by
`channels.userId` (another user's channel always reads as 404 — never leak
existence). Pre-accounts "orphan" channels (`user_id IS NULL`) are claimed by
the first user ever to complete account creation. Self-hosted instances use
the same code path; BYOK is via env (`GOOGLE_CLIENT_ID/SECRET`,
`OPENAI_API_KEY`, Turso), so self-hosters never cost the hosted operator.
`users.plan` is the hook for the future Stripe integration (hosted plans;
free tier = self-hosted only).

Accounts are created only by the **consent interstitial**, never by the OAuth
callback itself: login parks the identity in the encrypted
`moderaty_consent_pending` cookie (a bounded list keyed by the flow's OAuth
state so concurrent tabs cannot collide; 10-minute TTL, helpers in
`src/lib/server/legal.ts`) and redirects to `/consent?state=...`, where a
required 18+/ToS/PP/DPA checkbox — rendered unticked, must be ticked to
continue — plus an optional unbundled marketing opt-in gates a
single transaction that creates the user and writes a `consents` row
(userId, `doc_version`, exact checkbox text, IP, user agent) — the
evidentiary log. The visible checkbox sentence is rendered from
`CONSENT_CHECKBOX_TEXT` itself (the load passes it to the page;
`src/lib/consentText.ts` splits it into text/link segments), so the page can
never drift from the logged text. On material legal-doc changes bump `LEGAL_VERSION`
(declared with the documents in `src/lib/landing/legal.ts`, re-exported from
`src/lib/server/legal.ts`); users whose consent predates it are routed back
through `/consent` on next login.

## Commands

Use Node 24 and npm 11.

- `npm run dev` — start local development.
- `npm run check` — run SvelteKit sync and strict diagnostics.
- `npm run build` — create the Netlify deployment build.
- `npm run preview` — serve the production build locally.
- `npm run db:migrate` — apply Drizzle migrations from `drizzle/` (loads
  `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment; source `.env`
  first — drizzle-kit does not auto-load it).
- `npm run test` — run the Vitest suite (see
  `src/routes/api/auth/google/oauth.test.ts`).

`npm run check`, `npm run build`, and `npm run test` are required before a PR.

## Code Style

Use TypeScript and Svelte 5 runes (`$state`, `$derived`, `$props`, and
`{@render}`) for new code. Keep legacy `export let`, `$:`, or `<slot>` syntax
only for a documented, maintainer-approved compatibility exception. Use tabs
and SvelteKit `+page`, `+layout`, and `+server` conventions. Prefer `$lib`
imports, platform APIs, and installed dependencies.

## Commits, Security, and Licensing

Use focused, imperative commits such as `step N: <change>` or `chore: <change>`.
PRs need behavior, verification, linked issues, and UI screenshots where useful;
contributors must complete the Contributor License Agreement (CLA). Keep secrets
out of commits: document non-sensitive values in `.env.example`, keep `.env` and
`.env.*` ignored, and reserve `.env.test` for test configuration. Commit a
secret-like test value only when it is synthetic and a maintainer approves the
documented exception. Preserve [LICENSE](LICENSE) and [COMMERCIAL.md](COMMERCIAL.md).
Do not store comment text longer than 500 characters. Never persist
comment-author identifiers (`author_name`, `author_channel_id`) — they are
processed in memory at decision time only. Public copy (landing, FAQ, legal
docs) must match actual storage: comment text is stored with the moderation
outcome, author identities are never stored; the consistency guard lives in
`src/lib/landing/legal.test.ts`.

## License Headers

Add this notice to new comment-capable source and documentation files, using
the file's native comment syntax. Do not add comment headers to JSON or other
data formats.

```text
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
```
