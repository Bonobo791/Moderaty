#!/bin/sh
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher
#
# Licensed under the PolyForm Shield License 1.0.0; you may not use
# this file except in compliance with the License. You may obtain a
# copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
#
# The software is provided "as is", without warranty or condition of
# any kind, express or implied. See the License for the specific
# language governing permissions and limitations under the License.
# A copy of the License is included in the LICENSE file at the
# repository root.
#
# Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
#
# OPTIONAL in-container purge entrypoint (Coolify/Docker) — see
# docs/COOLIFY_BUNNY.md §3.5 ("Alternative purge trigger"). The repo default
# purges OUTSIDE the container via .github/workflows/bunny-purge.yml (a
# zone-scoped key never ships in the image); use this entrypoint only for an
# operator who cannot run that workflow and explicitly opts in.
#
# 1. Start the real server command (CMD) in the background.
# 2. Wait until it serves the site locally (the same probe the HEALTHCHECK
#    uses, so "serving" here means the same readiness Traefik gates on).
# 3. Purge the Bunny pull-zone cache when credentials are configured — only
#    AFTER the new container passed the readiness probe. Purging first (the
#    old behavior) let requests routed to the still-healthy old container
#    repopulate the cache with the previous release before traffic switched
#    over, and purging after a failed probe would clear the edge cache
#    without a serving container to refill it. Purge failures are non-fatal
#    (stale edge cache heals on its own; the site must still start). No
#    credentials configured = no purge; nothing ships in the image.
# 4. Foreground the server and forward termination signals to it.
set -e

PORT="${PORT:-3000}"

"$@" &
server_pid=$!

trap 'kill "$server_pid" 2>/dev/null || true' TERM INT

ready=0
i=0
while [ "$i" -lt 60 ]; do
	if node -e "fetch('http://127.0.0.1:${PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
		ready=1
		break
	fi
	i=$((i + 1))
	sleep 1
done

if [ "$ready" -eq 0 ]; then
	echo '[entrypoint] WARN: server not ready after 60s; skipping cache purge' >&2
fi

if [ "$ready" -eq 1 ] && [ -n "${BUNNY_API_KEY:-}" ] && [ -n "${BUNNY_PULL_ZONE_ID:-}" ]; then
	node /app/scripts/bunny/purge-bunny-cache.mjs || echo '[bunny-purge] WARN: purge failed; continuing'
fi

wait "$server_pid"
