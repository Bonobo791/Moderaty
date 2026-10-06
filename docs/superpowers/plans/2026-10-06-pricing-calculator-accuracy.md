# MSG-1 pricing calculator accuracy implementation plan

> **For agentic workers:** Use superpowers:executing-plans for tests-first implementation and a fresh independent review at the end.

**Goal:** Make the public recurring-hosted calculator reflect classification consumption and fixed-bundle purchase costs.

**Architecture:** Accept separate moderation and digest classification counts. Reuse the existing cheapest-bundle algorithm, exposing its purchased quantity as well as cost. Label the result as a zero-purchased-balance scenario and keep the three-month range independent of the single-month form.

**Tech Stack:** Svelte 5, TypeScript, Vitest, local Chromium/Playwright.

**Spec:** User-approved MSG-1 delegation; verified billing sources `src/lib/server/billing/plans.ts`, `ledger.ts`, `src/lib/server/pipeline/staging.ts`, `src/lib/server/feedbackDigest.ts`, and `src/lib/credit-pricing.ts` on main `89ffd992497ad2d3cf879cde6daf42931e6cb656`.

## Global constraints

- Preserve all plan prices, bundle thresholds, payment and billing behavior.
- Work on an isolated branch from fresh main; leave unrelated work untouched.
- No production, credentials, provider/database access, deployment, merge or push.
- Keep classification assumptions visible; exclude unknown BYOK provider costs.

## Review focus

- Zero monthly usage retains the $5 subscription.
- Moderation rules/protected handles avoid moderation charges but may incur separate digest charges.
- Digest-only and history/repeat work may exceed live moderation counts.
- Bundle boundaries and purchased leftovers stay consistent with the existing algorithm.
- Blank/invalid forms, mobile layout and independent three-month zero-balance scenarios remain honest.

## Task 1: Correct calculator and explanatory copy

**Files:** `src/lib/credit-pricing.ts`, `src/lib/credit-pricing.test.ts`, `src/lib/landing/cost.ts`, `cost.test.ts`, `pricing-faq.ts`, `pricing-faq.test.ts`, and `src/lib/components/landing/pricing/CostMath.svelte`.

**Interfaces:** Expose `purchasableCreditEstimate(credits)` as `{ costUsd, credits }`; preserve `purchasableCreditCostUsd`. Expose `estimateHostedMonth(moderationClassifications, digestClassifications = 0)` including total usage, purchased usage, purchased quantity, remaining purchased balance, and cash cost. Preserve `hostedCostUsd` and forecast functions as consumers of the same estimate.

- [x] Add failing tests for zero usage ($5), fixed thresholds, 100+100 classifications ($25.40/400 left), digest-only use, invalid counts, maximum inputs, zero/blank forecasts, and billing disclosures.
- [x] Run focused tests and record expected failures before implementation. Reproduce blank-field error in the browser.
- [x] Implement the smallest arithmetic and UI/copy change; use separate single-month inputs and total-classification forecast inputs. State zero purchased balance, full unused allowance, manual cheapest-bundle assumptions, separate scenarios and excluded lifetime/BYOK costs.
- [x] Run focused tests, `npm run check`, `npm run build`, `npm run test`; check homepage and pricing in desktop/mobile Chromium, including blank/invalid, digest and boundary cases.
- [x] Obtain independent source/diff review, resolve material findings with reproducing tests, and commit the green patch as `step 1: fix MSG-1 pricing calculator accuracy`. Report local branch and required human push/integration action.
