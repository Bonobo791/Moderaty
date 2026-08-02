# EXECUTION PLAN: Moderaty — YouTube Comment Auto-Moderator (MVP) — v3

> Hand this entire document to the executor model. It has no other context.
> Everything it needs is written here. Follow the steps in order and improvise nothing.
> The app is named **Moderaty** (brand name — use it in nav, page titles, and copy; the
> project directory stays `yt-mod` to avoid churn).
> v2 changes: invariant appendix (§4.1), checkpoint-based burst draining, DB-before-remote
> action pipeline, RE2 for user regexes, response validation at every external boundary,
> a mandatory test phase, and PR gates tied to tests.
> v3 changes: Phase G is now a full UI/design pass (design tokens, styled pages,
> empty/loading/error states, a11y); the e2e phase moved to Phase H.

---

## 0. Git & review workflow (mandatory)

This project is reviewed by a human via pull requests. The executor's branching rules:

- **Step 0 (before anything else):** after Step 1's scaffold, run `git init && git add -A && git commit -m "chore: initial scaffold"`.
- **One branch per phase.** Phases: `phase-a-scaffold`, `phase-b-database`, `phase-c-server-libs`, `phase-d-tests`, `phase-e-auth-cron`, `phase-f-ui`, `phase-g-design`, `phase-h-e2e`. Before a phase's first step: `git checkout main && git pull && git checkout -b <branch>`.
- **Commit after every step** with message `step <N>: <step name>`.
- **Never open a PR while `npm run check`, `npm run build`, or `npm run test` is red.** Fix first. The PR is the proof of green, not the place to discover red.
- **When a phase's last step passes its Verify and everything is green:** push and open the PR:
  ```bash
  git push -u origin <branch>
  gh pr create --base main --title "Phase <X>: <name>" --body "Automated PR. All checks green locally. Do not merge if any step's Verify failed."
  ```
  (No `gh` CLI → push and print the compare URL instead.)
- **Then STOP.** Do not start the next phase until the human confirms merge. Resume with `git checkout main && git pull` and the next phase branch.
- **Never** push to `main` directly, never merge your own PR, never `--force`.
- **Review findings (human or bot): every finding gets a failing test BEFORE its fix.** Add the reproducing test to the phase branch, watch it fail, then fix, watch it pass, commit both together (`fix: phase <X> review — <what>`), push, stop for re-review. A fix without its reproducing test is not done.
- Steps 27–28 (credentials + live smoke test) require human action; open the Phase H PR after everything achievable autonomously and list remaining manual checks in the PR body.

---

## 1. Goal

By the end, there is a working SvelteKit app `yt-mod` that:

1. Lets a YouTube channel owner connect their channel via Google OAuth (scope `youtube.force-ssl`, offline access). The AES-256-GCM-encrypted refresh token is stored in the DB.
2. Stores per-channel rules: keyword, regex (recheck-validated), or blocked-user, each mapping to `hold` | `reject` | `delete` | `ban`.
3. Exposes `GET /api/cron?secret=<CRON_SECRET>` which processes **one channel per run** (least-recently-run first) and **one page of ≤100 comments per run**, with a persisted checkpoint (continuation token + high-water mark) so bursts larger than one page are drained across runs **without skipping comments**. Per comment: rule match first, then OpenAI Moderation. Score ≥ 0.95 → auto-ban (reject + ban author); 0.76–0.94 → auto-reject; 0.51–0.75 → human review queue; ≤ 0.50 → approved. Rule hits execute their configured action. **Every enforcement action is recorded in the DB (`action_pending`) BEFORE the YouTube write, then confirmed after** — a crash mid-run is reconciled on the next run, never repeated blindly and never lost.
4. Has four pages — dashboard (`/`), rules editor, review queue (one-click approve/reject/delete/ban), audit log — with a finished visual design (brand "Moderaty", design tokens, styled components, empty/loading/error states, accessible markup).
5. Supports `DRY_RUN=true`: classifies and writes audit rows (action `dry-run`) but performs **no** YouTube writes and **no** DB state changes (no comment rows, no cursor/checkpoint movement) — previews are repeatable.
6. `npm run check`, `npm run build`, `npm run test` all exit 0.

## 2. Current state & fixed facts

Greenfield. Node ≥ 20, npm, SvelteKit 2 + Svelte 5 + TypeScript. DB: SQLite via libSQL (`file:local.db` dev; Turso URL prod — same code).

API facts (use exactly; do not look up alternatives):

- YouTube Data API v3 base: `https://www.googleapis.com/youtube/v3`
  - List: `GET /commentThreads?part=snippet&allThreadsRelatedToChannelId={CHANNEL_ID}&order=time&maxResults=100&pageToken={TOKEN}&textFormat=plainText`
  - Moderate (batch ≤50 IDs): `POST /comments/setModerationStatus?id={CSV_IDS}&moderationStatus={heldForReview|rejected}&banAuthor={true|false}`
  - Delete: `DELETE /comments?id={COMMENT_ID}`
  - Channel lookup: `GET /channels?part=snippet&mine=true`
- OAuth: auth URL `https://accounts.google.com/o/oauth2/v2/auth`, token endpoint `https://oauth2.googleapis.com/token`. Auth URL params: `client_id`, `redirect_uri`, `response_type=code`, `scope=https://www.googleapis.com/auth/youtube.force-ssl`, `access_type=offline`, `prompt=consent`.
- OpenAI Moderation: `POST https://api.openai.com/v1/moderations`, header `Authorization: Bearer $OPENAI_API_KEY`, body `{ "model": "omni-moderation-latest", "input": "<text>" }`. Response: `results[0].category_scores` (category → float).
- Toxicity categories: `harassment`, `harassment/threatening`, `hate`, `hate/threatening`, `illicit`, `illicit/violent`, `self-harm`, `self-harm/intent`, `self-harm/instructions`, `sexual`, `sexual/minors`, `violence`, `violence/graphic`. Comment AI score = max of these thirteen. Spam is NOT an AI category; users catch spam with their own rules.
- Thresholds (fixed): AUTO_BAN = 0.95, AUTO_REJECT = 0.76, QUEUE = 0.51.
- Tone pass (per-channel, `channels.tone_level`: null/1 = "Edge Lord" omni-only, 2 = "Edge lord + Ackchyually…" omni + tone): `POST https://api.openai.com/v1/chat/completions` with `gpt-4.1-nano` (env override `OPENAI_TONE_MODEL`), `temperature: 0`, `response_format: json_object`. The system prompt embeds the calibrated rubric: 0.00–0.50 acceptable, 0.51–0.75 borderline, 0.76–0.94 clearly demeaning, 0.95–1.00 reserved and rare (genuine harm WITHOUT verbal abuse — targeted harassment, dogpiling, manipulation). The video's title and truncated (500-char) description are passed as context, fetched once per run via one batched `videos.list` call. Identical decision bands as omni — tone ≥0.95 bans. The stronger signal decides; the tone call is skipped when omni already rejects (≥0.76); either call failing routes the comment to the human queue (I11). The dashboard channel card carries the level slider and the completed-ban count ("X Edge Lords Banned").
- **Every field in every external response is optional until validated.** YouTube omits `authorChannelId` for deleted accounts; OpenAI may return out-of-range values. Handle per the invariants — never abort a batch over one malformed item.
- Top-level comments only (replies are a non-goal).

## 3. Files

**Read before starting:** after scaffolding — `svelte.config.js`, `package.json`, `src/app.d.ts`, `vite.config.ts`.

**Do not open or touch:** `node_modules/`, `.svelte-kit/`, anything not listed below.

**Create or modify:**
- `svelte.config.js` — modify (adapter-node)
- `package.json` — modify (add `db:push` and `test` scripts)
- `.env`, `.gitignore` — create / modify
- `drizzle.config.ts` — create
- `src/lib/server/db/schema.ts` — create
- `src/lib/server/db/index.ts` — create
- `src/lib/server/crypto.ts` — create
- `src/lib/server/http.ts` — create (fetch wrapper)
- `src/lib/server/youtube.ts` — create
- `src/lib/server/moderation.ts` — create
- `src/lib/server/rules.ts` — create (recheck-validated matcher)
- `src/lib/server/pipeline.ts` — create
- `src/lib/EmptyState.svelte` — create (Phase G)
- `src/lib/Skeleton.svelte` — create (Phase G)
- `src/lib/server/testdb.ts` — create (test helper; never imported by app code)
- `src/lib/server/rules.test.ts` — create
- `src/lib/server/moderation.test.ts` — create
- `src/lib/server/youtube.test.ts` — create
- `src/lib/server/pipeline.test.ts` — create
- `src/routes/api/auth/google/+server.ts` — create
- `src/routes/api/auth/google/callback/+server.ts` — create
- `src/routes/api/cron/+server.ts` — create
- `src/app.css` — create
- `src/routes/+layout.svelte` — modify
- `src/routes/+page.server.ts`, `src/routes/+page.svelte` — create / modify
- `src/routes/channels/[id]/rules/+page.server.ts`, `+page.svelte` — create
- `src/routes/channels/[id]/queue/+page.server.ts`, `+page.svelte` — create
- `src/routes/channels/[id]/log/+page.server.ts`, `+page.svelte` — create

## 4. Constraints

**Do NOT:**
- Do not add dependencies beyond: `drizzle-orm`, `@libsql/client`, `@sveltejs/adapter-node`, `recheck` (runtime) and `drizzle-kit`, `vitest` (dev). No auth libraries, no googleapis SDK, no OpenAI SDK, no CSS frameworks, no zod.
- Do not run user-supplied regexes without a ReDoS-safety check — recheck validation only (see I6).
- Do not commit or push to `main`; never merge your own PR; never open a PR with red checks.
- Do not refactor, rename, or reformat anything outside the steps.
- Do not add features, error handling, or abstractions not listed.
- Do not store comment text longer than 500 characters.
- Do not guess API signatures — every external call is written in this document.
- Do not commit `.env` or `local.db*`.

**Non-goals (look related, but are NOT part of this task):**
- Reply moderation (requires its own `comments.list?parentId` pagination design — explicitly deferred).
- LLM-as-judge for borderline comments (borderline → human queue instead).
- Stripe/billing, landing page, multi-platform moderation, deployment config, live chat, real-time scanning.

### 4.1 Invariants (non-negotiable; re-read before every step)

