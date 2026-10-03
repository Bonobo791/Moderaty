# Cron workload fairness

Feedback previews and live moderation share the existing bounded cron runner.
When both classes have eligible work, successful claims alternate between a
feedback preview and the least-recently-run live channel. The first contested
claim is a preview. An empty or leased class does not idle the runner: available
work runs while the absent class keeps its turn. Live timestamp ties use channel
ID for deterministic ordering; previews keep their existing oldest-pending order.

The shared turn is stored in `cron_workload_state`. Selection, channel lease,
preview first-attempt stamp, and turn advancement commit in one short database
transaction. Provider work runs after commit, outside the transaction. A failed
or rolled-back claim cannot advance the turn, while a worker crash or provider
failure after a committed claim cannot give previews the next contested turn
again. The existing ten-minute channel lease prevents overlapping work for that
channel and expires after a crash. Each invocation still runs only one claimed
workload under the original twenty-second deadline.

Preview attempts do not update live rotation or health fields. If a claim
finishes after the deadline, cron releases only its own lease and reports an
exhausted budget without starting provider work or recording false live health.
The committed turn remains advanced because resetting it could overwrite a newer
concurrent claim. Stale-preview cleanup errors are reported without blocking an
otherwise eligible workload; scheduler transaction errors fail loudly.

## Preview expiry and cadence

The checked-in Netlify schedule and Coolify instructions run every minute. The
optional fifteen-minute schedule mentioned in the operator guidance remains
supported. Alternation means a retry can be thirty minutes after the first
preview attempt on that slower cadence. Attempted previews therefore expire
strictly after **35 minutes**, replacing the former 20-minute window and keeping
a five-minute scheduling margin. The first-attempt timestamp stays fixed across
retries, so poison previews still age out. Unattempted queued previews do not
expire just because they waited. Paused/deleted channels and held leases retain
the existing cleanup behavior.

At one-minute cadence with both classes continuously ready, live moderation gets
one slot every two minutes. With N eligible live channels, their approximate
rotation is 2N minutes during that contention, versus N minutes when there are
no pending previews. Per-channel history/dry-run-window work keeps its existing
live rotation semantics.

## Migration and verification

Apply `0064_cron_workload_fairness.sql` before starting this code. It adds only a
constrained singleton scheduler table; the first claim initializes the preview
turn. No channel, preview history, or live health row is rewritten by migration.
The preceding migration remains `0063_welcome_campaign_pacing.sql`.

Regression coverage uses real SQLite transactions for alternating retries,
restarts, concurrent claims, lease expiry, zero-row claims, write rollback,
availability fallback, and stable ties. Route tests cover queued previews,
cleanup failures, shared-budget exhaustion, health isolation, protected stale
rows, and the 20/30/35-minute eligibility boundaries.
