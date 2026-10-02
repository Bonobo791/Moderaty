# Contact Message Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. The user approved this bounded design and implementation on a separate branch.

**Goal:** Let visitors submit an optional message and deliver verified requests to contact@moderaty.com.

**Architecture:** Add nullable message and delivery-state columns to contact submissions. Verification atomically queues delivery; an expiring atomic claim protects concurrent sends. The existing cron retries one due notification per tick within its shared deadline. Use the existing SMTP transport, adding validated Reply-To and stable Message-ID support.

**Tech Stack:** SvelteKit, TypeScript, Drizzle, SQLite/libSQL, Nodemailer, Vitest.

**Spec:** Approved design: optional 2,000-character message, blank stored as null, server validation, error repopulation, safe owner notification only after verification, fixed recipient and visitor Reply-To, durable retries, separate branch.

## Global Constraints
- Work only on feat/contact-message from current dev; no push, merge, deployment, or production database changes.
- Additive nullable migration; preserve existing applied migrations and historical consent evidence.
- No message content in the visitor verification email; no actual email sends in tests or QA.
- SMTP has an unavoidable acceptance/commit ambiguity: retries may duplicate after a crash, never claim exactly-once delivery.

## Review Focus
- Multipart File values and over-limit whitespace must be rejected rather than coerced or truncated.
- Resubmission and failed verification sends retain multiline content and use the latest pending request.
- Repeated/concurrent verification and cron attempts must not send in parallel or resend recorded successes.
- SMTP failure, expired claims, and verification-time races must retain durable retry intent.
- Historical verified rows must not suddenly produce unsolicited backfill notifications.

## Task 1: Contact message and verified delivery
- [x] Add failing parser, persistence, action, transport, notification, migration, and cron integration tests.
- [x] Verify expected failures, then implement nullable storage, form and consent copy, and safe transport headers.
- [x] Implement atomic verification/queueing, notification claim/send/acknowledgment, pending UI state, and bounded cron retries.
- [x] Run focused tests and verify migration on a synthetic local database. Local HTTP checks cover rendered form states; visual browser QA is blocked by the environment.
- [x] Run npm run test, npm run check, and npm run build; get independent review and address findings with regression tests.
- [x] Commit the green branch locally and report publication and operator migration requirements.


## Verification and release notes

- Final aggregate: 3,121 tests in 169 files pass; Svelte check reports zero errors and warnings. Node and Netlify builds pass.
- Independent review found a Message-ID collision between databases with the same integer row IDs. A failing regression test reproduced it; the fix hashes the random verification token and passes. The token is never included in the notification.
- Migration 0059 is additive; tests preserve historical pending/verified rows and verify nullable columns, the retry index, and SQLite integrity. The 0026 → 0028 → 0059 contact migration chain was also checked independently.
- Apply and verify 0059 on each target database before code relying on the new columns is exercised. No live migration was run.
- The current cron must remain scheduled for automatic retries. It sends at most one due notification per tick, uses the shared deadline, and skips delivery under DRY_RUN. Failed sends retain a 60-second retry delay; crashed claims recover after expiry.
- Existing verified requests are not backfilled. Messages stay out of visitor verification mail. Only new verifications queue inbox delivery.
- SMTP acceptance followed by a crash before the database acknowledgement can result in a retry copy. Stable, globally unique Message-IDs aid identification but are not an exactly-once SMTP guarantee.
- Visual browser QA could not run because the cloud browser blocks localhost. A desktop/mobile visual pass remains before release.
- Publication, merge, deployment, and production database changes remain outside this implementation.

- Remote review: Codacy flagged new HTML interpolation. A failing malformed-request-ID regression led to escaping the complete plaintext body once before adding static HTML framing. This also removes HTML-looking interpolation from the SMTP Message-ID. The full suite, check, and both builds pass after the fix.
