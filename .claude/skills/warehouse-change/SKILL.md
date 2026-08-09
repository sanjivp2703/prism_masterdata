---
name: warehouse-change
description: Checklist for any change that touches the warehouse layer — SQL text, change detection, exports, grants, normalization, or connection handling. Invoke BEFORE implementing such a change so every warehouse implementation, the parity matrix, and the parity tests move together.
---

# Warehouse-layer change checklist

Prism supports one warehouse per installation (Snowflake today; SQL Server
from Phase 3 of `docs/MSSQL_PORT_PLAN.md`). All warehouse work goes through
the adapter in `stand-ui/app/api/_lib/warehouse/`. This checklist keeps the
implementations, docs, and tests in lockstep.

## 1. Is this actually a warehouse-layer change?

It is if it touches ANY of: SQL text or bind parameters · change detection
(streams / Change Tracking / diff scans) · export table/view builds · grants
or install scripts · normalization (`normalizeLiteral` / `PRISM_NORMALIZE`) ·
connection or credential handling · error classification.

If none apply (pure UI, SQLite app-state, LLM prompts), stop here — this
checklist doesn't apply.

## 2. Route it correctly

- Consumers (routes, poller, tick processor) import ONLY from
  `@/app/api/_lib/warehouse` (the facade). Never import `snowflake-sdk` or
  `mssql` outside `warehouse/` — lint enforces this.
- Never write a local `exec()` helper — use the facade's `executeQuery`.
- New warehouse-specific behavior goes in the adapter implementation
  (`warehouse/snowflake/…`, later `warehouse/mssql/…`), exposed through
  `warehouse/types.ts` if consumers need it.
- Snowflake-specific setup surfaces (test-snowflake / workspace-snowflake /
  snowflake-config / verify-install routes, `grants.ts`) may import
  `warehouse/snowflake/connection` directly until Phase 6.

## 3. Implement for EVERY warehouse

While only the Snowflake adapter exists, note in the PR/summary what the
mssql implementation will need (or add the row to the plan). Once
`warehouse/mssql/` exists: implementing for one warehouse and not the other
is an incomplete change — the interface method must work (or explicitly
throw a documented "unsupported") for every adapter before it ships.

Check the quirks for the warehouse you're NOT thinking about in
`docs/WAREHOUSES.md` — bind-parameter ceilings, collation, quoting, cost
model, version floors.

## 4. Update the paper trail (same PR)

- [ ] `docs/WAREHOUSES.md` — update the affected matrix rows.
- [ ] `CLAUDE.md` — if behavior/limits/invariants changed.
- [ ] If normalization changed: update BOTH `normalizeLiteral` and the
      `PRISM_NORMALIZE` UDF in `01_internal_tables.sql`, plan a backfill of
      `LITERAL_ALIAS_MATCHES.normalized_value`, and extend the corpus in
      `scripts/parity-tests.ts`.

## 5. Verify

- [ ] `npm run test:parity` — must pass; extend it if you added pure logic
      (SQL text generation, quoting, parsing).
- [ ] `npx tsc --noEmit` and `npm run build`.
- [ ] Remind the user: poller/background changes need a full dev-server
      restart (hot reload does not replace the running poller).
- [ ] Anything untestable without a live warehouse (real stream/CT behavior,
      grants) — say so explicitly in the summary; never imply it was tested.
