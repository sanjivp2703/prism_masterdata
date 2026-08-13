#!/usr/bin/env bash
# Deploy (or update) the Prism app on a provisioned server.
# Run FROM the operator machine, at the repo root:
#   bash deploy/deploy.sh <server-ip-or-host>
#
# Syncs the working tree, installs deps, builds, and restarts the service.
# The production .env.local on the server is NEVER touched by this script —
# it is created once (see DEPLOY.md) and survives every deploy.
set -euo pipefail

SERVER="${1:?usage: deploy.sh <server-ip-or-host>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Type-check HERE, where there is RAM for it. The server build skips its own
# TypeScript pass (PRISM_SKIP_BUILD_TYPECHECK below) because the 2 GB droplet
# OOM-kills it; this local gate is what keeps that skip honest.
echo "==> Type-checking locally before deploy"
(cd "${REPO_ROOT}/stand-ui" && npx tsc --noEmit)

echo "==> Syncing code to root@${SERVER}"
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'stand-ui/.next' \
  --exclude 'stand-ui/data' \
  --exclude 'stand-ui/.env.local' \
  --exclude 'stand-ui/snowflake.log' \
  --exclude 'stand-ui/scripts/_tmp*' \
  --exclude 'rsa_key.p8' \
  --exclude 'rsa_key.pub' \
  --exclude 'Prism_E2E*' \
  --exclude 'ops07b_test_sheet.csv' \
  "${REPO_ROOT}/" "root@${SERVER}:/home/prism/app/"

echo "==> Installing deps + building (this is the slow part)"
ssh "root@${SERVER}" bash -s <<'REMOTE'
set -euo pipefail
chown -R prism:prism /home/prism/app
sudo -u prism bash -c '
  set -euo pipefail
  cd /home/prism/app/stand-ui
  npm ci
  # Skip the TypeScript pass here — the 2 GB droplet OOM-kills it, and
  # deploy.sh already ran tsc --noEmit on the operator machine as a gate.
  # (No apostrophes in these comments — this block runs inside single quotes.)
  PRISM_SKIP_BUILD_TYPECHECK=true NODE_OPTIONS=--max-old-space-size=1536 npm run build
'
systemctl restart prism
sleep 3
systemctl --no-pager --lines=5 status prism
REMOTE

echo "==> Deployed. Check https://$(ssh "root@${SERVER}" "grep -m1 -oE '^[^ {]+' /etc/caddy/Caddyfile" 2>/dev/null || echo "${SERVER}")"