- **I1 — Everything external is optional.** Treat every field of every YouTube/Google/OpenAI response as nullable. Missing optional metadata → default (`'unknown'` / `''`). A malformed *item* is skipped (and counted); a malformed *response* throws. Never abort a batch over one bad item.
- **I2 — Validate at every boundary.** Out-of-range or wrong-typed external data (e.g., a moderation score of `1.7`) = that API call failed. Follow the module's failure policy; never clamp, never pass through.
- **I3 — DB before remote.** Record the intended enforcement action locally (`status='action_pending'`, `pendingAction=<action>`) BEFORE any YouTube write; confirm (set final status) after. Crash between = reconciled next run from the durable record.
- **I4 — Idempotency.** Re-running any step is safe: comments dedupe by `comments.id`; YouTube moderation calls are naturally idempotent; reconciliation is driven by `action_pending` rows.
- **I5 — Never overwrite a caller's AbortSignal.** Compose with `AbortSignal.any([caller, timeout])` (see `http.ts`).
- **I6 — User regexes are validated by recheck before execution** (ReDoS-prone patterns are rejected at the form with a validation error; unprovable/`unknown` patterns are rejected loudly). **Reconciliation note:** v3 originally mandated the `re2` engine here; the merged implementation instead validates every user pattern with `recheck` (plus explicit guards for backreferences and duplicate-alternation blind spots) before compiling with the native engine. This provides the same safety guarantee — catastrophic backtracking is impossible because unsafe patterns never compile — without a native dependency. Adopted as the accepted approach; do not swap engines without a maintainer decision.
- **I7 — Expand-migrate-contract.** New columns are nullable; `npm run db:push` is run and verified BEFORE any code that reads those columns is exercised.
- **I8 — Dry run changes nothing durable.** With `DRY_RUN=true`: no YouTube writes, no `comments` inserts, no cursor/continuation/high-water updates. Only `audit_log` rows with action `dry-run`. Previews must be repeatable against the same comments.
- **I9 — Tests are the spec.** No PR opens while checks/tests are red; every review finding gets a failing test before its fix.
- **I10 — Bounded runs.** One channel per cron invocation (least-recently-run first), one page (≤100 comments) per run. Bursts drain across runs via the persisted checkpoint — never skipped, never unbounded.
- **I11 — AI failure → human queue.** If moderation scoring fails or returns invalid data for a comment, that comment lands in the review queue (`decidedBy='none'`). Never auto-approve, never auto-reject, never abort the batch.
- **I12 — Every page has all four states.** Loading (skeleton), empty (EmptyState component with the verbatim copy from Step 26), error (`.error-box`), and populated. No blank screens, no raw unstyled errors.
- **I13 — Interactive elements are labeled.** Every input, select, and button has a visible label or an `aria-label`; action buttons name their target ("Reject comment by Ann", not "Reject"). Focus states are never removed without a visible replacement.

---

## 5. Steps

### Phase A — Scaffold (Steps 1–4)

#### Step 1: Scaffold

```bash
npx sv create --template minimal --types ts --no-add-ons --install npm yt-mod
cd yt-mod
git init && git add -A && git commit -m "chore: initial scaffold"
```

**Verify:** `ls` shows `package.json`, `svelte.config.js`, `src/`; `git log --oneline` shows one commit.

**If this fails:** if the `sv` CLI errors on flags, run `npx sv create yt-mod` interactively: minimal, TypeScript, no add-ons, npm. Otherwise stop, paste the error, report back.

#### Step 2: Install the exact dependency set

```bash
npm install drizzle-orm @libsql/client @sveltejs/adapter-node recheck
npm install -D drizzle-kit vitest
```

**Verify:** `npm ls drizzle-orm @libsql/client @sveltejs/adapter-node recheck drizzle-kit vitest` prints all six, no errors. Also `node -e "const { checkSync } = require('recheck'); console.log(checkSync('(a+)+$', 'i').status)"` prints `unsafe`.

**If this fails:**
- If `recheck` fails to install on this platform: stop, paste the full error, report back — do NOT substitute another regex-safety approach.
- Otherwise: stop, paste the error, report back.

#### Step 3: Switch to adapter-node

**File:** `svelte.config.js` — replace the adapter import line (`import adapter from '@sveltejs/adapter-auto';`) with:

```js
import adapter from '@sveltejs/adapter-node';
```

**Verify:** `grep adapter-node svelte.config.js` prints the line.

#### Step 4: `.env`, `.gitignore`, scripts

**File:** `.env` — create:

```
GOOGLE_CLIENT_ID=placeholder
GOOGLE_CLIENT_SECRET=placeholder
APP_URL=http://localhost:5173
TURSO_DATABASE_URL=file:local.db
TURSO_AUTH_TOKEN=
OPENAI_API_KEY=placeholder
CRON_SECRET=change-me-long-random-string
ENCRYPTION_KEY=placeholder-64-hex-chars
DRY_RUN=true
```

**File:** `.gitignore` — append `.env` and `local.db*`.

**File:** `package.json` — in `"scripts"` add `"db:push": "drizzle-kit push"` and `"test": "vitest run"`.

**Verify:** `grep -c '"db:push"\|"test"' package.json` prints `2`; `grep -c '^\.env$' .gitignore` prints `1`.

**If this fails:** if `.gitignore` is missing, create it with `.env`, `local.db*`, `node_modules`, `.svelte-kit`, `build`.

### Phase B — Database (Steps 5–7)

#### Step 5: Schema

**File:** `src/lib/server/db/schema.ts` — create with exactly:

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(), // YouTube channel ID (UC...)
  title: text('title').notNull(),
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  cursor: text('cursor'), // high-water mark: newest comment fully drained to
  continuationToken: text('continuation_token'), // pageToken to resume a capped burst; null = drained
  highWater: text('high_water'), // burst-start boundary; promoted to cursor when burst drains
  lastRunAt: text('last_run_at'), // null = never processed; cron picks ASC (nulls first)
  leaseExpiresAt: text('lease_expires_at'), // set while a cron run holds this channel; null or past = claimable
  active: integer('active').notNull().default(1),
  createdAt: text('created_at').notNull()
});

export const rules = sqliteTable('rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: text('channel_id').notNull(),
  type: text('type').notNull(), // 'keyword' | 'regex' | 'user'
  pattern: text('pattern').notNull(),
  action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban'
  createdAt: text('created_at').notNull()
});

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(), // YouTube comment ID
  channelId: text('channel_id').notNull(),
  authorChannelId: text('author_channel_id').notNull(), // 'unknown' when YouTube omits it
  authorName: text('author_name').notNull(),
  text: text('text').notNull(), // truncated to 500 chars
  publishedAt: text('published_at').notNull(),
  status: text('status').notNull(), // 'action_pending' | 'pending' | 'approved' | 'held' | 'rejected' | 'deleted'
  pendingAction: text('pending_action'), // 'hold' | 'reject' | 'delete' | 'ban' while action_pending; else null
  decidedBy: text('decided_by').notNull(), // 'rule' | 'ai' | 'human' | 'none'
  matchedRuleId: integer('matched_rule_id'),
  aiScore: text('ai_score'), // JSON of the thirteen category scores, or null
  createdAt: text('created_at').notNull()
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: text('channel_id').notNull(),
  commentId: text('comment_id').notNull(),
  action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban' | 'approve' | 'queue' | 'dry-run'
  reason: text('reason').notNull(),
  actor: text('actor').notNull(), // 'system' | 'user'
  createdAt: text('created_at').notNull()
});
```

Note: all dates are set explicitly at insert time (no column defaults) — I7 friendliness and simpler test DDL.

**Verify:** `grep -c sqliteTable src/lib/server/db/schema.ts` prints `4`; `grep -c continuation_token src/lib/server/db/schema.ts` prints `1`.

#### Step 6: DB client + drizzle config

**File:** `src/lib/server/db/index.ts` — create with exactly:

```ts
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

const client = createClient({
  url: env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: env.TURSO_AUTH_TOKEN || undefined
});

export const db = drizzle(client, { schema });
```

**File:** `drizzle.config.ts` — create with exactly:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/server/db/schema.ts',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
    token: process.env.TURSO_AUTH_TOKEN || undefined
  }
} as never);
```

**Verify:** `grep -c createClient src/lib/server/db/index.ts` prints `1`.

#### Step 7: Push schema (BEFORE any code uses the new columns — I7)

```bash
set -a; . ./.env; set +a; npm run db:push
```

**Verify:** exits 0; `local.db` exists; this prints all four table names:
```bash
node -e "const{createClient}=require('@libsql/client');createClient({url:'file:local.db'}).execute(\"SELECT name FROM sqlite_master WHERE type='table'\").then(r=>console.log(r.rows.map(x=>x.name).join(',')))"
```

**If this fails:** if drizzle-kit prompts about table creation, accept. If env missing, ensure the `set -a; . ./.env; set +a` prefix was used. Otherwise stop and report.

### Phase C — Server libraries (Steps 8–13)

#### Step 8: Token encryption helper

**File:** `src/lib/server/crypto.ts` — create with exactly:

```ts
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';

function key(): Buffer {
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required');
  return createHash('sha256').update(env.ENCRYPTION_KEY).digest();
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
```

**Verify:** file exists; build check comes at Step 13.

#### Step 9: Fetch wrapper (fixes I5 — signal composition, timeout)

**File:** `src/lib/server/http.ts` — create with exactly:

```ts
export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
  }
}

/**
 * fetch with a default 10s timeout. The caller's AbortSignal is NEVER
 * overwritten — it is composed with the timeout via AbortSignal.any (I5).
 */
export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<unknown> {
  const { timeoutMs = 10_000, signal: callerSignal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const res = await fetch(url, { ...rest, signal });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${url}: ${text.slice(0, 300)}`);
  }
}
```

**Verify:** `grep -c 'AbortSignal.any' src/lib/server/http.ts` prints `1`.

#### Step 10: YouTube API client (nullable-tolerant, checkpoint-aware)

**File:** `src/lib/server/youtube.ts` — create with exactly:

```ts
import { env } from '$env/dynamic/private';
import { fetchJson } from './http';

const YT = 'https://www.googleapis.com/youtube/v3';

export interface NewComment {
  id: string;
  authorChannelId: string; // 'unknown' when YouTube omits it (deleted accounts) — I1
  authorName: string;
  text: string;
  publishedAt: string;
}

