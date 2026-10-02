# Turso-native backups and recovery

## Scope and current evidence

Moderaty uses Turso-managed backups and native point-in-time recovery (PITR).
Turso automatically captures committed changes; there is no Moderaty backup cron,
export pipeline, storage account, encryption-key setup or artifact retention job.
The previous dump/artifact workflow and custom backup tools are retired in this
branch. That retirement reaches the deployed/default branch only after the human
merges the change. Repository CI is code validation, not a backup-success signal.

The current organization plan, usable recovery points, operator permissions and
live restore have **not been verified**. Do not declare recovery ready from this
document or a passing build. This design relies on Turso and access to its account;
a provider/account outage or an expired recovery window can prevent recovery.

## 1. Verify the native recovery window

Public Turso documentation checked on 2026-10-02:

| Plan | PITR window | Deleted-database recovery |
| --- | --- | --- |
| Free | 24 hours | Unavailable |
| Developer | 10 days | Up to 5 days, subject to prerequisites |

Backups occur at `COMMIT`; no custom backup schedule needs activation. PITR creates
another database, not an in-place rollback. Recovery targets consume database
quota and require approved connection/access setup. A plan's nominal window does
not prove that a particular requested timestamp is available. See
[Turso PITR](https://docs.turso.tech/features/point-in-time-recovery).

Keep the current plan if its confirmed window meets the owner's needs. If Free's
24 hours is too short, Developer is the lowest listed paid tier: **US$5.99/month
billed monthly**, or $59.88 prepaid yearly ($4.99/month equivalent). Usage, taxes
and checkout terms may add cost; check the actual account first. No upgrade or
purchase is approved by this runbook. Sources: [pricing](https://turso.tech/pricing)
and [published price table](https://turso.tech/pricing.md).

Record these in a restricted operator record, never a public issue:

- Correct organization, database, group, region, actual plan and account owner.
- Current usable recovery range, available target quota, database size and CLI
  version. Use the dashboard and existing authorized access; `turso plan show`
  reports the current plan ([reference](https://docs.turso.tech/cli/plan/show)).
- Who can perform recovery and how the operator can access the account during an
  incident. Confirm secure availability of the application's existing encryption
  keys/configuration; a database restore alone cannot decrypt stored app secrets.
- Current delete protection and, if applicable, organization **Allow restore**
  setting. Changing permissions, credentials or security settings requires
  separate approval. Do not make those changes merely to fill this checklist.
- Accepted recovery window, maximum acceptable data loss (RPO), recovery-time
  target (RTO), primary responder and escalation contact. Retention is not RPO;
  measure recoverable commits and incident response rather than promising zero
  loss. A four-hour RTO is a proposal until an actual timed drill establishes it.

## 2. Human-approved isolated PITR drill

Start with a disposable source containing only synthetic data. A later drill
using real data needs explicit approval for its source, target, region, access,
cost and cleanup. Creating a target or granting credentials is not authorized by
reading this procedure. Never test by corrupting or deleting production.

1. Confirm the source identity, plan window, quota and approved target isolation.
   Record incident/drill start time and the schema/application revision. For a
   synthetic test, commit a known fixture, choose and record a UTC timestamp after
   that commit, then commit a distinguishable later change. The expected restored
   state must contain the first fixture and exclude the later change.
2. A human uses the installed official CLI to create a **new, unused** target.
   Confirm supported arguments with `turso db create --help`. Example only:

   ```sh
   turso db create '<new-isolated-target>' \
     --from-db '<approved-source>' --timestamp '<approved-RFC3339-UTC-point>'
   ```

   Select the approved group/region as supported by the account and CLI. See the
   [official create reference](https://docs.turso.tech/cli/db/create). Stop if the
   timestamp is unavailable; never silently substitute the current database.
3. Verify the returned target identity and timestamp. Keep it disconnected from
   production deployments, cron, webhooks, outboxes and payment/moderation jobs.
   Use approved target-only access, not production application credentials. Do
   not start the app or run deployment migrations automatically.
4. Check `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, expected tables,
   constraints, row invariants and the fixture boundary. Match the migration
   history to the source revision at the recovery point. The existing read-only
   `scripts/verify-migrations.mjs` can check that revision with an explicitly
   isolated target configuration. Do not load a production `.env`. A mismatch
   requires investigation, not immediate migration. Keep outputs restricted.
5. Before app smoke tests, quarantine restored sessions, OAuth grants, saved
   payment references and organization secrets. Use synthetic/test keys and a
   deny-by-default egress policy that permits only the approved recovery target.
   Disable cron, webhook ingestion, billing, auto-top-up, email and moderation.
   `DRY_RUN` alone does not disable every external side effect. Existing tenancy
   probes perform writes and may print records; use only a separately approved
   isolated target and restricted logs.
6. Exercise login, dashboard, ownership boundaries, usage and the reconciliation
   cases below with test fixtures. Measure elapsed time through access, restore,
   validation and reconciliation readiness. Record actual recovered point and
   lost interval; a successful create command alone is not recovery evidence.
7. Record safe pass/fail assertions, timestamps, revision and operator sign-off.
   Keep real records, SQL, URLs containing credentials and tokens out of issues,
   terminals captured by CI and public logs. Clean up disposable resources and
   access only through the approved process; deletion needs its own confirmation.

## 3. Billing and external-state reconciliation

Restoring the database does not rewind payment providers, YouTube, Google, email
or fiscal services. Freeze external writes until an approved operator reconciles
provider state. Use synthetic cases for drills; live replay, refunds and charges
require separate approval.

- Compare credit balances, reservations and `credit_transactions` with stable
  provider transaction IDs. A payment after the recovery point can exist remotely
  but be missing locally. Prevent duplicate grants across different event IDs.
- Reconcile paid, refunded, partially refunded and disputed purchases, checkout
  attempts and out-of-order webhooks. Confirm subscriptions, period boundaries,
  invoices, entitlements and lifetime slots before changing access or credits.
- Pause auto-top-up. Reconcile payment intents, saved-card consent, recovery
  cursors, pauses and retry/refund observations. Do not resubmit old charges with
  new idempotency keys or assume provider deduplication covers the PITR window.
- Reconcile webhook checkpoints, invoice/fiscal/email outboxes and pending
  moderation actions. Approve a bounded replay plan; never blindly replay all
  events or mark all events complete.
- Reapply post-recovery-point erasure and revocation decisions before reopening
  the app. Do not resurrect deleted accounts, revoked grants or scrubbed data.
- Test duplicate purchase/credit, refund-after-restore-point, in-flight top-up,
  subscription change and out-of-order delivery. Existing billing tests validate
  mechanisms; they do not prove a real post-restore reconciliation succeeded.

## 4. Deleted-database recovery is a separate path

Paid-plan recovery can restore eligible deleted databases for up to five days.
The organization must have been paid **when deletion occurred**, the operator
must be an admin/owner, Allow restore must be enabled, and the region must support
recovery. A deleted listing alone is not proof of recoverability; upgrading after
a Free-plan deletion does not establish eligibility.

For an approved disposable test only, use the dashboard's Restore page and verify
the exact database UUID, contents and target identity. Recovery returns the state
at deletion; it is distinct from choosing an earlier PITR point. A reused name can
require a different target name. Do not delete production to test this or toggle
security settings without approval. Follow the current
[deleted recovery instructions](https://docs.turso.tech/features/recover-deleted-databases).

## 5. Production cutover and operational handover

Production cutover is human-only, separate from the drill. Approve the recovery
point and expected loss, freeze old writers, finish external-state reconciliation,
validate one target, and approve connection/access changes before routing traffic.
Preserve the original database and rollback evidence. Verify no dual writers. If
checks fail before new writes, the owner can approve reverting routing. After new
writes, reconcile divergence before any rollback; do not blindly switch back.

Before marking operational acceptance complete:

- Confirm entitlement, a usable recovery point and accepted provider/account
  dependency; record the decision if the existing plan's window is sufficient.
- Approve operator access, security review and the isolated native drill; obtain
  a measured restore/reconciliation result against the agreed RPO/RTO.
- Name the responder/escalation contacts and keep this runbook reachable during
  an outage. Use existing incident monitoring; no custom backup-freshness monitor
  is needed. Escalate inaccessible recovery, shrinking/unavailable windows, plan
  changes or failed drills to the owner.
- Approve a proportionate drill/access review cadence (quarterly proposed) and
  revalidate after material schema, account, plan or recovery changes. Reconfirm
  the native window before high-risk changes rather than relying on old evidence.

No production database, account setting, credential or plan was changed to create
this runbook. `npm run check`, `npm run build` and `npm test` validate the repository
only. The native account checks and live drill remain open until a human provides
or authorizes their evidence.
