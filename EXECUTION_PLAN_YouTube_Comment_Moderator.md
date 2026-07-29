<!--
Moderaty — YouTube Comment Auto-Moderation Tool
Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify it under
the GNU Affero General Public License, version 3 or later. It is provided
without warranty; see LICENSE. Commercial licensing:
contact@marketingprowess.simplelogin.com — see COMMERCIAL.md.
-->

# EXECUTION PLAN: YouTube Comment Auto-Moderator (MVP)

> Hand this entire document to the executor model. It has no other context.
> Everything it needs is written here. Follow the steps in order and improvise nothing.

---

## 0. Git & review workflow (mandatory)

This project is reviewed by a human via pull requests. The executor's branching rules:

- **Step 0 (before anything else):** initialize the repo and `main` branch: `git init -b main && git add -A && git commit -m "chore: initial scaffold"` (run after Step 1's scaffold; until then there is nothing to commit).
- **One branch per phase.** Phases are A through F (see section 5). Before starting a phase's first step, create its branch from an up-to-date `main`:
  - `phase-a-scaffold`, `phase-b-database`, `phase-c-server-libs`, `phase-d-auth-cron`, `phase-e-ui`, `phase-f-e2e`
- **Commit after every step** within the phase, with the message `step <N>: <step name>` (e.g. `step 6: create db client and drizzle config`).
- **When a phase's last step passes its Verify:** push the branch and open a PR to `main`:
  ```bash
  git push -u origin <branch>
  gh pr create --base main --title "Phase <X>: <name>" --body "Automated PR. Verify checklist in the plan's phase heading. Do not merge if any step's Verify failed."
  ```
  (If the `gh` CLI is not available, push the branch and print the compare URL `https://github.com/<owner>/<repo>/compare/main...<branch>` for the human instead.)
- **Then STOP.** Do not start the next phase until the human confirms the PR is merged. The executor resumes by running: `git checkout main && git pull` then creating the next phase branch.
- **Never** push to `main` directly, never merge your own PR, never use `--force`.
- **If the human requests changes on a PR:** apply them on the same phase branch as additional commits (`fix: phase <X> review — <what>`), push, and stop again for re-review.
- Steps 20–21 (credentials + live smoke test) require human action by design; the executor opens the Phase F PR after completing everything it can do autonomously (build + dry-run checks) and lists the remaining manual checks in the PR body.

---

## 1. Goal

By the end, there is a working SvelteKit web app called `Moderaty` that:

1. Lets a YouTube channel owner connect their channel via Google OAuth (scope `youtube.force-ssl`, offline access). The encrypted refresh token is stored in the database.
2. Stores per-channel moderation rules: keyword, regex, or blocked-user, each mapping to an action (`hold`, `reject`, `delete`, `ban`).
3. Exposes `POST /api/cron` authenticated with `Authorization: Bearer <CRON_SECRET>` which, for every active channel: fetches new comments since the last run (incremental, via a stored cursor), applies rules, then the OpenAI Moderation API, and enforces: high-confidence violations (score ≥ 0.85) are auto-rejected on YouTube, borderline (0.35 ≤ score < 0.85) go to a local review queue, clean (< 0.35) are marked approved. Rule hits execute their configured action immediately. Every action is written to an audit log.
4. Has four pages: a dashboard (`/`), a rules editor (`/channels/[id]/rules`), a review queue (`/channels/[id]/queue`) with one-click approve/reject/delete/ban, and an audit log (`/channels/[id]/log`).
5. Supports `DRY_RUN=true`, in which the pipeline classifies and logs but performs no write calls to YouTube.
6. Builds cleanly (`npm run build` exits 0) and runs with `npm run dev`.

## 2. Current state

Nothing exists. You are scaffolding a greenfield project into an empty directory. Environment: Node.js 24 and npm 11 (verify both before continuing). Framework: SvelteKit 2 + Svelte 5 + TypeScript. Database: SQLite via libSQL — local file `file:local.db` in development (Turso URL in production, same code). Package manager: npm. `npm run check` is the required verification baseline.

Key API facts you must rely on exactly as written (do not look up alternatives):

- YouTube Data API v3 base URL: `https://www.googleapis.com/youtube/v3`
  - List comments: `GET /commentThreads?part=snippet&allThreadsRelatedToChannelId={CHANNEL_ID}&order=time&maxResults=100&pageToken={TOKEN}&textFormat=plainText`
  - Moderate (batch, up to 50 IDs): `POST /comments/setModerationStatus?id={COMMA_SEPARATED_IDS}&moderationStatus={heldForReview|rejected}&banAuthor={true|false}`
  - Delete: `DELETE /comments?id={COMMENT_ID}`
  - Channel title lookup: `GET /channels?part=snippet&mine=true`
- OAuth: auth URL `https://accounts.google.com/o/oauth2/v2/auth`, token endpoint `https://oauth2.googleapis.com/token`. Required params for the auth URL: `client_id`, `redirect_uri`, `response_type=code`, `scope=https://www.googleapis.com/auth/youtube.force-ssl`, `access_type=offline`, `prompt=consent`.
- OpenAI Moderation: `POST https://api.openai.com/v1/moderations` with header `Authorization: Bearer $OPENAI_API_KEY`, JSON body `{ "model": "omni-moderation-latest", "input": "<text>" }`. Response: `results[0].category_scores` (object of category → 0..1 float).
- Toxicity categories to score: `harassment`, `harassment/threatening`, `hate`, `hate/threatening`, `violence`, `violence/graphic`. The comment's AI score = the maximum of these six. Spam is NOT handled by the AI layer; users catch spam with their own keyword/regex rules.

Thresholds (fixed, not configurable in MVP): AUTO_REJECT = 0.85, QUEUE = 0.35.

Polling: fetch pages of comment threads ordered by time (newest first); stop paging when a thread's `snippet.topLevelComment.snippet.publishedAt` is ≤ the channel's stored cursor, or after 3 pages. MVP moderates top-level comments only (not replies).

## 3. Files

**Read these files before starting:**
- After scaffolding: `svelte.config.js`, `package.json`, `src/app.d.ts` — to confirm names/versions before editing.

**Do not open or touch:**
- `node_modules/`, `.svelte-kit/`, any file not listed below.

**Files you will create or modify:**
- `svelte.config.js` — modify (switch adapter)
- `vite.config.ts` — modify (Vite-only configuration)
- `package.json` — modify (add `db:push` script)
- `.env.example` — create; copy it to `.env` locally (never commit)
- `.gitignore` — modify (ignore local secrets and SQLite files)
- `drizzle.config.ts` — create
- `src/lib/server/db/schema.ts` — create
- `src/lib/server/db/index.ts` — create
- `src/lib/server/crypto.ts` — create
- `src/lib/server/youtube.ts` — create
- `src/lib/server/moderation.ts` — create
- `src/lib/server/pipeline.ts` — create
- `src/lib/server/session.ts` — create
- `src/hooks.server.ts` — create
- `src/routes/api/auth/google/+server.ts` — create
- `src/routes/api/auth/google/callback/+server.ts` — create
- `src/routes/api/cron/+server.ts` — create
- `src/routes/+layout.svelte` — modify (nav bar)
- `src/routes/+page.server.ts` — create (dashboard data)
- `src/routes/+page.svelte` — modify (dashboard)
- `src/routes/channels/[id]/rules/+page.server.ts` — create
- `src/routes/channels/[id]/rules/+page.svelte` — create
- `src/routes/channels/[id]/queue/+page.server.ts` — create
- `src/routes/channels/[id]/queue/+page.svelte` — create
- `src/routes/channels/[id]/log/+page.server.ts` — create
- `src/routes/channels/[id]/log/+page.svelte` — create
- `src/app.css` — create, and import it in `+layout.svelte`
- `src/app.d.ts` — modify (type `App.Locals`)

## 4. Constraints

**Do NOT:**
- Do not add dependencies beyond: `drizzle-orm`, `@libsql/client` (runtime), and `@sveltejs/adapter-node` plus `drizzle-kit` (dev). No auth libraries, no googleapis SDK, no OpenAI SDK, no CSS frameworks — everything uses `fetch` and hand-written CSS.
- Do not commit or push directly to `main`; never merge your own PR (see section 0). Stop after opening each phase PR and wait for human merge confirmation.
- Do not refactor, rename, or reformat anything outside the steps below.
- Do not add features not listed: no LLM judge, no reply moderation, no live chat, no pagination UI on the queue, no user accounts beyond the OAuth'd channel, no settings page.
- Do not store comment text longer than 500 characters (truncate on insert).
- Do not guess API signatures — every external call needed is written in this document.
- Do not commit `.env` or `local.db`.

**Non-goals (look related, but are NOT part of this task):**
- LLM-as-judge for borderline comments (borderline → human queue instead). Post-MVP.
- Stripe/billing, landing page, multi-platform moderation, deployment config (Dockerfile, CI).
- Replies moderation, real-time scanning, websockets.

---

## 5. Steps

### Phase A — Scaffold (Steps 1–4)

#### Step 1: Scaffold the SvelteKit project

Run in the empty parent directory:

```bash
npx sv create --template minimal --types ts --no-add-ons --install npm Moderaty
cd Moderaty
```

**Verify:** `ls` shows `package.json`, `svelte.config.js`, `src/`. `cat package.json | grep svelte` shows `@sveltejs/kit` in devDependencies.

**If this fails:**
- If the `sv` CLI errors on flags: run `npx sv create Moderaty` interactively and choose: template = minimal, type checking = TypeScript, add-ons = none, package manager = npm.
- Otherwise: stop, paste the full error, report back.

#### Step 2: Install the exact dependency set

```bash
npm install drizzle-orm @libsql/client
npm install -D @sveltejs/adapter-node drizzle-kit
```

**Verify:** `npm ls drizzle-orm @libsql/client @sveltejs/adapter-node drizzle-kit` prints all four with versions, no `UNMET` or errors.

**If this fails:** stop, paste the full error, report back.

#### Step 3: Switch to adapter-node

**File:** `svelte.config.js`

**Find this anchor:**
```js
import adapter from '@sveltejs/adapter-auto';
```

**Action:** replace that line with:
```js
import adapter from '@sveltejs/adapter-node';
```

**Verify:** `grep adapter-node svelte.config.js` prints the line.

**If this fails:** if the import line differs slightly, replace whatever adapter import exists with the adapter-node import, keeping the rest of the file unchanged.

#### Step 4: Create `.env.example` and gitignore local secrets

**File:** `.env.example` — create with:

```
# Google OAuth (from Google Cloud Console → APIs & Services → Credentials)
GOOGLE_CLIENT_ID=placeholder
GOOGLE_CLIENT_SECRET=placeholder
# Public base URL of the app (no trailing slash)
APP_URL=http://localhost:5173
# Database: local SQLite file for dev; swap to libsql://... + token for Turso in prod
TURSO_DATABASE_URL=file:local.db
TURSO_AUTH_TOKEN=
# OpenAI
OPENAI_API_KEY=placeholder
# Secret for the cron endpoint (any random string)
CRON_SECRET=change-me-long-random-string
# 64 hex chars (32 bytes) — generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=placeholder-64-hex-chars
# When "true", pipeline classifies and logs but makes no write calls to YouTube
DRY_RUN=true
```

Copy `.env.example` to `.env` locally and replace placeholders; never commit `.env` or other secret-bearing `.env.*` files. Keep only `.env.example` and `.env.test` unignored.

**File:** `.gitignore` — ignore `.env`, `.env.*`, and `local.db*`, then unignore `.env.example` and `.env.test`.

**Verify:** `test -f .env.example` succeeds. `grep -c '^\.env$' .gitignore` prints `1`.

**If this fails:** if `.gitignore` does not exist, create it containing `.env`, `local.db*`, `node_modules`, `.svelte-kit`, `build`.

---

### Phase B — Database (Steps 5–7)

#### Step 5: Create the Drizzle schema

**File:** `src/lib/server/db/schema.ts` — create with exactly:

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(), // YouTube channel ID (UC...)
  title: text('title').notNull(),
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  cursor: text('cursor'), // ISO timestamp of newest comment seen; null = never polled
  active: integer('active').notNull().default(1),
  createdAt: text('created_at').notNull().default(new Date().toISOString())
});

