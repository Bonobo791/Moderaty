# Signal-specific moderation actions plan

## Goal

Split the AI decision bands by scoring signal:

- **OpenAI moderation classifier** (`scoreComment`, `omni-moderation-latest`):
  score 0.76–0.94 **deletes** the comment (was reject); score ≥0.95 still
  **bans** (reject + ban author).
- **Tone AI model** (`scoreTone`, sensitivity level 2 "EDGE LORD +
  ACKCHYUALLY…", including the LGBTQIA/Women protection sections that ride in
  its prompt): a flagged score (≥0.76) only **hides** the comment —
  `heldForReview` on YouTube plus an audit row (`status='held'`,
  `action='hold'`), undoable from the log. Never delete, never ban.

Decisions locked with the maintainer:

- OpenAI classifier: "Delete at 0.76, ban at 0.95".
- Tone/protection flags: "Hide, log only" (the existing YouTube `hold` verb).
- The Fast Check oracle in `pipeline.pbt.test.ts` is explicitly authorized to
  change to pin the new signal→action mapping.

## Architecture / seam

`src/lib/server/pipeline/decisions.ts` `aiOutcome(comment, aiScore, signal,
score)` already receives `signal: 'ai' | 'tone'`; the mapping changes there
only. `aiDecision` picks the stronger signal and skips the tone call when omni
already condemns (≥0.76 → delete/ban) — unchanged. Protections flow through
`scoreTone`'s prompt, so protection flags inherit the tone policy with no
extra wiring. Enforcement needs nothing new: `delete` runs `comments.delete`,
`hold` on a `held` comment passes `partitionHolds` (status `'held'` is already
hold-applicable) and is logged by `completeActions`.

## Tech stack

SvelteKit + TypeScript, drizzle/libSQL, Vitest, fast-check, YouTube Data API.

## Spec

This document; maintainer answers in the dev session for MOD follow-up.

## Global constraints

- Work on `dev` in `.worktrees/dev`; never `main`, never production data.
- Keep `.gitignore` modification and untracked `.devin/` out of the commits.
- Thresholds unchanged: `AUTO_BAN=0.95`, `AUTO_REJECT=0.76`, `QUEUE=0.51`.
- Preserve: allowlist precedence, rules, deferred/out-of-credit, I11 queue
  fallback (metadata or scorer failure → `pending`+`hold`), dry-run, billing,
  hold/idempotency semantics, audit logging.
- Fast Check changes are authorized for this task only.
- Commit per step as `step <N>: <name>`; green `npm run check`, `npm run
  test`, `npm run build` before every commit.

## Files

Modify:

- `src/lib/server/pipeline/decisions.ts` — `aiOutcome` branches on `signal`.
- `src/lib/server/pipeline/decisions.test.ts` — band table and tone tests.
- `src/lib/server/pipeline/staging.test.ts` — dry-run audit row for the 0.8
  band flips `reject` → `delete`.
- `src/lib/server/pipeline.pbt.test.ts` — I11 oracle: omni scores sweep the
  flagged bands (delete vs ban) and the tone pass is enabled so tone-flagged
  comments assert `hold`/`held`.
- `EXECUTION_PLAN_YouTube_Comment_Moderator.md` — band description lines
  (~47, ~67) updated to the signal-specific mapping.

No new files; no schema changes.

## Steps (test-first)

1. **Plan** — this document. Commit `step 1: signal-specific moderation
   actions plan`.
2. **Decision tests red** — update `decisions.test.ts`:
   - band table rows 0.76/0.94 → `status='deleted'`, `api='delete'`,
     `audits=['delete']`; 0.95 row unchanged (ban);
   - "rejects a demeaning comment…" → tone 0.82 now `held` + `hold` audit +
     `heldForReview` remote call;
   - "bans the author of a genuinely harmful tone attack" → `held` + `hold`
     (never ban), renamed;
   - protection-flag test (protectWomen=1, tone 0.9) → `held` + `hold`;
   - "skips the tone pass at exactly the auto-reject threshold" → omni 0.76
     now `deleted` + `delete` audit + `deleteComment`;
   - "skips the tone call entirely when the omni score already rejects" →
     omni 0.8 now deletes.
   - `staging.test.ts` 0.8 row → `audit: 'delete'`.
   - Run `npx vitest run src/lib/server/pipeline` — expect red.
3. **Implement** — `aiOutcome` signal split as above. Run focused tests —
   green.
4. **PBT oracle** — `pipeline.pbt.test.ts` I11: seed the channel at
   `toneLevel=2`, omni score = `deterministicScore(text)` (sweeps all bands),
   tone score = `0.76 + deterministicScore(text) * 0.24` (always flagged).
   Oracle per comment: failed → `pending`/`hold`; omni ≥0.95 → `rejected`/
   `ban`; omni 0.76–0.94 → `deleted`/`delete`; omni <0.76 → tone decides →
   `held`/`hold`. Run — green. Commit `step 2: signal-specific moderation
   actions` (steps 2–4 together, red→green proven locally).
5. **Spec doc** — update the two EXECUTION_PLAN band lines. Commit `step 3:
   spec — signal-specific moderation actions`.
6. **Gates** — `npm run check`, `npm run test`, `npm run build`; all green.
