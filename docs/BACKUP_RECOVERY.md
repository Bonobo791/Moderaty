# Encrypted database backup and recovery

Status: implementation for review; **production activation is blocked** until the
owner completes the approval checklist below. A merged workflow, a green test,
or this document is not evidence of an operational production backup.
No production data, credentials, security settings, plans or infrastructure are
changed by the implementation or synthetic rehearsal.

## 1. Supported design and decision record

- Daily independent logical export, authenticated **age X25519** encryption of
  gzip SQL, private storage, 30-day retention. No plaintext GitHub artifacts,
  caches, dump logging, or fallback destination.
- The implemented remote adapter supports **AWS S3 only**, with bucket-owner
  enforced ownership, all four public-access blocks, a pinned account/region,
  SSE-S3 encryption (in addition to client-side age), and versioning **never enabled**. Versioning/suspended buckets and Object Lock
  need a separate version-aware retention design and are rejected. This is a
  reviewable implementation default, not an approved vendor or data transfer.
- CI uses an existing database-scoped token through HTTPS `/dump`; it does not
  mint credentials. The operator must prove that the scoped read-only token and
  approved database engine support this endpoint. Unsupported features fail
  closed. A local logged-in Turso CLI remains available for an authorized
  operator; CLI 1.0.31 may mint/cache broader database tokens internally, so
  its use needs separately approved access. Never put a platform token in CI
  for this workflow.
- Proposed independent-backup RPO: <=24 hours after successive successful daily
  exports. Missing the next scheduled run breaks that objective immediately;
  a 26-hour alert threshold is a notification grace period, not a 26-hour RPO.
  Proposed RTO: 4 hours including isolation and billing reconciliation. Neither
  objective is approved or measured against production yet.
- Proposed monitor: hourly on a separate operator-controlled host/account,
  26-hour maximum backup age, private read-only storage access, independent
  alert delivery. An additional GitHub schedule alone cannot detect GitHub-wide
  outages. The monitor's own scheduler requires an external dead-man check.
- No storage destination, region, spending cap, alert audience, key custodians
  or operational owners have been selected by this change.

### Cost and native-recovery decisions (owner required)

Measure database size, encrypted daily export size `S`, growth, quota headroom,
region and expected monthly restore/download count in a **restricted** record.
Budget at least `30 * S` steady-state bytes plus one in-flight object, manifests,
failed-upload allowance, and growth. Hourly freshness checks read small manifests
and authenticated S3 full-object checksum/size metadata, without repeatedly
downloading the payload. Include about `30 * S` monthly upload readback transfer
plus approved restore/integrity drills, manifest traffic and requests in the budget. Restrict the monitor to the same approved region
where appropriate; do not assume free transfer. Price storage, requests,
retrieval, transfer, logs, tax and alert service together, with a numeric cap and
cost alarm chosen by the owner.