export const rules = sqliteTable('rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: text('channel_id').notNull(),
  type: text('type').notNull(), // 'keyword' | 'regex' | 'user'
  pattern: text('pattern').notNull(), // keyword string | regex source | authorChannelId
  action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban'
  createdAt: text('created_at').notNull().default(new Date().toISOString())
});

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(), // YouTube comment ID
  channelId: text('channel_id').notNull(),
  authorChannelId: text('author_channel_id').notNull(),
  authorName: text('author_name').notNull(),
  text: text('text').notNull(), // truncated to 500 chars on insert
  publishedAt: text('published_at').notNull(),
  status: text('status').notNull(), // 'pending' | 'approved' | 'held' | 'rejected' | 'deleted'
  decidedBy: text('decided_by').notNull(), // 'rule' | 'ai' | 'human' | 'none'
  matchedRuleId: integer('matched_rule_id'),
  aiScore: text('ai_score'), // JSON string of the six category scores, or null
  createdAt: text('created_at').notNull().default(new Date().toISOString())
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: text('channel_id').notNull(),
  commentId: text('comment_id').notNull(),
  action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban' | 'approve' | 'queue' | 'dry-run'
  reason: text('reason').notNull(), // human-readable, e.g. "rule #4 (keyword)" or "ai score 0.91"
  actor: text('actor').notNull(), // 'system' | 'user'
  createdAt: text('created_at').notNull().default(new Date().toISOString())
});

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: text('channel_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(new Date().toISOString())
});
```

**Verify:** `npx tsc --noEmit` later; for now `grep -c sqliteTable src/lib/server/db/schema.ts` prints `5`.

**If this fails:** if drizzle-orm reports a type error on `default(new Date().toISOString())`, that is acceptable — it is evaluated once at import in some drizzle versions; leave it (dates are also set explicitly at insert time in the pipeline). Do not restructure the schema.

#### Step 6: Create the DB client and drizzle config

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

(The `as never` cast silences a drizzle-kit typing quirk where `token` is not accepted for local file URLs. Do not remove it.)

**File:** `package.json` — add `"db:push": "drizzle-kit push"` only now, after the schema and config exist.

**Verify:** `grep -c createClient src/lib/server/db/index.ts` prints `1`.

**If this fails:** if `$env/dynamic/private` cannot be resolved yet, that resolves after `npm run dev` generates types — proceed.

#### Step 7: Push the schema

```bash
npm run db:push
```

**Verify:** command exits 0 and `local.db` exists (`ls local.db`). Confirm tables: `node -e "const{createClient}=require('@libsql/client');createClient({url:'file:local.db'}).execute(\"SELECT name FROM sqlite_master WHERE type='table'\").then(r=>console.log(r.rows.map(x=>x.name).join(',')))"` prints names including `channels,rules,comments,audit_log`.

**If this fails:**
- If drizzle-kit prompts interactively about table creation: accept the prompts (create tables).
- If `TURSO_DATABASE_URL` is reported missing: copy `.env.example` to `.env`, then run with env loaded: `set -a; . ./.env; set +a; npm run db:push` (drizzle-kit does not auto-load `.env`).
- Otherwise: stop, paste the full error, report back.

---

### Phase C — Server libraries (Steps 8–11)

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
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
```

