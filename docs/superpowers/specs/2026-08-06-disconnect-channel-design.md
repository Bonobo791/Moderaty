<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

Licensed under the PolyForm Shield License 1.0.0; you may not use
this file except in compliance with the License. You may obtain a
copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.

The software is provided "as is", without warranty or condition of
any kind, express or implied. See the License for the specific
language governing permissions and limitations under the License.
A copy of the License is included in the LICENSE file at the
repository root.

Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md
-->

# Disconnect channel (full removal) — design

Date: 2026-08-06. Status: implemented on `dev` (approach A).

> The implementation lives in `src/routes/(app)/channels/[id]/+page.server.ts`
> and the channel detail page. This historical design originally described a
> dashboard action; the channel detail location is now authoritative.

## Purpose

A channel owner can disconnect a channel from Moderaty entirely: the stored
YouTube grant is revoked (best-effort) and the channel plus all its data is
erased. Primary driver: the dev environment holds production-copied channels
whose grants belong to the production OAuth client (`401 unauthorized_client`
on refresh); disconnect + reconnect mints a fresh per-environment grant.
(Reconnect alone already overwrites the grant via `upsertChannelConnection`;
disconnect is the general "remove this channel and its history" feature.)

## Semantics (settled with maintainer)

**Full channel removal.** One dashboard action deletes, in one transaction:
`moderation_actions` → `comments` → `audit_log` → `rules` → `channels` for
the channel id. Not a token wipe — the row and its history go.

## Server

- New dashboard form action `disconnectChannel`
  (`src/routes/(app)/dashboard/+page.server.ts`), fields `channelId` +
  `confirm`. Unticked checkbox → loud 400, nothing deleted.
- Gate: `requireUser(locals)` + `requireOrgRole(user, 'admin')` — the same
  role that connects channels (`connect-channel/+page.server.ts`).
- Tenancy: channel selected scoped by `orgId`; another team's channel reads
  as 404 (`channel not found`), nothing deleted, no existence leak.
- Best-effort revoke BEFORE the erase:
  `revokeGoogleToken(decrypt(channel.refreshTokenEnc), logPrefix)` in
  try/catch — failure (dev client vs prod-issued token, wiped sentinel,
  network) is logged loudly with `console.error` and never blocks, since the
  ciphertext dies either way. Same contract as account deletion.
- Shared helper `deleteChannelRecords(tx, channelIds)` extracted in
  `src/lib/server/deletion.ts` from the existing account-deletion block;
  `deleteUserRecords` refactored to call it (no copy-paste).
- In-flight runs: deletion is unconditional; a concurrent cron/preview's
  keyed updates no-op on the vanished row and the revoke fails it loudly.
- `console.info` on success — the channel's own audit rows die with it, so
  the server log is the evidence.

## UI

- Per-channel collapsible danger block on the dashboard channel card,
  mirroring the `deleteAccount` pattern: confirm checkbox ("I understand —
  disconnect {title} and erase its data") + danger button ("Disconnect
  channel {title}") — labeled per I13. Errors render in the card scoped by
  `form?.scope === 'disconnect' && form?.channelId === ch.id`; on success the
  card disappears via enhance/invalidateAll.
- Rendered only for admin/owner when the role is available in page data;
  server enforces regardless.

## Tests (failing first)

`src/routes/(app)/dashboard/actions.test.ts`:

- unticked confirm → 400, channel + data intact
- non-admin → 403
- another org's channel → 404, untouched
- happy path → channel + all four child tables gone; sibling channel's rows
  untouched; Google revoke called (fetch stub)
- revoke failure (non-OK) → still deleted, error logged

`src/lib/server/deletion.test.ts`: account-deletion suite stays green after
the `deleteChannelRecords` extraction.

## Out of scope

- No migration, no cron/pipeline changes.
- No token-only disconnect (rejected semantics).
- Team-org detachment rules from account deletion do not apply here — this
  action removes the channel for the whole org.
