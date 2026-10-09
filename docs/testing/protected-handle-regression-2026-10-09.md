# Protected-handle browser regression

Based on main `496565f0187fed87238d31e6aae0f06955d2036c`, isolated on `task/protected-handle-playwright-20261009` after reading `AGENTS.md` and discussing the design. The browser test first reproduced an application bug. The identity fix was proposed, then implemented after approval.

## Reproduce

```sh
npm ci
npm run prepare
npx playwright install chromium
npm run check:e2e
npm run test:e2e
```

Use a checkout without dotenv files. The launcher refuses `.env` and `.env.*` except `.env.example`, drops inherited credentials and Node preloads, generates synthetic secrets, and creates a temporary file-backed libSQL database. It creates the documented pre-0000 base tables, applies the full real migration journal, and checks the applied count. Teardown stops the server and removes the database. Browser reports are under `reports/playwright/` and `reports/playwright-results/`.

This environment used Playwright 1.64.0 and Chromium 153.0.8010.0 with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/moderaty-chromium`: the standard browser download returned HTML instead of a ZIP. The alternate Chromium binary came from `@sparticuz/chromium` 153.0.0 outside the repository. A normal setup uses Playwright's bundled Chromium. The override changes the executable, with identical assertions and application paths.

## Failure and fix

| Identity | Configured handle | Display name | YouTube author ID | Before fix | After fix |
| --- | --- | --- | --- | --- | --- |
| Protected | `@protected_creator` | `Protected Creator` | `UCsynthetic_protected_author` | Rule ban completed | Approved by allowlist; no action |
| Control | None | `Unprotected Creator` | `UCsynthetic_control_author` | Rule ban completed | Rule ban completed |

Both comments contain `synthetic-ban-trigger`, matching the same configured ban rule. Before the fix, all persistence and positive-control checks passed, while five protected-case assertions failed. The outbound `banAuthor=true` request named both comment IDs. The retained [failing evidence](protected-handle-evidence-2026-10-09.json) records that result. The [passing evidence](protected-handle-green-evidence-2026-10-09.json) records only the control's ban, plus the protected approval and verified persisted configuration.

`youtube.ts` parses `snippet.authorDisplayName` into `authorName`. Main compared that display name with normalized configured handles. `Protected Creator` becomes `protected creator`, which cannot equal `protected_creator`. Staging also incorrectly recorded display names as handles.

YouTube supplies `snippet.authorChannelId.value` separately from display names ([Comments](https://developers.google.com/youtube/v3/docs/comments), updated September 30, 2026). Its `channels.list` API resolves a handle using `forHandle` ([Channels: list](https://developers.google.com/youtube/v3/docs/channels/list), updated September 14, 2026). Comment resources do not supply an `authorHandle` field. Generic channel `customUrl` metadata is not used to infer identities.

The UI now resolves the entered handle through `channels.list(part=id, forHandle=...)` before writing configuration. An empty, malformed, failed or ambiguous response fails the add. Migration `0071_protected_channel_identity` adds nullable `resolved_channel_id` to owner-configured protections; applied migration files are unchanged. Incoming author IDs match those configured IDs before rules or AI. Display names cannot grant protection or become stored audit handles. Protected approval audits carry the configured handle; unverified handles remain NULL.

Protection binds the verified channel identity across display-name and handle changes. Re-adding a verified handle preserves its original identity without lookup. Removing and re-adding selects its current holder. Concurrent legacy resolutions cannot overwrite an identity that was already verified.

Existing handle-only entries remain visible as unresolved and offer **Verify @handle**. Until resolution succeeds, comments that cannot be proven protected are held for review before rules or AI; automatic bans, deletes and rejects are paused. Known protected identities still receive approval. Missing author IDs also go to review whenever protections are configured. Explicit resolution works at the 100-entry limit without adding a row. Failed resolution retains the original configuration.

## What the test proves

Chromium submits the actual authenticated form, reloads the page, verifies the UI row and persisted handle plus resolved identity, then exercises production moderation. Ownership checks, sessions, consent, YouTube parsing, database reads and writes, allowlist matching, rule decisions, action staging, enforcement, completion and audits all execute. The test launcher invokes `runChannel` through IPC in the same Vite SSR module graph and database as the app; application code gains no test endpoint or authentication bypass.

The control must produce a rejected rule decision, durable completed ban action, audit row and serialized provider request before absence checks can pass. An inactive pipeline, empty provider page, disabled enforcement or dry run fails. The protected case must produce an allowlist approval and audit, no staged action, no outbound ban, and exactly one acted comment overall. Comment rows must retain NULL author names and IDs. The configured identity stays only in owner configuration.

Only external HTTP boundaries return synthetic responses: OAuth refresh, handle lookup, comment retrieval and enforcement. Unexpected server fetches throw and appear in evidence; browser requests outside the loopback app are blocked. No live provider request or real moderation occurs. AI is not invoked because the keyword rule decides the control; this test does not prove AI scoring or cron authorization. It evaluates newly fetched comments, not pre-existing staged moderation actions.

Focused real-database tests additionally cover different display names, copied protected handles, missing author IDs, unresolved legacy protections, channel scoping, lookup failure, capacity resolution and concurrent resolution/removal. Provider parser tests reject malformed and ambiguous identity responses. Upgrade tests apply the real journal twice and preserve legacy configuration with a NULL resolved identity.

## Validation

- The initial browser regression failed repeatedly on main; its control passed.
- The unchanged baseline passed 206 Vitest files and 4,021 tests.
- Final browser regression passes with the approved identity fix.
- Final Vitest: 207 files and 4,041 tests passed.
- `npm run check`: zero errors and warnings.
- `npm run check:e2e`: passed.
- `npm run build`: passed with the Netlify adapter.

No suite discovery or CI configuration was changed. Playwright explicitly discovers `.pw.ts` files, avoiding Vitest's `.test`/`.spec` patterns. No mutation or property-test configuration was changed. Future integration must reconcile package files and migration numbering/ancestry with other branches before applying migrations. No production migration, push, PR, merge or deployment was performed.