**Verify:** `node -e "console.log('syntax ok')"` trivially passes; real check comes at Step 13 build.

**If this fails:** stop, paste the full error, report back.

#### Reliability requirements (applies to Steps 9–13)

Use a shared `fetchWithTimeout` helper with a 10-second `AbortSignal` timeout.
Retry only transient network failures, HTTP 429, and HTTP 5xx responses, at most
three times with bounded exponential backoff and `Retry-After` when supplied;
never retry the one-time OAuth code exchange. Treat a malformed moderation
response as a failure: do not approve the comment or advance its channel cursor.

For non-dry runs, persist a comment and its audit row only after its required
YouTube action succeeds. Retry idempotent moderation actions before failing the
channel; a failed channel leaves its cursor unchanged for the next run. Dry runs
write only `dry-run` audit rows, perform no YouTube writes, persist no comment
decision, and never advance the cursor.

#### Step 9: YouTube API client

**File:** `src/lib/server/youtube.ts` — create with exactly:

```ts
import { env } from '$env/dynamic/private';

const YT = 'https://www.googleapis.com/youtube/v3';

export interface NewComment {
  id: string;
  threadId: string;
  authorChannelId: string;
  authorName: string;
  text: string;
  publishedAt: string;
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`token refresh failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.access_token as string;
}

