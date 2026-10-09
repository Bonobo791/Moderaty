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
