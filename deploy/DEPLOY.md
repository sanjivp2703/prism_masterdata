# Deploying a Prism instance

One instance = one VPS (Ubuntu 24.04, ≥2 GB RAM) + one domain. The app is a
single long-lived Node process on port 8000 behind Caddy (automatic HTTPS).
Serverless / multi-instance deployments are unsupported (in-process poller,
SSE broadcaster, pipeline locks).

## First-time setup

1. **Droplet**: Ubuntu 24.04, ≥2 GB RAM, your SSH key added.
2. **DNS**: A record `@` → droplet IP (plus optional `www`). Wait for it to
   resolve before running setup — Caddy needs it to obtain the TLS cert.
3. **Provision** (from the repo root):
   ```bash
   scp deploy/setup-server.sh root@<ip>:/root/
   ssh root@<ip> bash /root/setup-server.sh <domain>
   ```
4. **Production env** — create `/home/prism/app/stand-ui/.env.local` on the
   server (owner `prism`, mode 600). Minimum viable set:
   ```bash
   SESSION_SECRET=        # openssl rand -hex 32
   PRISM_ENCRYPTION_KEY=  # openssl rand -hex 32  ← STORE IN PASSWORD MANAGER
   ADMIN_EMAIL=           # the workspace admin's Google email
   APP_URL=https://<domain>
   GOOGLE_CLIENT_ID=      # from the Google Cloud OAuth client
   GOOGLE_CLIENT_SECRET=
   GOOGLE_REDIRECT_URI=https://<domain>/api/auth/google/callback
   ```
   Snowflake/SQL Server credentials and the AI key are configured through the
   in-app `/setup` wizard after first login — no env entries needed.
   NEVER set `PRISM_DEBUG_TOOLS`, `PRISM_DEBUG_ARTIFACTS`, or
   `PRISM_FRESH_SETUP` on a real instance.
5. **Deploy the code**:
   ```bash
   bash deploy/deploy.sh <ip>
   ```
6. Visit `https://<domain>`, sign in with the `ADMIN_EMAIL` Google account,
   and walk the setup wizard.

## Updating a running instance

```bash
bash deploy/deploy.sh <ip>
```

That's it: rsync → `npm ci` → build → `systemctl restart prism`. SQLite
migrations apply themselves on boot. Restart downtime is a few seconds; the
warehouse-side queue is persistent, so nothing is lost. (Warehouse-side schema
changes are NOT automated yet — see CLAUDE.md → Deferred items before shipping
a release that alters warehouse tables.)

## Operations

- Logs: `ssh root@<ip> journalctl -u prism -f`
- Restart: `ssh root@<ip> systemctl restart prism`
- Backups: `/etc/cron.daily/prism-backup` keeps 14 daily copies of the SQLite
  file in `/home/prism/backups/` (metadata only — customer values live in the
  customer's warehouse).
- The per-installation secrets (`PRISM_ENCRYPTION_KEY`, `SESSION_SECRET`,
  service-user private key) belong in the operator's password manager, one
  set per client, never reused.