async function ytFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${YT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) }
  });
  return res;
}

export async function fetchNewComments(
  channelId: string,
  accessToken: string,
  cursor: string | null
): Promise<NewComment[]> {
  const out: NewComment[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({
      part: 'snippet',
      allThreadsRelatedToChannelId: channelId,
      order: 'time',
      maxResults: '100',
      textFormat: 'plainText'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await ytFetch(`/commentThreads?${params}`, accessToken);
    const data = await res.json();
    if (!res.ok) throw new Error(`commentThreads.list failed: ${res.status} ${JSON.stringify(data)}`);
    let reachedCursor = false;
    for (const item of data.items ?? []) {
      const c = item.snippet.topLevelComment;
      const s = c.snippet;
      if (cursor && s.publishedAt <= cursor) {
        reachedCursor = true;
        continue;
      }
      out.push({
        id: c.id,
        threadId: item.id,
        authorChannelId: s.authorChannelId?.value ?? 'unknown',
        authorName: s.authorDisplayName ?? 'unknown',
        text: (s.textDisplay ?? '').slice(0, 500),
        publishedAt: s.publishedAt
      });
    }
    if (reachedCursor || !data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
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
    const res = await ytFetch(`/comments/setModerationStatus?${params}`, accessToken, { method: 'POST' });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`setModerationStatus failed: ${res.status} ${body}`);
    }
  }
}

export async function deleteComment(id: string, accessToken: string): Promise<void> {
  const res = await ytFetch(`/comments?id=${encodeURIComponent(id)}`, accessToken, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`comments.delete failed: ${res.status} ${body}`);
  }
}
```

**Verify:** `grep -c 'export async function' src/lib/server/youtube.ts` prints `4`.

**If this fails:** stop, paste the full error, report back.

#### Step 10: OpenAI moderation client

**File:** `src/lib/server/moderation.ts` — create with exactly:

```ts
import { env } from '$env/dynamic/private';