Compare the existing private storage account first. AWS S3 offers the reviewed
adapter and account/private-access controls. Cloudflare R2 is an alternative
with different regional/compliance and request/transfer terms, but is **not
supported by this adapter** and must not be enabled via an endpoint override.
A second provider requires its own access, integrity and retention tests.
For a concrete example only, US East (N. Virginia) Standard currently lists
$0.023/GB-month, $0.005/1,000 PUT/COPY/POST/LIST, and $0.0004/1,000 GET/HEAD
([official regional price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json), published 2026-09-28).
A hypothetical 10 MiB encrypted daily copy retained 30 days is about 0.293 GiB,
or $0.0067/month storage, plus roughly 1–2 cents of normal requests. Full upload
readbacks transfer about 0.293 GiB/month; drills add their payload size. Transfer,
monitor hosting and taxes are separate. Propose a $5/month budget alarm pending
measured usage and approval; an alarm is not a hard spending cap. US East is a
pricing example: current repo documentation does not establish Turso's region,
so residency alignment must be confirmed before selecting the bucket region.
Current source links: [S3 pricing](https://aws.amazon.com/s3/pricing/) and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).

[Turso monthly pricing](https://turso.tech/pricing?frequency=monthly), checked
2026-10-02, lists Developer at US$5.99/month and 10-day PITR. Existing entitlement,
usage, taxes/fees and the actual checkout/terms must be verified before an owner
approves any recurring charge. Free currently lists 1-day PITR; an upgrade does
not establish historical recovery points. No plan purchase is required to test
this code. Independent backups also cover loss of access to the database/CI
provider; native recovery remains a separate layer.

## 2. Export contract and limits

Node 24.19.0, age 1.2.1 and AWS CLI 2.37.8 are pinned by the workflow; release
archives have committed SHA-256 checksums in `scripts/install-backup-tools.sh`.
Review release provenance/security changes before updating pins. The local CLI
path additionally requires Turso 1.0.31. Production and test jobs use immutable
checkout/setup-node action commits, contents-read permissions and no cache.

The export must be a complete UTF-8 SQL transaction ending in COMMIT. HTTP
status, redirects, output bounds and database hostname are checked independently
of process exit status. The local CLI preflight must return an expected HTTPS
host; login text cannot masquerade as a dump. Timeouts close/kill subprocesses,
and their stdout/stderr are never included in errors.

A fresh, in-memory SQLite database imports application schema/data from each
dump under an authorizer that
rejects filesystem attachment, extensions, arbitrary functions, views, triggers,
virtual tables and unsupported pragmas. Validation checks transaction completion,
integrity, foreign keys, exact table/column/index/FK shapes, defaults, supported
CHECK/unique/autoincrement behavior and every migration hash/timestamp against
this checkout's latest Drizzle snapshot and immutable migration files.
Migration timestamps are not assumed to be monotonically ordered. Empty
application tables are valid; an empty or schema-less response is not.

Current supported scope is this repository's ordinary SQLite tables and indexes.
Any new triggers/views, generated columns, extension/vector/virtual objects,
partial/expression indexes, engine changes or schema changes require expanding
and revalidating the contract, including an actual export/restore drill. Public libSQL [dump authorization](https://github.com/tursodatabase/libsql/blob/main/libsql-server/src/http/user/dump.rs)
and [exporter source](https://github.com/tursodatabase/libsql/blob/main/libsql-server/src/connection/dump/exporter.rs)
show read-authorized primary export inside a SQLite transaction. Hosted engine
compatibility still needs an approved canary before activation. Source-shaped
fixtures cover CR/LF `replace`/`char` expressions; only those safe SQL functions
are enabled. Optimizer-stat initialization/inserts are omitted from the isolated
validator using comment/string-aware token boundaries because local SQLite may
lack STAT4 support. The encrypted payload preserves those original statements;
statistics are not application records, and application schema/data/integrity
validation still runs. Restoring into a different SQLite build may require
rebuilding optimizer statistics under an approved compatible restore procedure.
Do not substitute `turso db export` blindly: its documented snapshot may lag the
latest database changes.

Exports are bounded to 64 MiB uncompressed; larger databases fail closed and need
a reviewed streaming design. Plaintext exists only in process memory, and SQL is
validated before compression/encryption. JavaScript strings cannot be reliably
zeroized; use a trusted ephemeral, non-swapping runner without core dumps or
memory diagnostics. Never use an untrusted/self-hosted shared runner. SIGKILL,
power loss and compromised runners are outside application cleanup guarantees.
Only ciphertext and a small allowlisted manifest ever reach temporary disk.
Temporary directories are private; normal/error/cancellation cleanup is bounded.
No application dependencies are installed in the credential-bearing backup job.

## 3. Keys and least-privilege access

CI receives one native age **public recipient**, never a private identity or
passphrase. Native X25519 recipients only; age plugins, SSH recipients and
recipient files are deliberately unsupported. Key ID is a public-recipient
SHA-256 prefix. Backups use a unique UTC timestamp plus random UUID, immutable
conditional uploads, encrypted payload SHA-256/size, schema/tool/key identifiers,
and no record contents or secret values in metadata.

The owner generates production keys through an approved secure process. Keep
the private identity in an independent approved vault/offline custody and an
approved emergency recovery copy outside CI, storage and the production host.
Name primary and backup custodians; test emergency retrieval without routine CI
access. Do not paste keys/tokens into issues, chat, logs or this repository.
Keep old identities for all backups encrypted under them, plus any explicitly
approved retention exception; verify decryption before retiring a key. Rotation
creates a new key ID; never overwrite an old key or re-encrypt in place. Suspected
exposure requires owner-led incident assessment, access revocation/rotation and
preservation of recovery capability, not indiscriminate key destruction.

The S3 writer needs scoped ListBucket, GetBucketPublicAccessBlock,
GetBucketOwnershipControls, GetBucketVersioning, PutObject, GetObject (readback)
and DeleteObject (retention), only for `moderaty-backups/<scope>/` objects and the
selected bucket metadata. This combined uploader/retention role can delete
backups: **explicitly accept that limitation or separate retention into a reviewed
role/job before activation**. It needs no bucket/security/IAM management rights,
no object ACL writes, and no decryption key. A restore operator and independent
monitor use separate GetObject/ListBucket and read-only bucket metadata access;
only the recovery operator has separate private-key access. Scope any database
token to the one approved database and read-only export capability. Verify
positive and negative permission tests; never assume a token label proves scope.

No endpoint override, ambient AWS profile or credential-process configuration is
used. This implementation reads the explicitly approved AWS credential env vars;
OIDC or another ongoing-access setup is a separately approved security change.

## 4. Activation checklist and environment mapping

Complete the Linear project gates before setting BACKUP_PRODUCTION_ENABLED=true:

- [ ] Restricted inventory: exact scope, live engine/schema, plan, size, region,
      available PITR timestamps, quota headroom, operator and current safeguards
- [ ] Owner approval: destination/data transfer, region/privacy, total budget,
      RPO/RTO/grace, key custody, retention and alert recipient/fallback
- [ ] Live export contract proven with approved disposable data and scoped token
- [ ] Private S3 anonymous read/list denied, bucket controls verified, writer vs
      monitor/recovery negative permission tests and retention design accepted
- [ ] Separately held key and emergency custody recovered using synthetic data
- [ ] Failure, missing/stale, recovery and alert-delivery failure exercised with
      approved test signals; verified recipient receipt and external dead-man
- [ ] Human security reviewer signs exact commit, permissions and remaining risk
- [ ] Owner configures credentials/settings after applicable action-time approval
- [ ] First approved production export, private object/readback/manifest verified
- [ ] That production backup restored in an approved isolated environment;
      integrity, schema, application assertions, billing and elapsed RTO verified
- [ ] Next real scheduled run and independent monitor delivery observed; no
      plaintext logs/artifacts; retention boundary tests linked
- [ ] Operator handover accepted; recurring tasks/cadence separately approved

Use a restricted GitHub environment named `production-backups` with default-branch
restriction and an appropriate approval/security policy. Creating/configuring
that environment or credentials is an operator action. The workflow also checks
default-branch ref and a repository activation variable; PRs/forks never receive
these credentials. Review all changes before they reach the default branch.
Feature-branch manual runs cannot access the production job.

Variables: BACKUP_PRODUCTION_ENABLED, BACKUP_SCOPE (safe alias),
BACKUP_DATABASE_NAME, BACKUP_EXPECTED_DATABASE_HOST, BACKUP_AGE_RECIPIENT (public),
BACKUP_S3_BUCKET, BACKUP_S3_ACCOUNT_ID, BACKUP_S3_REGION.
Secrets: BACKUP_DATABASE_URL, BACKUP_DATABASE_AUTH_TOKEN,
BACKUP_AWS_ACCESS_KEY_ID, BACKUP_AWS_SECRET_ACCESS_KEY, optional
BACKUP_AWS_SESSION_TOKEN, BACKUP_ALERT_WEBHOOK_URL.
Never configure legacy platform export credentials as a workaround for a scoped
export failure. Determine the supported read-only interface first.

The independent monitor needs only the storage config/read-only credentials,
BACKUP_SCOPE, BACKUP_ALERT_WEBHOOK_URL and optional BACKUP_MAX_AGE_HOURS (26 by
default, allowed 24–48). It never receives database credentials or a decrypting
key. Install the reviewed tools/source separately and run:

```sh
node scripts/monitor-backups.mjs
```

## 5. Success, retention and alert semantics

Daily schedule: 03:23 UTC; default branch only; manual workflow dispatch on that
branch; 20-minute job timeout; one concurrency group, no cancellation of an
in-progress backup. GitHub can delay/drop scheduled jobs and can disable inactive
public-repository schedules: the external monitor is mandatory.

Success requires schema validation, encryption, immutable S3 upload, downloaded
ciphertext checksum/size match, completion manifest uploaded/read-back verified,
and retention success. A green process or job-start heartbeat is insufficient.
A partial upload without a valid completion manifest cannot count as a backup.
The hourly monitor checks authenticated S3 HEAD metadata with ENABLED checksum
mode against the manifest: exact size, full-object SHA-256 and supported SSE-S3
encryption. Missing/composite/mismatched checksum metadata fails closed. It also
validates timestamps and reports retention violations. Uploads still download
and hash the entire ciphertext once before completion, and scheduled isolated
restore/integrity drills repeat full download/decryption. Metadata checks do not
replace those drills. SSE-KMS is not configured or granted extra decrypt rights
by this adapter; its use needs a separately approved design. The checksum is a transfer-integrity check, not a signature;
age authentication is verified during restore. An attacker controlling the
writer/storage can destroy or substitute files; separate key custody protects
confidentiality, not availability against that attacker.

Expiration uses UTC age strictly greater than 30*24 hours; the exact boundary is
retained. The current new backup must be verified before deleting old recovery
copies. Completion markers are deleted before old ciphertext so interrupted
cleanup cannot advertise missing payloads. Orphan ciphertext older than 30 days
is also removed. Deletion errors make the job fail. No automatic lifecycle rule
should silently erase the sole recovery point. If no recent valid recovery copy
exists, cleanup refuses and the monitor raises stale/retention alarms. This is an
incident requiring an owner decision; **no indefinite privacy exception is
approved**. Before activation approve a maximum bounded last-good extension (or
an explicit hard-deletion policy) with escalation/cleanup ownership. Review legal
retention, erasure requests and restored deleted users before any cutover.

Coordinate receiver/channel selection with MOD-102 and the external scheduler/
dead-man checks with MOD-113; both decisions remain open. Reuse that approved
setup when available without tying minimum backup alerts to unrelated telemetry.
The alert receiver is an owner-approved HTTPS endpoint accepting the safe JSON
contract in `backup-lib/alerts.mjs`; an arbitrary Slack/email webhook is not
assumed compatible. It must route to the approved audience, deduplicate by
service/scope/stage, close the scope's outstanding alerts on a recovery event,
repeat unresolved alerts at the agreed cadence, and escalate to the named
fallback after the agreed acknowledgement window. Defaults proposed for approval:
immediate failure/staleness alert, hourly repeat, escalation after 1 hour, daily
unresolved summary. Receiver delivery confirmation, not HTTP acceptance alone,
is the activation evidence. The client retries three times with 10-second request
timeouts and suppresses response bodies. Delivery failure is a nonzero exit and
requires the independent dead-man/fallback channel. Maintenance suppression must
be time-bounded, owner-approved and auto-expire; never fake a completion marker.

## 6. Isolated recovery procedure

1. Declare incident and record detection, last known write, candidate recovery
   points and decision owner. Do not delete/recreate production. Preserve safe
   incident evidence in a restricted record, not public issues.
2. Choose latest independently verified backup preceding corruption, or an
   approved native PITR point. Record expected lost interval and approve data
   exposure/region/cost for the isolated environment and operator.
3. Obtain the ciphertext and complete.json with separate read-only recovery
   access. Verify SHA-256/size and manifest scope. Retrieve the matching private
   key from approved independent custody; exercise emergency custody if primary
   retrieval is unavailable. Restore from a reviewed checkout matching the
   manifest schema version/hash, not today's unrelated schema.
4. Use a clean host with egress denied, no production network, no payment/email/
   Google/YouTube/OpenAI credentials, no live webhook endpoint, no cron/outbox
   scheduler and no app startup. Keep decrypted data off shared disks, terminals,
   shell history, logs, artifacts and backups. Memory-only verification:

   ```sh
   BACKUP_SCOPE='<approved-scope>' node scripts/verify-backup.mjs \
     '<downloaded-backup-directory>' '<private-identity-file>'
   ```

   This actually decrypts and imports into isolated in-memory SQLite and runs
   integrity/schema/migration checks. It never connects to production or starts
   Moderaty. Wrong key, corrupt payload, schema drift and incomplete dumps fail.
5. For an owner-approved full app drill, import into a **new disposable compatible
   database**, through a protected stream on the isolated host, using reviewed
   age/gzip/SQLite tooling. No existing target may be overwritten. Keep DB/token
   creation and any plaintext persistence under separate approval. Example for
   an offline, previously nonexistent file using a compatible engine with the
required STAT4/extension support (human operation; generic SQLite is not always
compatible):

   ```sh
   set -o pipefail
   age --decrypt --identity '<private-identity-file>' '<payload.sql.gz.age>' |
     gzip --decompress --stdout | sqlite3 '<new-isolated-file.sqlite>'
   ```

   A failed pipeline leaves an untrusted partial target: discard it through the
   approved cleanup process; never resume it or treat it as a restore.
6. Quarantine sessions, OAuth grants, encrypted organization API keys and payment
   identifiers before any app access. Network isolation is the primary barrier;
   DRY_RUN alone does not disable every payment/email/outbox path. Use test-only
   application keys and fixtures, disable cron/webhooks/invoicing/outboxes/auto
   top-up/moderation, and never run deploy scripts, migrations or tenancy probes
   against production. Validate expected schema, foreign keys, row invariants,
   ownership boundaries, login/dashboard/usage behavior and reconciliation below.
7. Measure export age and elapsed recovery time from incident declaration through
   isolation, key retrieval, download, validation, reconciliation and readiness.
   A milliseconds-long local fixture check is not a measured production RTO.
8. Record only safe commit/run/backup identifiers, sizes/checksums, stage timing,
   assertions and unresolved gaps in a restricted operator record. Approved
   cleanup must remove decrypted targets, temporary credentials, identities and
   copies according to retention policy; verify no background jobs or accounts
   remain active. Never include real records in a public issue or PR.

### Billing, replay and external-side-effect reconciliation

A database rollback does not roll back Stripe, Mercado Pago, Google, YouTube,
email or fiscal providers. Freeze all such writes until authoritative provider
state has been reconciled by an approved operator. Use test fixtures for drills;
provider writes, refunds and live replay require separate approval.

- Compare `credit_transactions` (delta, balance, reference/idempotency keys),
  organization balances/reservations and moderation usage with authoritative
  payment/fulfillment records. A purchase after the backup may be paid remotely
  but absent locally; a prior fulfilled event may be redelivered. Reconcile by
  stable provider transaction IDs, never by adding the visible amount again.
- Reconcile Stripe and Mercado Pago checkout attempts, paid/refunded/disputed
  purchases, pending reversals and refund observations. Include partial/multiple
  refunds and out-of-order deliveries. Verify duplicate event and business-level
  idempotency; event-ID dedupe alone is insufficient across different events
  describing the same payment. Compare existing ledger/checkout/webhook tests.
- Reconcile subscriptions, period start/end, invoices and entitlements/lifetime
  slots against Stripe before granting allowance or changing access. Preserve
  one grant per authoritative period/purchase; investigate rather than guess
  when the snapshot predates a change.
- Pause auto-top-up and invalidate in-flight assumptions. Reconcile payment
  intents, the recovery cursor, recovery/refund observations, saved-card consent,
  pauses and retry state before any new charge. Do not retry an old request with
  a new idempotency key, and do not assume provider idempotency retention lasts
  as long as the 30-day backup window.
- Reconcile webhook receipts/processing checkpoints and invoice/fiscal/outbox
  state. Do not bulk-mark events done or replay every event blindly. Document a
  bounded replay window, verify provider signatures using approved test/live
  environment separation, and check every side effect independently.
- Review Google revocation, Stripe deletion/scrub and fiscal/invoice outboxes.
  Restored deleted accounts must remain deleted; reapply approved erasure and
  revocation decisions before reopening the app. Do not resurrect revoked grants.
- Exercise duplicate purchase/credit, refund-after-snapshot, out-of-order webhook,
  in-flight top-up and subscription-change cases in fixtures. Existing billing
  regression tests cover these mechanisms; a real post-restore reconciliation
  rehearsal and owner sign-off are still required before operational readiness.

## 7. Native PITR and deleted-database recovery

Read-only inventory must establish actual timestamps, entitlement, primary region,
Allow restore/delete-protection settings and available quota. Documentation:
[PITR](https://docs.turso.tech/features/point-in-time-recovery) and
[deleted database recovery](https://docs.turso.tech/features/recover-deleted-databases).
PITR creates a new database and requires an approved connection/token setup;
never repoint production during a drill. A requested timestamp within a plan's
nominal window is not evidence that a usable recovery point exists.

For an approved disposable test database only, a human may create a distinct
restore target with `turso db create <new-isolated-target> --from-db <test-source>
--timestamp <approved-UTC-point>`, check contents/time and clean up the disposable
resources. Creating ongoing access or changing security settings needs its own
approval. Do not test deletion recovery by deleting production. Confirm the
paid-plan-at-deletion and regional prerequisites, the currently documented
five-day deleted-database window and actual operator permissions before relying
on that path. Keep independent encrypted recovery available if Turso or its
account is unavailable.

## 8. Controlled cutover, rollback and handover

Cutover is human-only and is never included in a drill. Agree a write freeze,
recovery-point/data-loss assessment, final external-state reconciliation,
connection/credential changes, application smoke tests and explicit approval.
Preserve the original database and rollback evidence. Freeze old writers, route
one validated target, observe reads/writes/queues and verify there are no dual
writers. If checks fail before new writes, the owner may approve reverting the
routing. After new writes, do not blindly switch backward: reconcile divergence
and approve forward recovery or a new freeze/replay plan. No automated production
replacement/deletion/cutover is implemented here.

Record named primary responder, recovery operator, key custodians and escalation
contact without assigning people implicitly. Proposed cadence for owner approval:
monthly isolated encrypted restore, quarterly PITR and emergency-key retrieval,
monthly alert/cost/retention check, quarterly least-privilege access review, and
immediate revalidation after schema/export/encryption/storage changes or incidents.
Token/key rotation follows provider expiry and the accepted incident policy;
retain decrypting capability for every retained backup. Keep this runbook and a
reviewed source/tool copy reachable independently of CI and production. Create
recurring operational tasks only after schedule/audience/action approval.

## 9. Verification and project completion

Run `npm run check`, `npm run build`, `npm test` and
`node scripts/rehearse-backup.mjs` with the pinned age binaries in PATH. The
rehearsal generates only ephemeral test identities, encrypts synthetic records
and the full empty application schema, verifies actual SQLite restoration,
rejects corrupt/wrong/missing keys, and proves an independent emergency key copy.
It deletes its temporary ciphertext/test identities afterward. It does not
exercise a real private bucket, live Turso scope, actual operator custody, native
PITR or notification receipt; those remain gated evidence.

Implementation and passing synthetic tests support review of MOD-244/246/247,
MOD-248/249/250 and the runbook MOD-251. Do not mark production acceptance,
security sign-off, ownership or the overall project complete from this evidence.
MOD-241/242/243/245/252/253/254/255/256/257 still require the live inventory,
owner/security decisions and/or authorized operational proofs listed above.
