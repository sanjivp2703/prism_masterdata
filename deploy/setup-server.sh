#!/usr/bin/env bash
# One-time server provisioning for a Prism instance.
# Run ON the droplet as root:  bash setup-server.sh <domain>
# Idempotent — safe to re-run.
set -euo pipefail

DOMAIN="${1:?usage: setup-server.sh <domain>   e.g. setup-server.sh prismmasterdata.com}"

echo "==> Provisioning Prism server for ${DOMAIN}"

# ---------------------------------------------------------------- packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
# build-essential + python3 are required to compile better-sqlite3's native module
apt-get install -y curl git rsync ufw build-essential python3 ca-certificates gnupg

# ---------------------------------------------------------------- swap (2 GB)
# The Next.js production build can exceed 2 GB RSS on a 2 GB droplet; swap
# turns an OOM-kill into a slightly slower build.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- Node 22
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

# ---------------------------------------------------------------- Caddy (auto-HTTPS)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	reverse_proxy 127.0.0.1:8000
}

www.${DOMAIN} {
	redir https://${DOMAIN}{uri} permanent
}
CADDY
systemctl enable --now caddy
systemctl reload caddy

# ---------------------------------------------------------------- firewall
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ---------------------------------------------------------------- app user + service
id -u prism &>/dev/null || useradd --create-home --shell /bin/bash prism
mkdir -p /home/prism/app
chown -R prism:prism /home/prism/app

cat > /etc/systemd/system/prism.service <<'UNIT'
[Unit]
Description=Prism data standardization platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=prism
WorkingDirectory=/home/prism/app/stand-ui
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
# One long-lived process is REQUIRED (in-process poller + SSE) — never scale
# this to multiple instances.

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable prism

# ---------------------------------------------------------------- daily SQLite backup
mkdir -p /home/prism/backups
chown prism:prism /home/prism/backups
cat > /etc/cron.daily/prism-backup <<'CRON'
#!/bin/sh
# Keep 14 daily copies of the app-state database (metadata only — customer
# values live in the customer's warehouse).
DB=/home/prism/app/stand-ui/data/prism.db
[ -f "$DB" ] || exit 0
cp "$DB" "/home/prism/backups/prism-$(date +%F).db"
ls -1t /home/prism/backups/prism-*.db | tail -n +15 | xargs -r rm --
CRON
chmod +x /etc/cron.daily/prism-backup

echo "==> Server provisioned. Next: run deploy.sh from the operator machine."