const TOXIC_CATEGORIES = [
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'violence',
  'violence/graphic'
] as const;

export interface ModerationResult {
  score: number; // max of the six toxic category scores
  scores: Record<string, number>; // the six category scores
}

export async function scoreComment(text: string): Promise<ModerationResult> {
  const res = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'omni-moderation-latest', input: text })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`moderation failed: ${res.status} ${JSON.stringify(data)}`);
  const cat = data.results?.[0]?.category_scores;
  if (!cat || TOXIC_CATEGORIES.some((k) => typeof cat[k] !== 'number')) {
    throw new Error('moderation response is missing required category scores');
  }
  const scores: Record<string, number> = {};
  let max = 0;
  for (const k of TOXIC_CATEGORIES) {
    const v = cat[k];
    scores[k] = v;
    if (v > max) max = v;
  }
  return { score: max, scores };
}
```

**Verify:** `grep -c omni-moderation-latest src/lib/server/moderation.ts` prints `1`.

**If this fails:** stop, paste the full error, report back.

#### Step 11: The moderation pipeline

**File:** `src/lib/server/pipeline.ts` — create with exactly:

```ts
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { channels, rules, comments, auditLog } from './db/schema';
import { decrypt } from './crypto';
import { refreshAccessToken, fetchNewComments, setModerationStatus, deleteComment } from './youtube';
import { scoreComment } from './moderation';

const AUTO_REJECT = 0.85;
const QUEUE = 0.35;

export interface RuleRow {
  id: number;
  type: string;
  pattern: string;
  action: string;
}

export function matchRule(text: string, authorChannelId: string, rs: RuleRow[]): RuleRow | null {
  const lower = text.toLowerCase();
  for (const r of rs) {
    if (r.type === 'keyword' && lower.includes(r.pattern.toLowerCase())) return r;
    if (r.type === 'user' && authorChannelId === r.pattern) return r;
    if (r.type === 'regex') {
      try {
        if (new RegExp(r.pattern, 'i').test(text)) return r;
      } catch {
        // invalid user-supplied regex: skip the rule, never crash the pipeline
      }
    }
  }
  return null;
}

async function log(channelId: string, commentId: string, action: string, reason: string, actor: string) {
  await db.insert(auditLog).values({
    channelId,
    commentId,
    action,
    reason,
    actor,
    createdAt: new Date().toISOString()
  });
}