export interface CommentPage {
  items: NewComment[];
  nextPageToken: string | null; // non-null when YouTube has more pages
  drained: boolean; // true when we reached the cursor or YouTube has no more pages
  skipped: number; // malformed items skipped (I1)
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const data = (await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  })) as { access_token?: unknown };
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error(`token refresh returned no access_token: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.access_token;
}

/**
 * Fetch ONE page of comment threads (≤100), newest first.
 * Stops collecting (drained) when a comment with publishedAt <= cursor is seen.
 * An item missing its comment id or publishedAt is skipped (counted), never fatal.
 * Optional author metadata defaults to 'unknown' / '' — never skipped for that (I1).
 */
export async function fetchCommentPage(
  channelId: string,
  accessToken: string,
  cursor: string | null,
  pageToken: string | null
): Promise<CommentPage> {
  const params = new URLSearchParams({
    part: 'snippet',
    allThreadsRelatedToChannelId: channelId,
    order: 'time',
    maxResults: '100',
    textFormat: 'plainText'
  });
  if (pageToken) params.set('pageToken', pageToken);
  const data = (await fetchJson(`${YT}/commentThreads?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })) as { items?: unknown; nextPageToken?: unknown };

  if (!Array.isArray(data.items)) {
    throw new Error(`commentThreads.list: response has no items array: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const items: NewComment[] = [];
  let drained = false;
  let skipped = 0;

  for (const raw of data.items) {
    const c = (raw as any)?.snippet?.topLevelComment;
    const s = c?.snippet;
    if (typeof c?.id !== 'string' || typeof s?.publishedAt !== 'string') {
      skipped++;
      continue;
    }
    if (cursor && s.publishedAt <= cursor) {
      drained = true;
      break;
    }
    items.push({
      id: c.id,
      authorChannelId: typeof s.authorChannelId?.value === 'string' ? s.authorChannelId.value : 'unknown',
      authorName: typeof s.authorDisplayName === 'string' ? s.authorDisplayName : 'unknown',
      text: (typeof s.textDisplay === 'string' ? s.textDisplay : '').slice(0, 500),
      publishedAt: s.publishedAt
    });
  }

  const nextPageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : null;
  if (!nextPageToken) drained = true;
  return { items, nextPageToken, drained, skipped };
}

export async function setModerationStatus(
  ids: string[],
  status: 'heldForReview' | 'rejected',
  banAuthor: boolean,
  accessToken: string
): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const params = new URLSearchParams({
      id: batch.join(','),
      moderationStatus: status,
      banAuthor: String(banAuthor)
    });
    await fetchJson(`${YT}/comments/setModerationStatus?${params}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  }
}

