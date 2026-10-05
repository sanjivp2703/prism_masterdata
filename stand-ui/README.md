# Prism web application

This folder is the Prism application itself: a Next.js app that serves the
review UI, the API routes, and the background poller that keeps pipelines in
sync. (The folder name `stand-ui` is historical — the product was called
"STAND" before it became Prism.)

For what Prism is and how it works, start with the [root README](../README.md).

## Quick start

```bash
npm install
cp .env.local.example .env.local   # then fill in the "Required" block
npm run dev                        # http://localhost:8000
```

Sign in with the `ADMIN_EMAIL` Google account and follow the `/setup` wizard,
which connects the warehouse and the AI provider.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server on port 8000 |
| `npm run build` / `npm start` | Production build / serve |
| `npx tsc --noEmit` | Typecheck the application |
| `npm run typecheck:scripts` | Typecheck the maintained scripts in `scripts/` |
| `npm run test:parity` | Pure-logic parity tests (no database needed) |
| `npm run lint` | ESLint |
| `npm run reset-app-state` | Empty the local app-state tables (dev only) |
| `npm run test:<mssql\|pg\|mysql>-<live\|detection\|lifecycle\|setup>` | Live suites against a local dev container — see `../docs/DEV_*.md` |

## Layout

```
app/
  api/            API routes
    _lib/         Server-side library: warehouse adapters, poller, grouping, export
  components/     Shared UI components
  home/           Pipelines dashboard
  run/[run_id]/   Human review screen
  one-time/       One-time standardization flow
  setup/          Setup wizard
  settings/       Workspace settings
scripts/          Parity tests, live warehouse suites, install runners
instrumentation.ts  Starts the background poller and standardization tick
```

A module-by-module map of `app/api/_lib/` is in [`../CLAUDE.md`](../CLAUDE.md).