export async function runChannel(channelId: string): Promise<{ fetched: number; acted: number; queued: number }> {
  const ch = await db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!ch || !ch.active) return { fetched: 0, acted: 0, queued: 0 };
  const dryRun = process.env.DRY_RUN === 'true';

  const accessToken = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
  const fresh = await fetchNewComments(channelId, accessToken, ch.cursor);
  if (fresh.length === 0) return { fetched: 0, acted: 0, queued: 0 };

  const rs = await db.select().from(rules).where(eq(rules.channelId, channelId)).all();

  const holdIds: string[] = [];
  const rejectIds: string[] = [];
  const banIds: string[] = [];
  let acted = 0;
  let queued = 0;

  for (const c of fresh) {
    const existing = await db.select().from(comments).where(eq(comments.id, c.id)).get();
    if (existing) continue;

    let status = 'pending';
    let decidedBy = 'none';
    let matchedRuleId: number | null = null;
    let aiScoreJson: string | null = null;

    const hit = matchRule(c.text, c.authorChannelId, rs);
    if (hit) {
      matchedRuleId = hit.id;
      decidedBy = 'rule';
      const reason = `rule #${hit.id} (${hit.type}: ${hit.pattern.slice(0, 80)})`;
      if (hit.action === 'hold') {
        status = 'held';
        holdIds.push(c.id);
        await log(channelId, c.id, dryRun ? 'dry-run' : 'hold', reason, 'system');
      } else if (hit.action === 'reject') {
        status = 'rejected';
        rejectIds.push(c.id);
        await log(channelId, c.id, dryRun ? 'dry-run' : 'reject', reason, 'system');
      } else if (hit.action === 'delete') {
        status = 'deleted';
        if (!dryRun) await deleteComment(c.id, accessToken);
        await log(channelId, c.id, dryRun ? 'dry-run' : 'delete', reason, 'system');
      } else if (hit.action === 'ban') {
        status = 'rejected';
        banIds.push(c.id);
        await log(channelId, c.id, dryRun ? 'dry-run' : 'ban', reason, 'system');
      }
      acted++;
    } else {
      const m = await scoreComment(c.text);
      aiScoreJson = JSON.stringify(m.scores);
      if (m.score >= AUTO_REJECT) {
        status = 'rejected';
        decidedBy = 'ai';
        rejectIds.push(c.id);
        await log(channelId, c.id, dryRun ? 'dry-run' : 'reject', `ai score ${m.score.toFixed(2)}`, 'system');
        acted++;
      } else if (m.score >= QUEUE) {
        status = 'pending';
        decidedBy = 'ai';
        queued++;
        await log(channelId, c.id, dryRun ? 'dry-run' : 'queue', `ai score ${m.score.toFixed(2)}`, 'system');
      } else {
        status = 'approved';
        decidedBy = 'ai';
      }
    }

    if (!dryRun) {
      await db.insert(comments).values({
        id: c.id,
        channelId,
        authorChannelId: c.authorChannelId,
        authorName: c.authorName,
        text: c.text,
        publishedAt: c.publishedAt,
        status,
        decidedBy,
        matchedRuleId,
        aiScore: aiScoreJson,
        createdAt: new Date().toISOString()
      });
    }
  }

  if (!dryRun) {
    if (holdIds.length) await setModerationStatus(holdIds, 'heldForReview', false, accessToken);
    if (rejectIds.length) await setModerationStatus(rejectIds, 'rejected', false, accessToken);
    if (banIds.length) await setModerationStatus(banIds, 'rejected', true, accessToken);
  }

  if (!dryRun) {
    const newest = fresh.map((c) => c.publishedAt).sort().at(-1)!;
    await db.update(channels).set({ cursor: newest }).where(eq(channels.id, channelId));
  }

  return { fetched: fresh.length, acted, queued };
}
```

Note: rule actions queue YouTube write calls into `holdIds`/`rejectIds`/`banIds` (batched at the end), while `delete` executes inline (1 call per comment, no batch endpoint exists). This is intentional — do not "optimize" it.

**Verify:** `grep -c 'AUTO_REJECT = 0.85' src/lib/server/pipeline.ts` prints `1`.

**If this fails:** if drizzle `.get()` / `.all()` are reported as unknown methods, this project is on an old drizzle-orm — run `npm install drizzle-orm@latest` and continue. Otherwise stop and report.

---

### Phase D — Auth and cron routes (Steps 12–13)

#### Step 12: Google OAuth routes and sessions

Create `src/lib/server/session.ts` with opaque 32-byte random tokens, SHA-256
token hashes stored in `sessions`, and seven-day expiry. Create
`src/hooks.server.ts` to resolve a valid `moderaty_session` cookie into
`locals.channelId`; type that local in `src/app.d.ts`. Use `HttpOnly`, `SameSite=Lax`,
`Path=/`, and `Secure` outside development. Protect dashboard, rules, queue, and
audit routes by requiring this local and matching each route's channel ID.

The OAuth start route must generate a random state value, store it in a separate
short-lived secure cookie, and include it in the Google URL. The callback must
compare and clear that cookie before exchanging the code, then create a session
for the returned channel.

**File:** `src/routes/api/auth/google/+server.ts` — create with exactly:

```ts
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { randomBytes } from 'node:crypto';

