# PR 226 test-integrity dispositions

Base: `d0436564fa658f7057f740a6a23d59e50d6788e6` (main). No audit policy,
severity threshold, suppression, Stryker configuration, or property tests changed.

The blocking narrowed assertion in rules/actions.test.ts is replaced with three
exact values: channel, normalized handle, and a fixed creation timestamp. It also
asserts verification arguments, absence of the removed identity property, and
absence of the resolved identity in serialized storage. Restoring the identity
value would contradict migration 0072's memory-only protection contract.

The five TEST_REMOVED findings represent replacement cases, not deleted coverage:

| Original case | Replacement coverage |
| --- | --- |
| Controlled localized HTML error | Parameterized login/account-deleted fallback errors retain status, escaping, content type, and the actual English fallback language. Successful localized pages still use locale resolution. |
| Explicit resolution at capacity | Verification at capacity retains 100 rows and asserts no identity property or serialized resolved identity. |
| Concurrent legacy resolution | Duplicate verification now nests another verification during the resolver and asserts the original stored row is unchanged. Resolved holder identities are discarded. |
| Resolve existing legacy entry in place | Explicit verification retains the entered handle and verifies the provider call. Identity persistence is intentionally removed. |
| Duplicate verified identity without lookup | Duplicate configuration is verified against the provider and asserts no stored identity property. Fresh-holder verification replaces permanent binding. |

The eight EXPECTED_VALUE_CHANGED findings retain the intended contract:

| Location | Disposition |
| --- | --- |
| test-quality-context.test.mjs | Diff matching paired a removed Copilot-model assertion with a new browser check assertion. Separate Codex cases still assert the model, credentials, disabled shell, fork guard, and immutable collector. |
| hooks.server.test.ts | English fallback content now declares English; escaping/status assertions remain. |
| staging.rescan.test.ts | One additional protection read changes 11 statements to 12; both small and 300-item batches must use the same count and persist all rows. |
| youtube.test.ts | Non-OK handle lookups report sanitized HTTP 403 instead of the provider's raw message. The request still rejects. |
| rules/actions.test.ts verification failure | 503 identifies provider unavailability; storage must remain empty. |
| rules/actions.test.ts boundary failures | 503 and generic configuration error replace 400 and verification-specific copy. Secret exclusion and unchanged storage remain asserted. |
| rules/actions.test.ts diagnostic log | The diagnostic operation name follows the shared configuration boundary; the channel and Error must still be logged. |
| rules/actions.test.ts connection race | 409 identifies concurrent disconnect/reconnect/transfer; storage must remain empty. |

Author-handle enrichment failures now carry a boolean in the run result, persist
a safe `handles` health category for completed live runs, and render an alert in
synchronous previews. Background previews retain the same safe warning in their
visible audit reasons. Moderation continues; deadline failures still abort.
Regression tests reproduced the missing result/UI/health warning and missing
background audit warning before their fixes. No provider error is serialized.

## CI triage at published head 421c234

The checks were inspected against the actual job logs, not inferred from warnings.

| Check | Verified cause | Disposition |
| --- | --- | --- |
| AgentShield | Native action reports 574 npm SHA-512 integrity hashes as Azure keys, plus recommendation-only VS Code settings warnings. It does not use the repository's reviewed scan wrapper. | ECC changes require explicit owner permission. Keep its medium threshold and supply-chain scan; no configuration changed during this triage. |
| Overlock | Full PR diff pairs a removed Copilot literal with an unrelated negative stack-position assertion and counts two expected literals as one. | Equivalent escaped negative regexp preserves the assertion. Full candidate diff: zero high, 13 medium, 10 low; no suppression or threshold change. |
| ESLint | Node 22/npm 10 violate the declared engines; sample workflow also references nonexistent .eslintrc.js. | Node 24, isolated exact tool versions, real TypeScript flat config, failing exit status and SARIF output. Actual command passed locally. |
| CodeQL Advanced | GitHub rejects advanced SARIF while default setup is configured. All three default language jobs passed. | Remove the duplicate advanced workflow; retain enabled default CodeQL. |
| Merge evidence | Full tests passed, but C4 requires owner review of workflow/AGENTS changes and C8 reports incomplete PR-body scope. | Update PR description; keep owner-review gate intact. |
| Codacy | Three high false positives: fixed-width SHA-512 regexp, already interpolated template literal, and an inert compiler fixture's workflow command. Added complexity delta 218 also exceeds 100. | Source-verified dispositions; no broad exclusions, ignores or threshold changes. Remote gate remains unresolved. |

Additional valid review findings received failing regressions and local fixes:

- Verified author handles are batched; 100 configured protections need no individual lookup when all page authors have authoritative metadata. Missing metadata still invokes bounded resolver fallback.
- An authoritative unassigned handle is absence, not an outage. Its proof is scoped to the current run/authors; other failures remain fail-closed, with one bounded diagnostic per load.
- Dispatched destructive retries recheck protection and retain cancelling reconciliation evidence. An identity outage defers destructive actions, processes unrelated holds, then rethrows the failure.
- Migration 0073 restores a nullable, empty compatibility column after 0072 in the atomic migration chain. The new schema never reads or writes it. This preserves old-image reads during rollout without editing an applied migration. The complete migration-chain regression verifies old reads and absence of retained identities. Only dev-2 was migrated and verified.
- Structured expired Google grants expose a fixed reconnect instruction; provider details stay server-side.
- Migration SQL is included in Sentinel production evidence. Sentinel remains disabled; its collector must be repinned to the reviewed published revision before re-enabling.
- Enrichment copies fetched comments, and skipped malformed identity items propagate the existing user-visible run warning while retaining valid items.
- ECC's explicitly approved development dependency is recorded in AGENTS.md; the settings permission rule remains unchanged.

Validation: 220 files / 4,180 tests passed; Svelte diagnostics zero errors and
warnings; production build passed; repaired ESLint command and cognitive/cyclomatic
checks passed locally. Hosted checks still refer to 421c234 until publication.