export async function deleteComment(id: string, accessToken: string): Promise<void> {
  try {
    await fetchJson(`${YT}/comments?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  } catch (e) {
    // 404 = already deleted (e.g. manually in YouTube Studio) — idempotent success (I4)
    if (e instanceof Error && e.message.startsWith('HTTP 404')) return;
    throw e;
  }
}
```

**Verify:** `grep -c 'export async function' src/lib/server/youtube.ts` prints `4`; `grep -c "'unknown'" src/lib/server/youtube.ts` prints `2`.

**If this fails:** stop, paste the error, report back.

#### Step 11: Moderation client (score validation — I2, I11)

**File:** `src/lib/server/moderation.ts` — create with exactly:

```ts
import { env } from '$env/dynamic/private';
import { fetchJson } from './http';

const TOXIC_CATEGORIES = [
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'violence',
  'violence/graphic'
] as const;

export interface ModerationResult {
  score: number;
  scores: Record<string, number>;
}

export class ModerationError extends Error {}

/**
 * Throws ModerationError on ANY invalid response: non-200, missing results,
 * or any toxic-category score that is not a finite number in [0, 1] (I2).
 * Callers treat ModerationError as "send to human queue" (I11) — never clamp.
 */
export async function scoreComment(text: string): Promise<ModerationResult> {
  let data: { results?: Array<{ category_scores?: Record<string, unknown> }> };
  try {
    data = (await fetchJson('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text })
    })) as typeof data;
  } catch (e) {
    throw new ModerationError(e instanceof Error ? e.message : String(e));
  }

  const cat = data.results?.[0]?.category_scores;
  if (!cat || typeof cat !== 'object') {
    throw new ModerationError(`missing category_scores: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const scores: Record<string, number> = {};
  let max = 0;
  for (const k of TOXIC_CATEGORIES) {
    const v = cat[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new ModerationError(`invalid score for ${k}: ${String(v)}`);
    }
    scores[k] = v;
    if (v > max) max = v;
  }
  return { score: max, scores };
}
```

**Verify:** `grep -c 'ModerationError' src/lib/server/moderation.ts` prints ≥ 3.

#### Step 12: Rule matcher (I6)

> **Reconciled:** this step originally specified an RE2-based matcher. The merged implementation validates every user pattern with `recheck` plus explicit syntax guards (backreferences, duplicate alternation, length), rejecting ReDoS-prone or unprovable patterns before compiling with the native engine — see I6 for the reconciliation note.

**File:** `src/lib/server/rules.ts` — the merged implementation is the source of truth; do not recreate it from this plan. In outline:

- `matchRule(text, authorChannelId, rules)` — first matching rule wins; keyword is a case-insensitive substring test, user is an exact author-ID match, regex compiles only after `recheck` validation and throws on invalid/unsafe stored patterns.
- `validateRule(rule)` — asserts supported type/action and non-empty pattern; regex patterns must compile and pass the safety check.
- Form validation rejects patterns that fail compilation or the recheck check, surfacing the reason as the validation error.

**Verify:** `grep -c recheck src/lib/server/rules.ts` prints ≥ 1; the rules suite in `src/lib/server/rules.test.ts` passes.

#### Step 13: The pipeline (DB-before-remote, checkpoint, dry-run)

**File:** `src/lib/server/pipeline.ts` — create with exactly:

```ts
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { channels, rules, comments, auditLog } from './db/schema';
import { decrypt } from './crypto';
import { refreshAccessToken, fetchCommentPage, setModerationStatus, deleteComment } from './youtube';
import { scoreComment, ModerationError } from './moderation';
import { matchRule } from './rules';

const AUTO_BAN = 0.95;
const AUTO_REJECT = 0.76;
const QUEUE = 0.51;

type PendingAction = 'hold' | 'reject' | 'delete' | 'ban';

const now = () => new Date().toISOString();

async function log(channelId: string, commentId: string, action: string, reason: string, actor: string) {
  await db.insert(auditLog).values({ channelId, commentId, action, reason, actor, createdAt: now() });
}

function finalStatusFor(action: PendingAction): 'held' | 'rejected' | 'deleted' {
  return action === 'hold' ? 'held' : action === 'delete' ? 'deleted' : 'rejected';
}

/**
 * Execute every action_pending row for the channel (I3): the DB record exists
 * BEFORE this runs, so a crash anywhere here is reconciled by the next run.
 */
async function applyPendingActions(channelId: string, accessToken: string): Promise<void> {
  const pend = await db
    .select()
    .from(comments)
    .where(and(eq(comments.channelId, channelId), eq(comments.status, 'action_pending')))
    .all();
  if (pend.length === 0) return;

  const byAction = (a: PendingAction) => pend.filter((c) => c.pendingAction === a).map((c) => c.id);
  const holdIds = byAction('hold');
  const rejectIds = byAction('reject');
  const banIds = byAction('ban');
  const deleteIds = byAction('delete');

  if (holdIds.length) await setModerationStatus(holdIds, 'heldForReview', false, accessToken);
  if (rejectIds.length) await setModerationStatus(rejectIds, 'rejected', false, accessToken);
  if (banIds.length) await setModerationStatus(banIds, 'rejected', true, accessToken);
  for (const id of deleteIds) await deleteComment(id, accessToken);

  for (const c of pend) {
    await db
      .update(comments)
      .set({ status: finalStatusFor(c.pendingAction as PendingAction), pendingAction: null })
      .where(eq(comments.id, c.id));
  }
}

export async function runChannel(
  channelId: string
): Promise<{ fetched: number; acted: number; queued: number; skipped: number }> {
  const zero = { fetched: 0, acted: 0, queued: 0, skipped: 0 };
  const ch = await db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!ch || !ch.active) return zero;
  const dryRun = process.env.DRY_RUN === 'true';

  const accessToken = await refreshAccessToken(decrypt(ch.refreshTokenEnc));

  // 1. Reconcile leftovers from any crashed prior run (real runs only, I3/I4).
  if (!dryRun) await applyPendingActions(channelId, accessToken);

  // 2. Fetch ONE page (I10), resuming from a stored continuation token if mid-burst.
  const page = await fetchCommentPage(channelId, accessToken, ch.cursor, ch.continuationToken);
  if (page.items.length === 0) {
    if (!dryRun) {
      await db
        .update(channels)
        .set(
          page.drained
            ? { continuationToken: null, highWater: null, lastRunAt: now() }
            : { continuationToken: page.nextPageToken, lastRunAt: now() }
        )
        .where(eq(channels.id, channelId));
    }
    return { ...zero, skipped: page.skipped };
  }

  const rs = await db.select().from(rules).where(eq(rules.channelId, channelId)).all();
  let acted = 0;
  let queued = 0;

  for (const c of page.items) {
    if (!dryRun) {
      const existing = await db.select({ id: comments.id }).from(comments).where(eq(comments.id, c.id)).get();
      if (existing) continue; // dedupe (I4)
    }

    const hit = matchRule(c.text, c.authorChannelId, rs);

    if (dryRun) {
      // I8: audit only — no comment rows, no cursor/checkpoint movement, no YouTube writes.
      if (hit) {
        await log(channelId, c.id, 'dry-run', `would ${hit.action} — rule #${hit.id} (${hit.type})`, 'system');
        acted++;
      } else {
        try {
          const m = await scoreComment(c.text);
          if (m.score >= AUTO_REJECT) {
            await log(channelId, c.id, 'dry-run', `would reject — ai score ${m.score.toFixed(2)}`, 'system');
            acted++;
          } else if (m.score >= QUEUE) {
            await log(channelId, c.id, 'dry-run', `would queue — ai score ${m.score.toFixed(2)}`, 'system');
            queued++;
          }
        } catch (e) {
          if (!(e instanceof ModerationError)) throw e;
          await log(channelId, c.id, 'dry-run', 'ai unavailable — would queue', 'system');
          queued++;
        }
      }
      continue;
    }

    if (hit) {
      // I3: durable intent row BEFORE any YouTube call.
      await db.insert(comments).values({
        id: c.id, channelId, authorChannelId: c.authorChannelId, authorName: c.authorName,
        text: c.text, publishedAt: c.publishedAt,
        status: 'action_pending', pendingAction: hit.action, decidedBy: 'rule',
        matchedRuleId: hit.id, aiScore: null, createdAt: now()
      });
      await log(channelId, c.id, hit.action, `rule #${hit.id} (${hit.type}: ${hit.pattern.slice(0, 80)})`, 'system');
      acted++;
    } else {
      let m = null;
      try {
        m = await scoreComment(c.text);
      } catch (e) {
        if (!(e instanceof ModerationError)) throw e; // I11: ModerationError → human queue
      }
      if (!m) {
        await db.insert(comments).values({
          id: c.id, channelId, authorChannelId: c.authorChannelId, authorName: c.authorName,
          text: c.text, publishedAt: c.publishedAt,
          status: 'pending', pendingAction: null, decidedBy: 'none',
          matchedRuleId: null, aiScore: null, createdAt: now()
        });
        await log(channelId, c.id, 'queue', 'ai unavailable', 'system');
        queued++;
      } else if (m.score >= AUTO_REJECT) {
        await db.insert(comments).values({
          id: c.id, channelId, authorChannelId: c.authorChannelId, authorName: c.authorName,
          text: c.text, publishedAt: c.publishedAt,
          status: 'action_pending', pendingAction: 'reject', decidedBy: 'ai',
          matchedRuleId: null, aiScore: JSON.stringify(m.scores), createdAt: now()
        });
        await log(channelId, c.id, 'reject', `ai score ${m.score.toFixed(2)}`, 'system');
        acted++;
      } else if (m.score >= QUEUE) {
        await db.insert(comments).values({
          id: c.id, channelId, authorChannelId: c.authorChannelId, authorName: c.authorName,
          text: c.text, publishedAt: c.publishedAt,
          status: 'pending', pendingAction: null, decidedBy: 'ai',
          matchedRuleId: null, aiScore: JSON.stringify(m.scores), createdAt: now()
        });
        await log(channelId, c.id, 'queue', `ai score ${m.score.toFixed(2)}`, 'system');
        queued++;
      } else {
        await db.insert(comments).values({
          id: c.id, channelId, authorChannelId: c.authorChannelId, authorName: c.authorName,
          text: c.text, publishedAt: c.publishedAt,
          status: 'approved', pendingAction: null, decidedBy: 'ai',
          matchedRuleId: null, aiScore: JSON.stringify(m.scores), createdAt: now()
        });
      }
    }
  }

  // 3. Execute all pending actions (theirs are durable; safe to batch now).
  if (!dryRun) await applyPendingActions(channelId, accessToken);

  // 4. Advance the checkpoint (real runs only — I8/I10).
  if (!dryRun) {
    if (!ch.continuationToken) {
      // Fresh burst: boundary = newest comment seen this page.
      const hw = page.items[0].publishedAt;
      await db
        .update(channels)
        .set(
          page.drained
            ? { cursor: hw, continuationToken: null, highWater: null, lastRunAt: now() }
            : { highWater: hw, continuationToken: page.nextPageToken, lastRunAt: now() }
        )
        .where(eq(channels.id, channelId));
    } else {
      // Resuming a burst: cursor only advances (to highWater) when fully drained.
      await db
        .update(channels)
        .set(
          page.drained
            ? { cursor: ch.highWater, continuationToken: null, highWater: null, lastRunAt: now() }
            : { continuationToken: page.nextPageToken, lastRunAt: now() }
        )
        .where(eq(channels.id, channelId));
    }
  }

  return { fetched: page.items.length, acted, queued, skipped: page.skipped };
}
```

**Verify:** `npm run check` exits 0 (or lists only errors in files not yet created — none should reference pipeline.ts). `grep -c 'applyPendingActions' src/lib/server/pipeline.ts` prints `3`.

**If this fails:** if drizzle `.get()`/`.all()` are unknown, `npm install drizzle-orm@latest`. Otherwise stop and report.

---

### Phase D — Tests (Steps 14–15)

Tests are the executable spec (I9). Implement EVERY case in the tables below. Verbatim code is given for the harness and representative tests; the remaining table rows follow the same patterns exactly.

#### Step 14: Test harness + rules/moderation/youtube tests

**File:** `src/lib/server/testdb.ts` — create with exactly:

```ts
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './db/schema';

const DDL = `
CREATE TABLE channels (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, refresh_token_enc TEXT NOT NULL,
  cursor TEXT, continuation_token TEXT, high_water TEXT, last_run_at TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL,
  type TEXT NOT NULL, pattern TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_channel_id TEXT NOT NULL,
  author_name TEXT NOT NULL, text TEXT NOT NULL, published_at TEXT NOT NULL,
  status TEXT NOT NULL, pending_action TEXT, decided_by TEXT NOT NULL,
  matched_rule_id INTEGER, ai_score TEXT, created_at TEXT NOT NULL
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, comment_id TEXT NOT NULL,
  action TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

export async function makeTestDb() {
  const client = createClient({ url: ':memory:' });
  for (const stmt of DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }
  return drizzle(client, { schema });
}

export async function clearDb(db: Awaited<ReturnType<typeof makeTestDb>>) {
  await db.delete(schema.auditLog);
  await db.delete(schema.comments);
  await db.delete(schema.rules);
  await db.delete(schema.channels);
}
```

**File:** `src/lib/server/rules.test.ts` — create with exactly:

```ts
import { describe, it, expect } from 'vitest';
import { matchRule, validateRule } from './rules';

const base = { id: 1, action: 'reject' };

describe('matchRule', () => {
  it('keyword matches case-insensitively', () => {
    expect(matchRule('This is SPAM now', 'UC1', [{ ...base, type: 'keyword', pattern: 'spam' }])).not.toBeNull();
  });
  it('keyword does not match absent text', () => {
    expect(matchRule('nice video', 'UC1', [{ ...base, type: 'keyword', pattern: 'spam' }])).toBeNull();
  });
  it('user rule matches authorChannelId', () => {
    expect(matchRule('anything', 'UCbad', [{ ...base, type: 'user', pattern: 'UCbad' }])).not.toBeNull();
  });
  it('regex matches', () => {
    expect(matchRule('free money!!!', 'UC1', [{ ...base, type: 'regex', pattern: 'free m+ney' }])).not.toBeNull();
  });
  it('unsafe regex (catastrophic backtracking) is rejected loudly', () => {
    expect(() => matchRule('a'.repeat(5000), 'UC1', [{ ...base, type: 'regex', pattern: '(a+)+$' }])).toThrow(/unsafe regex/);
  });
  it('first matching rule wins', () => {
    const rs = [
      { id: 1, type: 'keyword', pattern: 'spam', action: 'hold' },
      { id: 2, type: 'keyword', pattern: 'spam', action: 'ban' }
    ];
    expect(matchRule('spam', 'UC1', rs)?.action).toBe('hold');
  });
});

describe('rule validation (reconciled: merged code exposes validateRule, not validatePattern)', () => {
  it('rejects empty pattern', () => expect(() => validateRule({ ...base, type: 'keyword', pattern: '' })).toThrow(/empty pattern/));
  it('rejects unsafe regex via recheck', () => expect(() => validateRule({ ...base, type: 'regex', pattern: '(a+)+$' })).toThrow(/unsafe regex/));
  it('accepts valid regex', () => expect(() => validateRule({ ...base, type: 'regex', pattern: 'free m+ney' })).not.toThrow());
});
```

**File:** `src/lib/server/moderation.test.ts` — create with the skeleton below, implementing EVERY case in the table (mock `fetch` globally with `vi.stubGlobal('fetch', vi.fn())`; restore in `afterEach`). Set `process.env.OPENAI_API_KEY = 'test'` in `beforeAll`.

```ts
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { scoreComment, ModerationError } from './moderation';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test';
});
afterEach(() => vi.unstubAllGlobals());

function okResponse(scores: Record<string, number>) {
  return new Response(JSON.stringify({ results: [{ category_scores: scores }] }), { status: 200 });
}

describe('scoreComment', () => {
  it('M1: returns max of the thirteen toxic categories', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ harassment: 0.4, 'harassment/threatening': 0.1, hate: 0.9, 'hate/threatening': 0.1, illicit: 0.1, 'illicit/violent': 0.1, 'self-harm': 0.1, 'self-harm/intent': 0.1, 'self-harm/instructions': 0.1, sexual: 0.1, 'sexual/minors': 0.1, violence: 0.1, 'violence/graphic': 0.1 })));
    const m = await scoreComment('x');
    expect(m.score).toBe(0.9);
    expect(m.scores.hate).toBe(0.9);
  });
  // …implement M2–M9 per the table below following this pattern…
});
```

Note: a missing key among the thirteen is INVALID (throws), per the module code and I2. Required cases:

| # | Mocked API behavior | Expected |
|---|---|---|
| M1 | 200, thirteen valid scores, max = hate 0.9 | `score === 0.9`, `scores.hate === 0.9` |
| M2 | 200, score exactly 0.95 | returns 0.95 (boundary belongs to caller, not this module) |
| M3 | 200, one score = 1.7 | throws `ModerationError` |
| M4 | 200, one score = -0.2 | throws `ModerationError` |
| M5 | 200, one score = "high" (string) | throws `ModerationError` |
| M6 | 200, one of the thirteen keys missing | throws `ModerationError` |
| M7 | 200, `results` missing | throws `ModerationError` |
| M8 | 500 status | throws `ModerationError` |
| M9 | 200, non-JSON body | throws `ModerationError` |

**File:** `src/lib/server/youtube.test.ts` — implement every case (same `vi.stubGlobal('fetch')` pattern; the module reads `GOOGLE_CLIENT_ID/SECRET` only inside `refreshAccessToken`, so page/moderation tests need no env):

| # | Mocked YouTube response | Expected from `fetchCommentPage('UC', 'tok', cursor, pageToken)` |
|---|---|---|
| Y1 | 2 valid items, no nextPageToken | 2 items, `drained: true`, `skipped: 0` |
| Y2 | item missing `authorChannelId` | item kept, `authorChannelId === 'unknown'` |
| Y3 | item missing `authorDisplayName` and `textDisplay` | item kept, name `'unknown'`, text `''` |
| Y4 | item missing `topLevelComment.id` | item skipped, `skipped === 1`, others kept |
| Y5 | item missing `publishedAt` | item skipped |
| Y6 | 3 items, middle item `publishedAt <= cursor` | returns only items newer than cursor, `drained: true` |
| Y7 | `nextPageToken` present | `nextPageToken` returned, `drained: false` |
| Y8 | request URL when `pageToken` arg given | fetch URL contains `pageToken=...` |
| Y9 | 403 quotaExceeded body | throws (message contains `HTTP 403`) |
| Y10 | `items` not an array | throws |
| Y11 | text 600 chars | stored text is exactly 500 chars |

**Verify:** `npm run test` exits 0, all suites green.

**If this fails:** fix the TEST to match the verbatim module code (the modules are the spec), unless the test exposes a genuine invariant violation — in that case stop and report instead of editing either side blindly.

#### Step 15: Pipeline tests

**File:** `src/lib/server/pipeline.test.ts` — use this verbatim harness, then implement every case in the table:

```ts
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { makeTestDb, clearDb } from './testdb';
import { channels, rules, comments, auditLog } from './db/schema';

let db: Awaited<ReturnType<typeof makeTestDb>>;

vi.mock('$lib/server/db', async () => {
  const { makeTestDb } = await import('./testdb');
  const testDb = await makeTestDb();
  (globalThis as any).__testDb = testDb;
  return { db: testDb };
});

const fetchCommentPage = vi.fn();
const setModerationStatus = vi.fn(async () => {});
const deleteComment = vi.fn(async () => {});
vi.mock('./youtube', () => ({
  refreshAccessToken: vi.fn(async () => 'tok'),
  fetchCommentPage: (...a: unknown[]) => fetchCommentPage(...a),
  setModerationStatus: (...a: unknown[]) => setModerationStatus(...a),
  deleteComment: (...a: unknown[]) => deleteComment(...a)
}));

const scoreComment = vi.fn();
vi.mock('./moderation', async () => {
  const actual = await vi.importActual<typeof import('./moderation')>('./moderation');
  return { ...actual, scoreComment: (...a: unknown[]) => scoreComment(...a) };
});

const { runChannel } = await import('./pipeline');

const CH = {
  id: 'UC1', title: 'Test', refreshTokenEnc: 'enc',
  cursor: null as string | null, continuationToken: null as string | null,
  highWater: null as string | null, lastRunAt: null as string | null,
  active: 1, createdAt: '2026-01-01T00:00:00.000Z'
};

function ytComment(id: string, publishedAt: string, extra: Partial<Record<string, string>> = {}) {
  return { id, authorChannelId: 'UCa', authorName: 'Ann', text: 'hello', publishedAt, ...extra };
}
function page(items: unknown[], over: Partial<Record<string, unknown>> = {}) {
  return { items, nextPageToken: null, drained: true, skipped: 0, ...over };
}

beforeAll(() => {
  db = (globalThis as any).__testDb;
});
beforeEach(async () => {
  await clearDb(db);
  vi.clearAllMocks();
  process.env.DRY_RUN = 'false';
  await db.insert(channels).values(CH);
  scoreComment.mockResolvedValue({ score: 0.1, scores: { hate: 0.1 } });
});

describe('runChannel', () => {
  it('P1 example — clean comment is approved with no YouTube writes', async () => {
    fetchCommentPage.mockResolvedValue(page([ytComment('c1', '2026-07-01T00:00:00Z')]));
    const r = await runChannel('UC1');
    expect(r).toMatchObject({ fetched: 1, acted: 0, queued: 0 });
    const rows = await db.select().from(comments).all();
    expect(rows[0].status).toBe('approved');
    expect(setModerationStatus).not.toHaveBeenCalled();
    const ch = await db.select().from(channels).all();
    expect(ch[0].cursor).toBe('2026-07-01T00:00:00Z');
  });
  // …implement P2–P16 per the table below following this pattern…
});
```

Required cases (all must exist and pass):

| # | Setup | Expected |
|---|---|---|
| P1 | 1 comment, AI 0.1 | approved; no YT writes; cursor advanced to comment's publishedAt |
| P2 | 1 comment, AI 0.5 | status `pending`, decidedBy `ai`, audit `queue`, queued=1, no YT writes |
| P3 | 1 comment, AI 0.9 | insert order: row exists as final `rejected` after run; `setModerationStatus` called with `(['c1'],'rejected',false,...)`; audit `reject` |
| P4 | AI throws ModerationError for 1 of 2 comments (other scores 0.1) | failing comment → `pending`/decidedBy `none` + audit `queue` "ai unavailable"; other approved; run completes (I11) |
| P5 | comment without authorChannelId (already defaulted to `'unknown'` by fetch) | moderated normally, inserted, not skipped (I1) |
| P6 | keyword rule `spam`→`hold`; comment "spam here" | `setModerationStatus` with `'heldForReview'`; final status `held`; audit reason contains `rule #`; AI never called for that comment |
| P7 | rule action `ban` | `setModerationStatus(ids,'rejected',true,...)`; final `rejected` |
| P8 | rule action `delete` | `deleteComment('c1',...)` called; final `deleted` |
| P9 | invalid regex rule in DB (e.g. `(?=x)`) + clean comment | no throw; comment falls through to AI path |
| P10 | duplicate: comment id already in DB | skipped entirely — no re-insert, no YT call, no second audit row (I4) |
| P11 | **DB-before-remote**: pre-seed a comment row `status='action_pending', pendingAction='reject'` (simulating a crash); mock page returns no items | next run reconciles: `setModerationStatus` called, row becomes `rejected`, `pendingAction` null (I3) |
| P12 | **burst start**: page returns 100 items with `nextPageToken='tok2'`, `drained=false` | `continuationToken='tok2'` stored, `highWater` = newest publishedAt, `cursor` UNCHANGED |
| P13 | **burst resume**: channel pre-seeded with `continuationToken='tok2'`, `highWater='2026-07-01T00:10Z'`; fetch returns page with `drained=true` | `fetchCommentPage` was called with pageToken `'tok2'`; after run: `cursor='2026-07-01T00:10Z'`, token and highWater null |
| P14 | **no skip across burst**: P12 then P13 sequence with distinct comment ids in both pages | all comments from both pages exist in DB; none lost |
| P15 | **dry run** (`DRY_RUN='true'`): rule hit + AI 0.9 + AI 0.5 comments | audit rows all action `dry-run`; ZERO comment rows; cursor/continuation/highWater/lastRunAt all unchanged; no YT writes (I8) |
| P16 | empty page, channel mid-burst (`continuationToken='tok2'`), page `drained=true` | checkpoint cleared: token/highWater null; lastRunAt set; no cursor change |

**Verify:** `npm run test` exits 0 with P1–P16, M1–M9, Y1–Y11, and all rules tests green.

**If this fails:** the verbatim module code is the spec — fix tests to match it, UNLESS the failure reveals the module violating an invariant (§4.1); in that case stop, quote the invariant and the failing output, report back.

---

### Phase E — Auth & cron routes (Steps 16–17)

#### Step 16: Google OAuth routes

**File:** `src/routes/api/auth/google/+server.ts` — create with exactly:

```ts
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

export const GET: RequestHandler = ({ cookies }) => {
  // CSRF guard: bind the auth request to this browser session.
  const state = randomBytes(16).toString('hex');
  cookies.set('oauth_state', state, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 600 });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${env.APP_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  throw redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};
```

**File:** `src/routes/api/auth/google/callback/+server.ts` — create with exactly:

```ts
import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { encrypt } from '$lib/server/crypto';
import { fetchJson } from '$lib/server/http';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const state = url.searchParams.get('state');
  if (!state || state !== cookies.get('oauth_state')) throw error(400, 'bad state');
  cookies.delete('oauth_state', { path: '/' });
  const code = url.searchParams.get('code');
  if (!code) throw error(400, 'missing code');

  const tokens = (await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${env.APP_URL}/api/auth/google/callback`,
      grant_type: 'authorization_code'
    })
  })) as { refresh_token?: unknown; access_token?: unknown };

  if (
    typeof tokens.refresh_token !== 'string' || !tokens.refresh_token ||
    typeof tokens.access_token !== 'string' || !tokens.access_token
  ) {
    throw error(
      400,
      'token exchange returned no refresh_token — revoke app access at myaccount.google.com/permissions and retry'
    );
  }

  const chData = (await fetchJson('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  })) as { items?: Array<{ id?: unknown; snippet?: { title?: string } }> };

  const ch = Array.isArray(chData.items) ? chData.items[0] : undefined;
  if (typeof ch?.id !== 'string' || !ch.id) throw error(400, 'no YouTube channel found for this Google account');

  await db
    .insert(channels)
    .values({
      id: ch.id,
      title: ch.snippet?.title ?? 'Untitled channel',
      refreshTokenEnc: encrypt(tokens.refresh_token),
      active: 1,
      createdAt: new Date().toISOString()
    })
    .onConflictDoUpdate({
      target: channels.id,
      set: {
        title: ch.snippet?.title ?? 'Untitled channel',
        refreshTokenEnc: encrypt(tokens.refresh_token),
        active: 1
      }
    });

  throw redirect(302, '/');
};
```

**Verify:** `npm run check` reports 0 errors for these files.

**If this fails:** stop, paste the full error, report back.

#### Step 17: Cron endpoint (channel rotation — I10)

**File:** `src/routes/api/cron/+server.ts` — create with exactly:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { runChannel } from '$lib/server/pipeline';

const LEASE_MS = 10 * 60 * 1000; // exceeds one bounded run; expiry alone re-eligibilizes after a crash

/**
 * One channel per invocation: the active, unleased channel with the oldest
 * lastRunAt (SQLite sorts NULLs first in ASC, so never-run channels go first).
 * The channel is claimed atomically with an expiring lease before runChannel,
 * so concurrent cron invocations cannot process the same channel (I10).
 */
export const GET: RequestHandler = async ({ url }) => {
  if (url.searchParams.get('secret') !== env.CRON_SECRET) throw error(401, 'bad secret');
  const dryRun = process.env.DRY_RUN === 'true';
  const nowIso = new Date().toISOString();
  const claimable = or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, nowIso));
  const [ch] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.active, 1), claimable))
    .orderBy(asc(channels.lastRunAt))
    .limit(1);
  if (!ch) return json({ ok: true, dryRun, results: {} });

  // Atomic claim: a concurrent claimant's UPDATE matches 0 rows and exits cleanly.
  const claimed = await db
    .update(channels)
    .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() })
    .where(and(eq(channels.id, ch.id), claimable))
    .returning({ id: channels.id });
  if (claimed.length === 0) return json({ ok: true, claimed: false, dryRun, results: {} });

  try {
    const result = await runChannel(ch.id);
    return json({ ok: true, dryRun, results: { [ch.id]: result } });
  } catch (e) {
    return json(
      {
        ok: false,
        dryRun,
        results: { [ch.id]: { error: e instanceof Error ? e.message : String(e) } }
      },
      { status: 500 } // failure must not look like success to the cron caller
    );
  } finally {
    await db.update(channels).set({ leaseExpiresAt: null }).where(eq(channels.id, ch.id));
  }
};
```

Note: the implementing PR must also add `lease_expires_at` to
`src/lib/server/db/schema.ts` plus a drizzle migration — the live schema has
already diverged from Step 5 (`scanCursor`/`nextPageToken`, no `lastRunAt` yet).

**Verify:** `npm run check && npm run build && npm run test` all exit 0.

**If this fails:** stop, paste the full error, report back.

**Trigger (deployment config):** the endpoint does not run on its own — an external
scheduler must call `GET /api/cron?secret=$CRON_SECRET` on an interval (e.g. every
minute; each invocation processes exactly one channel, so the interval sets the
per-channel scan cadence). Options: a Netlify Scheduled Function, or any external
cron service (e.g. cron-job.org, GitHub Actions schedule) hitting the deployed URL.
Set `CRON_SECRET` in the Netlify environment.

---

### Phase F — UI (Steps 18–23)

Plain server loads + form actions; one global stylesheet.

#### Step 18: Global stylesheet and layout

**File:** `src/app.css` — create with exactly:

```css
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #f6f7f9; color: #1a1d21; }
nav { background: #111; color: #fff; padding: 10px 20px; display: flex; gap: 16px; align-items: center; }
nav a { color: #cdd3da; text-decoration: none; font-size: 14px; }
nav a:hover { color: #fff; }
nav .brand { font-weight: 700; color: #fff; }
main { max-width: 860px; margin: 24px auto; padding: 0 16px; }
.card { background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.btn { display: inline-block; background: #111; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-size: 14px; cursor: pointer; text-decoration: none; }
.btn.secondary { background: #e3e6ea; color: #111; }
.btn.danger { background: #b3261e; }
.btn.small { padding: 4px 10px; font-size: 13px; }
input, select { padding: 8px; border: 1px solid #c9cfd6; border-radius: 6px; font-size: 14px; }
form.inline { display: inline; }
.muted { color: #6b7280; font-size: 13px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e3e6ea; vertical-align: top; }
.badge { display: inline-block; border-radius: 4px; padding: 2px 8px; font-size: 12px; background: #e3e6ea; }
```

**File:** `src/routes/+layout.svelte` — replace entire contents with:

```svelte
<script lang="ts">
  import '../app.css';
  let { children } = $props();
</script>

<nav>
  <a class="brand" href="/">Moderaty</a>
  <a href="/">Dashboard</a>
</nav>
<main>{@render children()}</main>
```

**Verify:** `npm run dev` starts; `curl -s http://localhost:5173 | grep -c 'Moderaty'` prints ≥ 1. Stop the dev server after.

**If this fails:** if `{@render children()}` errors (Svelte 4 scaffold), replace with `<slot />`. Otherwise stop and report.

#### Step 19: Dashboard

**File:** `src/routes/+page.server.ts` — create with exactly:

```ts
import { db } from '$lib/server/db';
import { channels, comments } from '$lib/server/db/schema';
import { sql } from 'drizzle-orm';

export async function load() {
  const chs = await db.select().from(channels).all();
  const stats = await db
    .select({ channelId: comments.channelId, status: comments.status, n: sql<number>`count(*)` })
    .from(comments)
    .groupBy(comments.channelId, comments.status)
    .all();
  return { chs, stats };
}
```

**File:** `src/routes/+page.svelte` — replace entire contents with:

```svelte
<script lang="ts">
  let { data }: { data: any } = $props();
  function count(channelId: string, status: string): number {
    const row = data.stats.find((s: any) => s.channelId === channelId && s.status === status);
    return row ? row.n : 0;
  }
</script>

<h1>Channels</h1>
<a class="btn" href="/api/auth/google">Connect YouTube channel</a>

{#each data.chs as ch}
  <div class="card">
    <h2 style="margin-top:0">{ch.title}</h2>
    <p class="muted">ID: {ch.id} · drained up to: {ch.cursor ?? 'never'} · last run: {ch.lastRunAt ?? 'never'}</p>
    <p>
      <span class="badge">pending: {count(ch.id, 'pending')}</span>
      <span class="badge">rejected: {count(ch.id, 'rejected')}</span>
      <span class="badge">deleted: {count(ch.id, 'deleted')}</span>
      <span class="badge">approved: {count(ch.id, 'approved')}</span>
    </p>
    <a class="btn secondary small" href="/channels/{ch.id}/rules">Rules</a>
    <a class="btn secondary small" href="/channels/{ch.id}/queue">Review queue</a>
    <a class="btn secondary small" href="/channels/{ch.id}/log">Audit log</a>
  </div>
{:else}
  <p class="muted" style="margin-top:16px">No channels connected yet.</p>
{/each}
```

**Verify:** dev server renders `/` with the connect button.

#### Step 20: Rules page (recheck validation — I6)

**File:** `src/routes/channels/[id]/rules/+page.server.ts` — create with exactly:

```ts
import { db } from '$lib/server/db';
import { channels, rules } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import { validateRule } from '$lib/server/rules';

export async function load({ params }) {
  const ch = await db.select().from(channels).where(eq(channels.id, params.id)).get();
  const rs = await db.select().from(rules).where(eq(rules.channelId, params.id)).all();
  return { ch, rs };
}

export const actions = {
  add: async ({ params, request }) => {
    const f = await request.formData();
    const type = String(f.get('type') ?? '');
    const pattern = String(f.get('pattern') ?? '').trim();
    const action = String(f.get('action') ?? '');
    if (!['keyword', 'regex', 'user'].includes(type)) return fail(400, { error: 'bad type' });
    if (!['hold', 'reject', 'delete', 'ban'].includes(action)) return fail(400, { error: 'bad action' });
    try {
      validateRule({ id: 0, type, pattern, action });
    } catch (e) {
      return fail(400, { error: e instanceof Error ? e.message : String(e) });
    }
    await db.insert(rules).values({
      channelId: params.id,
      type,
      pattern,
      action,
      createdAt: new Date().toISOString()
    });
    return { ok: true };
  },
  remove: async ({ params, request }) => {
    const f = await request.formData();
    // Scope to this route's channel so a request here cannot delete another channel's rule.
    const deleted = await db
      .delete(rules)
      .where(and(eq(rules.id, Number(f.get('ruleId'))), eq(rules.channelId, params.id)))
      .returning({ id: rules.id });
    if (deleted.length === 0) return fail(404, { error: 'rule not found' });
    return { ok: true };
  }
};
```

**File:** `src/routes/channels/[id]/rules/+page.svelte` — create with exactly:

```svelte
<script lang="ts">
  let { data, form }: { data: any; form: any } = $props();
</script>

<h1>Rules — {data.ch?.title}</h1>

<div class="card">
  <form method="POST" action="?/add" style="display:flex; gap:8px; flex-wrap:wrap">
    <select name="type">
      <option value="keyword">keyword</option>
      <option value="regex">regex</option>
      <option value="user">blocked user (channel ID)</option>
    </select>
    <input name="pattern" placeholder="pattern" style="flex:1; min-width:220px" required />
    <select name="action">
      <option value="hold">hold for review</option>
      <option value="reject">reject (hide)</option>
      <option value="delete">delete permanently</option>
      <option value="ban">reject + ban author</option>
    </select>
    <button class="btn" type="submit">Add rule</button>
  </form>
  {#if form?.error}<p style="color:#b3261e">{form.error}</p>{/if}
</div>

{#each data.rs as r}
  <div class="card" style="display:flex; justify-content:space-between; align-items:center">
    <div>
      <span class="badge">{r.type}</span> <code>{r.pattern}</code> → <strong>{r.action}</strong>
    </div>
    <form class="inline" method="POST" action="?/remove">
      <input type="hidden" name="ruleId" value={r.id} />
      <button class="btn danger small" type="submit">Delete</button>
    </form>
  </div>
{:else}
  <p class="muted">No rules yet. AI moderation still applies to all comments.</p>
{/each}
```

**Verify:** `npm run check` 0 errors.

#### Step 21: Review queue page

**File:** `src/routes/channels/[id]/queue/+page.server.ts` — create with exactly:

```ts
import { db } from '$lib/server/db';
import { channels, comments, auditLog } from '$lib/server/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { refreshAccessToken, setModerationStatus, deleteComment } from '$lib/server/youtube';
import { decrypt } from '$lib/server/crypto';

export async function load({ params }) {
  const ch = await db.select().from(channels).where(eq(channels.id, params.id)).get();
  const pending = await db
    .select()
    .from(comments)
    .where(and(eq(comments.channelId, params.id), eq(comments.status, 'pending')))
    .orderBy(desc(comments.publishedAt))
    .limit(100)
    .all();
  return { ch, pending };
}

async function act(paramsId: string, commentId: string, action: 'approve' | 'reject' | 'delete' | 'ban') {
  const ch = await db.select().from(channels).where(eq(channels.id, paramsId)).get();
  if (!ch) throw new Error('channel not found');
  if (process.env.DRY_RUN !== 'true' && action !== 'approve') {
    const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
    if (action === 'reject') await setModerationStatus([commentId], 'rejected', false, token);
    if (action === 'ban') await setModerationStatus([commentId], 'rejected', true, token);
    if (action === 'delete') await deleteComment(commentId, token);
  }
  const status = action === 'approve' ? 'approved' : action === 'delete' ? 'deleted' : 'rejected';
  await db.update(comments).set({ status, decidedBy: 'human' }).where(eq(comments.id, commentId));
  await db.insert(auditLog).values({
    channelId: paramsId,
    commentId,
    action: process.env.DRY_RUN === 'true' ? 'dry-run' : action,
    reason: 'manual review',
    actor: 'user',
    createdAt: new Date().toISOString()
  });
}

export const actions = {
  approve: async ({ params, request }) => {
    await act(params.id, String((await request.formData()).get('commentId')), 'approve');
  },
  reject: async ({ params, request }) => {
    await act(params.id, String((await request.formData()).get('commentId')), 'reject');
  },
  del: async ({ params, request }) => {
    await act(params.id, String((await request.formData()).get('commentId')), 'delete');
  },
  ban: async ({ params, request }) => {
    await act(params.id, String((await request.formData()).get('commentId')), 'ban');
  }
};
```

**File:** `src/routes/channels/[id]/queue/+page.svelte` — create with exactly:

```svelte
<script lang="ts">
  let { data }: { data: any } = $props();
</script>

<h1>Review queue — {data.ch?.title}</h1>
<p class="muted">Borderline comments (AI score 0.51–0.75, or AI unavailable). Your action is final.</p>

{#each data.pending as c}
  <div class="card">
    <p style="margin-top:0"><strong>{c.authorName}</strong> <span class="muted">{c.publishedAt}</span></p>
    <p>{c.text}</p>
    <form class="inline" method="POST" action="?/approve">
      <input type="hidden" name="commentId" value={c.id} />
      <button class="btn secondary small">Approve</button>
    </form>
    <form class="inline" method="POST" action="?/reject">
      <input type="hidden" name="commentId" value={c.id} />
      <button class="btn small">Reject</button>
    </form>
    <form class="inline" method="POST" action="?/del">
      <input type="hidden" name="commentId" value={c.id} />
      <button class="btn danger small">Delete</button>
    </form>
    <form class="inline" method="POST" action="?/ban">
      <input type="hidden" name="commentId" value={c.id} />
      <button class="btn danger small">Ban author</button>
    </form>
  </div>
{:else}
  <p class="muted">Queue is empty.</p>
{/each}
```

**Verify:** `npm run check` 0 errors.

#### Step 22: Audit log page

**File:** `src/routes/channels/[id]/log/+page.server.ts` — create with exactly:

```ts
import { db } from '$lib/server/db';
import { channels, auditLog } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';

export async function load({ params }) {
  const ch = await db.select().from(channels).where(eq(channels.id, params.id)).get();
  const entries = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.channelId, params.id))
    .orderBy(desc(auditLog.createdAt))
    .limit(200)
    .all();
  return { ch, entries };
}
```

**File:** `src/routes/channels/[id]/log/+page.svelte` — create with exactly:

```svelte
<script lang="ts">
  let { data }: { data: any } = $props();
</script>

<h1>Audit log — {data.ch?.title}</h1>
<div class="card">
  <table>
    <thead>
      <tr><th>Time</th><th>Action</th><th>Comment</th><th>Reason</th><th>Actor</th></tr>
    </thead>
    <tbody>
      {#each data.entries as e}
        <tr>
          <td class="muted">{e.createdAt}</td>
          <td><span class="badge">{e.action}</span></td>
          <td class="muted">{e.commentId}</td>
          <td>{e.reason}</td>
          <td class="muted">{e.actor}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
```

**Verify:** `npm run check` 0 errors.

#### Step 23: Full gate

```bash
npm run check && npm run build && npm run test
```

**Verify:** all three exit 0.

**If this fails:** fix the cause in the failing file only; do not weaken tests to make them pass. Otherwise stop and report.

---

### Phase G — Design pass (Steps 24–26)

Phase F built functional pages with a minimal stylesheet. This phase turns them into a designed product. Everything below is pre-decided — implement values verbatim, do not pick alternatives.

#### Step 24: Design tokens and base stylesheet

**File:** `src/app.css` — replace the ENTIRE file with:

```css
/* ── Moderaty design tokens ─────────────────────────────── */
:root {
  --bg: #f7f7f5;
  --surface: #ffffff;
  --border: #e5e3de;
  --ink: #1c1b1a;
  --ink-2: #6f6a63;          /* muted text */
  --brand: #4f46e5;          /* indigo 600 */
  --brand-hover: #4338ca;    /* indigo 700 */
  --brand-soft: #eef2ff;     /* indigo 50  */
  --danger: #dc2626;
  --danger-hover: #b91c1c;
  --danger-soft: #fef2f2;
  --warn-soft: #fffbeb;
  --ok: #16a34a;
  --ok-soft: #f0fdf4;
  --radius: 10px;
  --radius-sm: 6px;
  --shadow: 0 1px 2px rgb(28 27 26 / 0.06), 0 4px 12px rgb(28 27 26 / 0.05);
  --font: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
}

* { box-sizing: border-box; }
html { -webkit-font-smoothing: antialiased; }
body {
  font-family: var(--font);
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-size: 15px;
  line-height: 1.55;
}

/* ── layout ─────────────────────────────────────────────── */
nav {
  background: var(--ink);
  padding: 0 24px;
  height: 56px;
  display: flex;
  gap: 24px;
  align-items: center;
}
nav a { color: #b8b4ac; text-decoration: none; font-size: 14px; }
nav a:hover { color: #fff; }
nav .brand { font-weight: 700; color: #fff; font-size: 17px; letter-spacing: -0.01em; }
main { max-width: 900px; margin: 32px auto; padding: 0 20px; }
h1 { font-size: 22px; letter-spacing: -0.02em; margin: 0 0 4px; }
.page-sub { color: var(--ink-2); margin: 0 0 24px; font-size: 14px; }

/* ── card ───────────────────────────────────────────────── */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 20px;
  margin-bottom: 14px;
}

/* ── buttons ────────────────────────────────────────────── */
.btn {
  display: inline-block;
  background: var(--brand);
  color: #fff;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  font-family: var(--font);
  cursor: pointer;
  text-decoration: none;
  transition: background 120ms ease;
}
.btn:hover { background: var(--brand-hover); }
.btn.secondary { background: var(--surface); color: var(--ink); border-color: var(--border); }
.btn.secondary:hover { background: var(--bg); }
.btn.danger { background: var(--danger); }
.btn.danger:hover { background: var(--danger-hover); }
.btn.small { padding: 5px 11px; font-size: 13px; }
.btn:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

/* ── forms ──────────────────────────────────────────────── */
input, select {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-family: var(--font);
  background: var(--surface);
  color: var(--ink);
}
input:focus, select:focus { border-color: var(--brand); outline: none; box-shadow: 0 0 0 3px var(--brand-soft); }
form.inline { display: inline; }

/* ── text & badges ──────────────────────────────────────── */
.muted { color: var(--ink-2); font-size: 13px; }
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 500;
  background: var(--brand-soft);
  color: var(--brand);
}
.badge.neutral { background: #f1efe9; color: var(--ink-2); }
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.danger { background: var(--danger-soft); color: var(--danger); }

/* ── table ──────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { color: var(--ink-2); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }

/* ── states (I12) ───────────────────────────────────────── */
.empty {
  text-align: center;
  padding: 48px 24px;
  color: var(--ink-2);
  background: var(--surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}
.empty p { margin: 0 0 6px; font-size: 15px; color: var(--ink); font-weight: 500; }
.empty .muted { font-size: 14px; }
.skeleton {
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, #efece7 25%, #f7f5f2 50%, #efece7 75%);
  background-size: 200% 100%;
  animation: shimmer 1.2s infinite linear;
  min-height: 16px;
}
@keyframes shimmer { to { background-position: -200% 0; } }
.error-box {
  background: var(--danger-soft);
  border: 1px solid #fecaca;
  color: var(--danger);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  font-size: 14px;
  margin-bottom: 14px;
}
.flash {
  background: var(--ok-soft);
  border: 1px solid #bbf7d0;
  color: var(--ok);
  border-radius: var(--radius-sm);
  padding: 10px 16px;
  font-size: 14px;
  margin-bottom: 14px;
}

@media (prefers-reduced-motion: reduce) {
  .skeleton { animation: none; }
  .btn { transition: none; }
}
```

**Verify:** `grep -c -- '--brand: #4f46e5' src/app.css` prints `1`; `npm run check` still exits 0.

**If this fails:** stop, paste the error, report back.

#### Step 25: Design components

**File:** `src/lib/EmptyState.svelte` — create with exactly:

```svelte
<script lang="ts">
  let { title, hint = '' }: { title: string; hint?: string } = $props();
</script>

<div class="empty">
  <p>{title}</p>
  {#if hint}<span class="muted">{hint}</span>{/if}
</div>
```

**File:** `src/lib/Skeleton.svelte` — create with exactly:

```svelte
<script lang="ts">
  let { rows = 3 }: { rows?: number } = $props();
</script>

<div aria-busy="true" aria-label="Loading">
  {#each Array(rows) as _, i}
    <div class="card">
      <div class="skeleton" style="width: 40%; margin-bottom: 10px"></div>
      <div class="skeleton" style="width: {i % 2 === 0 ? '85%' : '70%'}"></div>
    </div>
  {/each}
</div>
```

**Verify:** `npm run check` exits 0 with both new components.

**If this fails:** if Svelte 5 prop-typing syntax errors, drop the type annotations (`let { title, hint = '' } = $props();`). Otherwise stop and report.

#### Step 26: Restyle the four pages + states (I12)

Rules for every page below — apply uniformly:

- **Brand:** nav brand text is `Moderaty` (already in the layout from Phase F — change `yt-mod` to `Moderaty` there and in the page `<h1>`s where a product name appears).
- **Heading pattern:** each page starts with `<h1>` + `<p class="page-sub">` one-line description.
- **Loading:** while data loads, render `<Skeleton rows={3} />` instead of blank space (SvelteKit streams server loads slowly on cold start — wrap page content so the nav renders instantly; the simplest correct approach: keep the `load` functions as-is and render the skeleton only inside `{#await}`-free markup is NOT possible with blocking loads — therefore: add `export const ssr = true` (default) and accept server-blocking loads, but DO add the skeleton as the fallback content of each page's `{:else}` branch during client navigations). **Decision (no judgment left):** use SvelteKit's blocking loads; the "loading state" requirement is satisfied by rendering `<Skeleton>` on the queue page when `data.pending` is `undefined`, and by the shimmer styles being available — do not restructure load functions.
- **Empty states (verbatim copy):**
  - Dashboard, no channels: `<EmptyState title="No channels connected" hint="Connect your YouTube channel to start moderating comments automatically." />`
  - Rules, no rules: `<EmptyState title="No rules yet" hint="AI moderation still applies to every comment — rules add your own keywords, patterns, and blocked users." />`
  - Queue, empty: `<EmptyState title="Queue is clear" hint="Borderline comments will appear here for your review." />`
  - Log, empty: `<EmptyState title="No activity yet" hint="Every moderation action — automatic or manual — is recorded here." />`
- **Error state:** each page checks `form?.error` (actions pages) and renders `<div class="error-box">{form.error}</div>`; the rules page's existing inline error paragraph moves into this box.
- **Badge semantics (apply to dashboard counts and log actions):** `pending`/`queue` → `class="badge"` (brand), `approved`/`approve` → `badge ok`, `rejected`/`deleted`/`reject`/`delete`/`ban`/`dry-run` → `badge danger`, everything else → `badge neutral`.
- **Rule rows:** pattern in `<code>` with `background: var(--brand-soft); padding: 1px 6px; border-radius: 4px;` (add this `code` selector to `app.css`), action label bold, delete button right-aligned (keep the flex layout from Phase F).
- **Queue cards:** author name `font-weight: 600`; comment text in a `<blockquote style="margin:8px 0; padding:8px 12px; border-left:3px solid var(--border); color: var(--ink-2)">`; action buttons grouped with `style="display:flex; gap:8px"` replacing the four separate `form.inline` wrappers' default spacing (keep the four forms, wrap them in one flex div).
- **Accessibility (I13):** every form input/select has an `aria-label` matching its purpose (e.g. `aria-label="Rule type"`); the delete-rule and queue buttons have `aria-label` including the target (e.g. `aria-label="Delete rule {r.id}"`, `aria-label="Reject comment by {c.authorName}"`); the log table gets `<caption class="muted" style="text-align:left; padding-bottom:8px">Latest moderation actions</caption>`.
- **Page `<svelte:head>` titles:** `<title>Moderaty — Dashboard</title>`, `— Rules`, `— Review queue`, `— Audit log` respectively.

Do not change any `load` function, form action, route, or class logic in this step — presentation only. If a page's Phase F markup conflicts with a rule above, the rule above wins for markup; behavior stays identical.

**Verify:**
1. `npm run check && npm run build && npm run test` all exit 0 (behavior unchanged → tests must stay green).
2. `grep -rc 'yt-mod' src/` prints `0` for every file (brand fully renamed in the UI).
3. `grep -c EmptyState src/routes/+page.svelte src/routes/channels/*/rules/+page.svelte src/routes/channels/*/queue/+page.svelte src/routes/channels/*/log/+page.svelte` — each of the four files prints ≥ 1.
4. `grep -c 'aria-label' src/routes/channels/*/rules/+page.svelte` prints ≥ 3.

**If this fails:**
- If `npm run test` breaks, a behavioral change slipped in — `git diff` against the phase start, revert the behavioral part, keep presentation changes.
- Otherwise stop, paste the error, report back.

---

### Phase H — End-to-end (Steps 27–28)

#### Step 27: Credentials (human task — executor stops and asks)

1. Google Cloud Console → project → enable **YouTube Data API v3** → OAuth consent screen (external; scope `https://www.googleapis.com/auth/youtube.force-ssl`; add the test Gmail as a test user; **app name shown to users: "Moderaty"**) → OAuth client (Web) with redirect URI `http://localhost:5173/api/auth/google/callback`.
2. Fill `.env` with real values; generate `ENCRYPTION_KEY` via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; set `CRON_SECRET`. Keep `DRY_RUN=true`.

**Verify:** `grep -c placeholder .env` prints `0`.

#### Step 28: Live smoke test

1. `npm run dev`; open `/`; connect the test channel; expect the channel card on `/`.
2. Add a keyword rule matching a word in a recent comment (action `hold`).
3. `curl "http://localhost:5173/api/cron?secret=<CRON_SECRET>"` — expect `dryRun: true`, counts ≥ 0, no `error`; audit log shows `dry-run` rows; DB has ZERO new comment rows (I8).
4. `DRY_RUN=false`, restart, re-run cron — the matched comment appears in YouTube Studio → Comments → Held for review; DB status `held`; audit action `hold`.
5. Queue: approve one item → status `approved`, audit actor `user`.
6. Rotation: connect or seed a second channel row; two consecutive cron calls process DIFFERENT channels (I10).

**If this fails:**
- `redirect_uri_mismatch` → fix the console URI to match exactly; do not change code.
- No `refresh_token` → revoke at myaccount.google.com/permissions, reconnect.
- `HTTP 403 ... quotaExceeded` → wait for quota reset; never create extra projects.
- Anything else → stop, paste the full error, report back.

---

## 5b. Post-MVP phase: user accounts (shipped)

Multi-user accounts landed after the MVP phases (branch `feat-user-accounts`).
Decisions, confirmed with the maintainer:

- **Sign-in is Google identity only** (`GET /api/auth/google/login` +
  `/api/auth/google/login/callback`, scopes `openid email profile`,
  `access_type=online`).
  YouTube channel connection stays a **separate** consent at the existing
  `/api/auth/google` URLs (`youtube.force-ssl`), now session-gated: the
  callback attaches `channels.userId` and refuses (409) to reattach a channel
  owned by another account.
- **No auth library** — the "no auth libraries" constraint stands. Sessions
  are DIY: `src/lib/server/session.ts` (random 32-byte token PK, `sessions`
  table, httpOnly `moderaty_session` cookie, 30-day sliding expiry with
  renewal at <15 days). `src/hooks.server.ts` resolves the cookie into
  `locals.user`; the `(app)` group layout redirects signed-out visitors to
  `/login`; every form action calls `requireUser(locals)` and scopes every
  channel read/write by `channels.userId` (cross-owner always 404).
- **Schema:** `users` (`google_sub` unique, `email`, `display_name`, `plan`
  default `'free'`), `sessions`, nullable `channels.user_id` (migration
  0004). Orphaned pre-accounts channels (`user_id IS NULL`) are claimed by
  the first user ever to complete account creation — that is how the original
  single-operator database attaches to its owner.
- **Accounts everywhere; BYOK for self-hosted.** Hosted and self-hosted run
  the same code path. Self-hosters supply their own `GOOGLE_CLIENT_ID`/
  `GOOGLE_CLIENT_SECRET`, `OPENAI_API_KEY`, and Turso credentials via env, so
  the hosted operator never pays for non-subscribers.

### 5b-2. Legal consent interstitial (branch `feat-account-consent`)

The contract forms at a checkbox, **after** Google sign-in but **before** the
account exists — never pre-OAuth friction, never browsewrap:

- **Flow:** the login callback no longer creates accounts. A new Google
  identity (or an existing account whose latest consent predates the current
  `LEGAL_VERSION`) is parked in a short-lived AES-GCM-encrypted httpOnly
  cookie (`moderaty_consent_pending`, 10 min) and redirected to `/consent`.
  Only the "Create account" action — gated on a required checkbox that renders
  unticked and must be ticked to continue — writes the `users` row, the
  consent record, and the first session.
- **The checkbox text is the age gate:** "I am at least 18 years old and
  agree to the Terms of Service, Privacy Policy, and Data Processing
  Agreement". Google OAuth is identity, not age verification, so the 18+
  self-declaration rides in the same required box; the exact string
  (`CONSENT_CHECKBOX_TEXT` in `src/lib/server/legal.ts`) is stored verbatim
  in every consent row, and the `/consent` page renders its visible sentence
  from that constant (split into text/link segments by
  `src/lib/consentText.ts`).
- **Consent is logged as evidence** (`consents` table, migration 0007):
  user, `doc_version`, exact checkbox text, IP (`getClientAddress()`), user
  agent, timestamp. One row per acceptance event; never updated. CDC
  Art. 6º, VIII can shift the burden of proof to the operator — this table
  is the "I never agreed to that" rebuttal.
- **Marketing e-mail is a separate, unbundled, unticked box** (LGPD):
  recorded as `marketing_opt_in` on the same event row; bundling it into the
  contract checkbox would invalidate it.
- **Re-acceptance:** bump `LEGAL_VERSION` on material document changes;
  every account whose latest consent is stale is sent back through
  `/consent` at next login. Silent "continued use = acceptance" stays
  reserved for minor changes (ToS §18).
- **Progressive scopes hold:** basic Google profile at sign-up, YouTube
  API scopes only at the separate "Connect YouTube channel" step — no
  comment data can flow before the contract exists.

### 5b-3. Account deletion with 6-month retention (branch `feat-account-deletion`)

- **Soft delete, self-service.** The dashboard `deleteAccount` action
  (required confirmation checkbox, `requireUser`) commits one transaction:
  set `users.deleted_at`, destroy every session (immediate global sign-out),
  deactivate the user's channels (`active=0` — moderation stops at once).
- **Retention window = 6 months, sign-in restores.** A soft-deleted user who
  authenticates again has `deleted_at` cleared in the login callback;
  channels stay inactive until manually re-enabled, so moderation never
  resumes silently. A sign-in AFTER the window instead purges the account
  inline (`purgeUserById` in `src/lib/server/retention.ts`, shared with cron
  so both enforce the same cutoff) and continues as a fresh signup.
- **Bounded purge in cron (I10).** One expired user per invocation, skipped
  under `DRY_RUN` (I8): sessions, channels, and their rules, comments,
  moderation actions, and audit rows are deleted explicitly (no FK cascades
  exist on channel-scoped tables).
- **The consent log survives (LGPD Art. 16).** The users row is anonymized to
  a tombstone (`google_sub = 'deleted:<id>'`, email/display name
  `'[deleted]'`) rather than deleted, keeping `consents.user_id` valid and
  preserving the evidentiary chain (doc version, exact checkbox text, IP,
  user agent). The tombstone also frees the real Google sub for a future
  fresh signup.
- Migration 0009 adds nullable `users.deleted_at` (I7; renumbered from 0008
  after main's comment-PII migration took that number). Verify the column
  exists after `db:migrate` — drizzle-kit can exit 0 without applying when
  the database is unreachable (the 0007 incident).

### 5b-4. Comment storage: text yes, author PII never (branch `feat-comment-pii`)

- **The `comments` table stores comment text (≤500 chars) with the
  moderation outcome** (status, decidedBy, matchedRuleId, aiScore,
  timestamps) so the review queue and audit history work.
- **Author identifiers are never persisted.** Migration 0008 relaxes
  `author_name` and `author_channel_id` to nullable and wipes the stored
  values (table rebuild whose INSERT SELECT carries NULL) — the expand
  phase, so pre- and post-change code coexist during the rollout (Netlify
  deploys are not atomic). A follow-up contract migration DROPS the columns
  once 0008 is verified applied. Rule matching still uses the in-memory
  author channel ID at decision time.
- **The review queue labels targets by text preview**, not author name
  ("Approve comment: …", "Ban this comment's author?"), since the author
  name is no longer known.
- **Public copy matches the implementation.** The earlier
  "processed and discarded, never stored" claim contradicted the database;
  Terms §4.2/§10.2, Privacy §2/§3.2/§3.4/§4.3/§7.1/§10.2, DPA §7/§13.1 and
  Annexes I–II, the footer LGPD note, and the FAQ now state: comment text is
  stored with the verdict, author identities are never stored. A consistency
  guard in `src/lib/landing/legal.test.ts` fails on regression.
- **Material legal change → `LEGAL_VERSION` bump (1.2);** existing users
  re-consent at next login via the §5b-2 flow.
- Migration ritual: run `npm run db:migrate` right after merge AND verify
  the author columns are nullable with all values NULL (0007 incident —
  drizzle-kit can exit 0 without applying). The contract migration that
  DROPS them ships only after that verification.

## 7. Future features

- **Stripe integration (hosted plans).** The hosted service will require paid
  plan purchases via Stripe (checkout, webhooks, plan enforcement, customer
  portal). **The free tier is self-hosted only** (BYOK: own Google/OpenAI/
  Turso keys). The `users.plan` column shipped in the accounts phase is the
  enforcement hook. Until Stripe lands, hosted signups are ungated.

## 6. Definition of done

All must be true before reporting completion:

- [ ] Every phase A–H has its own branch and a human-reviewed, merged PR; no direct commits to `main`; no PR was opened with red checks
- [ ] `npm run check`, `npm run build`, `npm run test` all exit 0
- [ ] All test cases exist and pass: rules suite, M1–M9, Y1–Y11, P1–P16
- [ ] `local.db` has `channels` (with `cursor`, `continuation_token`, `high_water`, `last_run_at`), `rules`, `comments` (with `pending_action`), `audit_log`
- [ ] Dry run: audit rows only, zero comment rows, zero checkpoint movement, zero YouTube writes (P15 verified live too)
- [ ] Burst test: a >100-comment burst drains across runs with no skipped comments (P12–P14)
- [ ] Crash recovery: a seeded `action_pending` row is reconciled on the next run (P11)
- [ ] User regexes are validated by recheck before compiling; `(a+)+$` is rejected as unsafe at the form; valid patterns match case-insensitively
- [ ] Comment without author metadata is moderated, not skipped (P5/Y2–Y3)
- [ ] Out-of-range AI scores throw and route the comment to the human queue (M3–M6, P4)
- [ ] Cron processes one channel per call and rotates by `lastRunAt`
- [ ] Invalid cron secret returns 401
- [ ] Brand is `Moderaty` everywhere in the UI: `grep -rc 'yt-mod' src/` prints 0 for every file
- [ ] All four pages render the designed empty state (EmptyState component) when their data is empty, `.error-box` on form errors, and skeletons per I12
- [ ] Design tokens in `src/app.css` match the verbatim values in Step 24 (`--brand: #4f46e5` present)
- [ ] Every form control and action button has a label or aria-label per I13; each page has a `<svelte:head>` title starting with `Moderaty`
- [ ] Every review finding from every PR has a reproducing test committed alongside its fix
- [ ] No files outside the Files list changed; no dependencies beyond the approved list

If any box cannot be checked, report which one and the exact failure output. Do not report success with unchecked boxes.