export function GET({ cookies }) {
  const state = randomBytes(32).toString('base64url');
  cookies.set('moderaty_oauth_state', state, {
    httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: 600
  });
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
}
```

**File:** `src/routes/api/auth/google/callback/+server.ts` — create with exactly:

```ts
import { redirect, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { encrypt } from '$lib/server/crypto';
import { createSession } from '$lib/server/session';

export async function GET({ url, cookies }) {
  const code = url.searchParams.get('code');
  if (!code) throw error(400, 'missing code');
  const state = url.searchParams.get('state');
  const expectedState = cookies.get('moderaty_oauth_state');
  cookies.delete('moderaty_oauth_state', { path: '/' });
  if (!state || !expectedState || state !== expectedState) throw error(400, 'invalid OAuth state');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${env.APP_URL}/api/auth/google/callback`,
      grant_type: 'authorization_code'
    })
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || !tokens.refresh_token) {
    throw error(400, 'token exchange failed; revoke previous app access and retry if this channel was connected before');
  }

  const accessToken = tokens.access_token as string;
  const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const chData = await chRes.json();
  const ch = chData.items?.[0];
  if (!ch) throw error(400, 'no YouTube channel found for this Google account');

  await db
    .insert(channels)
    .values({
      id: ch.id,
      title: ch.snippet.title,
      refreshTokenEnc: encrypt(tokens.refresh_token),
      active: 1,
      createdAt: new Date().toISOString()
    })
    .onConflictDoUpdate({
      target: channels.id,
      set: { title: ch.snippet.title, refreshTokenEnc: encrypt(tokens.refresh_token), active: 1 }
    });

  await createSession(ch.id, cookies);
  throw redirect(302, '/');
}
```

**Verify:** `npm run check` (or `npx svelte-check`) reports 0 errors for these two files.

**If this fails:**
- If TS complains about implicit `any` on `{ url }`: add the type `import type { RequestHandler } from './$types';` and annotate `export const GET: RequestHandler = async ({ url }) => {` instead of the bare function form. Apply the same pattern in Step 13.
- Otherwise: stop, paste the full error, report back.

#### Step 13: Cron endpoint

**File:** `src/routes/api/cron/+server.ts` — create with exactly:

```ts
import { json, error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { runChannel } from '$lib/server/pipeline';

export async function POST({ request }) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '');
  const expected = env.CRON_SECRET ?? '';
  if (!token || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    throw error(401, 'bad secret');
  }
  const chs = await db.select().from(channels).all();
  const results: Record<string, unknown> = {};
  for (const ch of chs) {
    try {
      results[ch.id] = await runChannel(ch.id);
    } catch (e) {
      results[ch.id] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return json({ ok: true, dryRun: process.env.DRY_RUN === 'true', results });
}
```

**Verify:** `npm run build` exits 0.

**If this fails:**
- If build errors reference `$env/dynamic/private` variables possibly undefined: the non-null assertions (`!`) in the code handle this; do not restructure. If errors persist, stop, paste full output, report back.
- If drizzle schema import errors: re-check Step 5 file name and exports (`channels`, `rules`, `comments`, `auditLog`).

---

### Phase E — UI (Steps 14–19)

All pages use plain server loads + form actions (no client-side fetching). Styling: one global stylesheet.

#### Step 14: Global stylesheet and layout

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

**Verify:** `npm run dev` starts; `curl -s http://localhost:5173 | grep -c 'Moderaty'` prints ≥ 1. Stop the dev server after checking.

**If this fails:** preserve Svelte 5 runes and `{@render children()}`; fix the scaffold or configuration, then stop and report. Do not introduce `<slot />`.

#### Step 15: Dashboard

**File:** `src/routes/+page.server.ts` — create with exactly:

```ts
import { db } from '$lib/server/db';
import { channels, comments } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';

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
  let { data } = $props();
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
    <p class="muted">ID: {ch.id} · last polled up to: {ch.cursor ?? 'never'}</p>
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

**Verify:** dev server renders `/` with the "Connect YouTube channel" button.

**If this fails:** if TS errors on `(s: any)` inside markup, move `count` to accept `data.stats` typed as `any[]` — do not restructure the load function. Otherwise stop and report.

#### Step 16: Rules page

**File:** `src/routes/channels/[id]/rules/+page.server.ts` — create with exactly:

```ts
import { db } from '$lib/server/db';
import { channels, rules } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';

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
    if (!pattern) return fail(400, { error: 'pattern required' });
    if (type === 'regex') {
      try {
        new RegExp(pattern);
      } catch {
        return fail(400, { error: 'invalid regex' });
      }
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
    const ruleId = Number(f.get('ruleId'));
    if (!Number.isSafeInteger(ruleId) || ruleId < 1) return fail(400, { error: 'bad rule ID' });
    await db.delete(rules).where(and(eq(rules.id, ruleId), eq(rules.channelId, params.id)));
    return { ok: true };
  }
};
```

**File:** `src/routes/channels/[id]/rules/+page.svelte` — create with exactly:

```svelte
<script lang="ts">
  let { data, form } = $props();
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

**Verify:** `npm run check` reports 0 errors in the rules page files.

**If this fails:** stop, paste the full error, report back.

#### Step 17: Review queue page

**File:** `src/routes/channels/[id]/queue/+page.server.ts` — create with exactly:

```ts
import { db } from '$lib/server/db';
import { channels, comments, auditLog } from '$lib/server/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
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
  if (!commentId) throw error(400, 'missing comment ID');
  const ch = await db.select().from(channels).where(eq(channels.id, paramsId)).get();
  if (!ch) throw new Error('channel not found');
  const comment = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.channelId, paramsId)))
    .get();
  if (!comment) throw error(404, 'comment not found');
  if (process.env.DRY_RUN !== 'true' && action !== 'approve') {
    const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
    if (action === 'reject') await setModerationStatus([commentId], 'rejected', false, token);
    if (action === 'ban') await setModerationStatus([commentId], 'rejected', true, token);
    if (action === 'delete') await deleteComment(commentId, token);
  }
  const status =
    action === 'approve' ? 'approved' : action === 'delete' ? 'deleted' : 'rejected';
  await db
    .update(comments)
    .set({ status, decidedBy: 'human' })
    .where(and(eq(comments.id, commentId), eq(comments.channelId, paramsId)));
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
  let { data } = $props();
</script>

<h1>Review queue — {data.ch?.title}</h1>
<p class="muted">Borderline comments (AI score 0.35 ≤ score &lt; 0.85). Nothing here is public-facing yet only if previously held; rejected/approved comments already have their final state. Your action is final.</p>

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

**Verify:** `npm run check` reports 0 errors.

**If this fails:** stop, paste the full error, report back.

#### Step 18: Audit log page

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
  let { data } = $props();
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

**Verify:** `npm run check` reports 0 errors.

**If this fails:** stop, paste the full error, report back.

#### Step 19: Full build

```bash
npm run check && npm run build
```

**Verify:** both exit 0 with no errors.

**If this fails:**
- If errors are TS `any` complaints in `.svelte` files: add `lang="ts"` is already present; annotate the `let { data } = $props();` as `let { data }: { data: any } = $props();` in the failing file only.
- Otherwise: stop, paste the full error, report back.

---

### Phase F — End-to-end verification (Steps 20–21)

#### Step 20: Configure real credentials

Manually (human task — the executor stops here and asks the human):

1. Google Cloud Console → create project → enable **YouTube Data API v3** → OAuth consent screen (external, add scope `https://www.googleapis.com/auth/youtube.force-ssl`, add the test user's Gmail as a test user) → create OAuth client (Web) with authorized redirect URI `http://localhost:5173/api/auth/google/callback`.
2. Put the client ID/secret and a valid OpenAI key into `.env`, generate a real `ENCRYPTION_KEY`, set a `CRON_SECRET`. Keep `DRY_RUN=true` for the first run.

**Verify:** `.env` contains no `placeholder` values except unchanged optional ones: `grep -c placeholder .env` prints `0` (or `1` if `TURSO_AUTH_TOKEN` line untouched — it should be empty, not placeholder).

#### Step 21: Live smoke test (dry run, then real)

1. `npm run dev`
2. Open `http://localhost:5173`, click "Connect YouTube channel", complete OAuth with the test account that owns a YouTube channel. Expect redirect back to `/` showing the channel card.
3. Add one keyword rule matching a word in a recent comment on that channel (action: `hold`).
4. `curl -X POST -H "Authorization: Bearer <CRON_SECRET>" http://localhost:5173/api/cron` — expect JSON with `dryRun: true` and per-channel `{ fetched, acted, queued }` counts ≥ 0, no `error` values.
5. Check the audit log page — expect rows. Check the rules hit appears as action `dry-run`.
6. Set `DRY_RUN=false`, restart, re-run the cron — expect the matched comment to be held on YouTube (visible in YouTube Studio → Comments → Held for review), DB status `held`, audit action `hold`.
7. Approve one pending queue item from the UI — expect status change and audit row with actor `user`.

**If this fails:**
- OAuth error `redirect_uri_mismatch`: the redirect URI in Google Cloud Console must be exactly `http://localhost:5173/api/auth/google/callback` and `APP_URL` must be `http://localhost:5173`. Fix the console, not the code.
- `token exchange failed ... refresh_token` absent: revoke the app at https://myaccount.google.com/permissions and reconnect (Google only issues a refresh token on first consent or with `prompt=consent`, which we set).
- `commentThreads.list failed: 403 quotaExceeded`: wait for the daily quota reset; do not create additional Google Cloud projects.
- Anything else: stop, paste the full error, report back.

---

## 6. Definition of done

All of the following must be true before reporting completion:

- [ ] Every phase A–F has its own branch, an open-then-merged PR reviewed by the human, and the executor never committed directly to `main` or merged its own PR
- [ ] `npm run check` and `npm run build` both exit 0
- [ ] `local.db` contains tables `channels`, `rules`, `comments`, `audit_log`
- [ ] OAuth flow completes and a channel row exists with a non-null encrypted refresh token
- [ ] `POST /api/cron` with a Bearer token and `DRY_RUN=true` returns `dryRun: true`, writes only `dry-run` audit rows, leaves the cursor unchanged, and makes no YouTube write calls
- [ ] With `DRY_RUN=false`, a keyword-rule hit results in the comment held/rejected on YouTube (confirmed in YouTube Studio), DB status updated, audit row with actor `system`
- [ ] Review queue shows borderline comments (0.35 ≤ score < 0.85) and each of the four buttons (approve/reject/delete/ban) updates only the authenticated channel's DB rows and audit log with actor `user`
- [ ] Rules page rejects invalid regex input with an error message
- [ ] Invalid `secret` on `/api/cron` returns 401
- [ ] No files outside the "Files you will create or modify" list were changed
- [ ] No dependencies beyond the approved list were added (`grep '"dependencies"' -A 10 package.json` shows only the approved packages plus scaffold defaults)

If any box cannot be checked, report which one and the exact failure output. Do not report success with unchecked boxes.
