# Pre-launch checklist

Verifications that MUST be completed against a live warehouse before Prism is
deployed to any customer. Each item stays open until someone has actually run
it and recorded the result here (date + who + outcome).

## 1. Column output mode — source-table integrity (MANDATORY)

Column mode (`export_kind = 'column'`) is the only feature that writes to the
customer's own tables. Its promise is: **Prism adds and maintains
`<col>_STANDARDIZED` companion columns and never modifies any other column or
any existing data.** The guardrails enforcing this are
`assertCompanionColumnSafe` (`_lib/export-kind.ts` — every write target must be
a companion of a watched column, checked before any SQL runs),
`assertCompanionColumnAvailable` / `CompanionColumnConflictError`
(`_lib/export-table.ts` — refuse creation when the companion name already
exists, since Prism can't distinguish its own column from customer data), and
the source==destination refusal in both table-mode builders.

**Before shipping, explicitly test on a live warehouse (both Snowflake and SQL
Server if the install supports both):**

1. **Byte-identity of existing data.** Create a test table with several
   columns and a few hundred rows, including NULLs, duplicates, unicode, and a
   PK. Snapshot it (`CREATE TABLE …_BACKUP AS SELECT *`). Run a column-mode
   pipeline end to end: baseline review → activate → new inserts → updates →
   deletes → a mapping rename → several sync cycles. Then verify every
   original column is untouched:
   ```sql
   -- must return 0 rows in BOTH directions (ignore the *_STANDARDIZED column)
   SELECT <original cols> FROM SRC
   EXCEPT SELECT <original cols> FROM SRC_BACKUP;
   SELECT <original cols> FROM SRC_BACKUP
   EXCEPT SELECT <original cols> FROM SRC;
   -- and row counts match
   ```
2. **Companion behavior.** Confirm the companion column is NULL for unmapped
   values, updates when a mapping changes, and NULLs out when a mapping is
   removed / a raw value is updated to an unmapped one.
3. **Pre-existing-column refusal.** Add a column named `<col>_STANDARDIZED`
   to a fresh table yourself, then try to create a column-mode pipeline on
   `<col>` — creation must fail with the CompanionColumnConflictError message
   and must not write anything.
4. **Privilege failure paths.** Revoke UPDATE mid-flight — the pipeline must
   pause/flag with the exact GRANT SQL, and the source table must be unchanged.
5. **Consent + per-table grant scope.** (a) A POST with `export_kind='column'`
   and no `column_write_consent: true` must 400 — verify the connect form
   cannot submit without the checkbox. (b) After onboarding Part D alone, the
   service role must NOT be able to UPDATE any source table (default-deny —
   this is the "no blanket write access" promise). (c) Creating a column-mode
   pipeline with the creator's personal credentials saved must add the
   companion column AND grant UPDATE on exactly that one table (verify with
   `SHOW GRANTS ON TABLE` + `SHOW COLUMNS`); with no personal credentials, the
   pipeline must be flagged with the exact single-table ALTER+GRANT SQL and
   the first sync must fail without touching the table. (d) Verify the grant
   does NOT leak to other tables in the schema.
6. **Stream echo settles.** After a sync, verify the next poll re-detects
   Prism's own writes once, the following tick makes zero LLM calls, and the
   sync after that updates 0 rows (no churn loop; watch `PRISM_WH` stays
   suspended on quiet cycles afterwards).
7. **Guardrail trip test.** Temporarily corrupt a write target in a dev build
   (e.g. hand `standardizedColumnName` a watched raw column) and confirm
   `assertCompanionColumnSafe` throws BEFORE any SQL executes.

Status: **CLOSED 2026-08-08 — ALL SEVEN SUB-ITEMS PASS ON BOTH WAREHOUSES.**
Both defects found were fixed and re-tested green, and both warehouses were
exercised at genuine least privilege (Snowflake via an operator-created
`PRELAUNCH_OWNER` role; SQL Server via a purpose-built `prelaunch_lowpriv`
login owning nothing). Checklist §2 (RBAC default-deny) closed in the same
pass.

| # | Sub-item | Result |
|---|---|---|
| 1 | Byte-identity of existing data | **PASS** — both warehouses |
| 2 | Companion behavior | **PASS** (covered by OUT-07's 12/12 live matrix) |
| 3 | Pre-existing-column refusal | **PASS** — both warehouses, case-insensitive |
| 4 | Privilege failure paths | **PASS** — both warehouses, at genuine least privilege |
| 5 | Consent + per-table grant scope | **PASS** — both warehouses; default-deny enforced (see §2); grant does not leak to siblings |
| 6 | Stream echo settles | **PASS** — Snowflake (mssql uses Change Tracking; not separately exercised) |
| 7 | Guardrail trip test | **PASS** |

**Sub-item 1 (the headline promise) held.** Snowflake: a 320-row, 7-column
fixture with NULLs, duplicates, unicode (中国移动, NTT ドコモ, Télécom Orange),
quotes/tabs/newlines/emoji and a PK ran a full lifecycle — baseline, activate,
inserts, updates, deletes, mapping rename, mapping delete, repeated syncs. The
bidirectional `EXCEPT` over the original columns returned **0 and 0 at all six
checkpoints**, with matching row counts and identical `HASH_AGG`. Because
Snowflake's `EXCEPT` is set-based and collapses duplicates, a multiplicity-aware
`GROUP BY` variant was run at every checkpoint too. SQL Server matched, and
confirmed the OUT-14 fix live (a 520-character mapped literal now survives the
staging table).

**Two defects found, both fixed 2026-08-07, both needing a re-test:**

1. *Snowflake privilege failures never reached the user.* The builder caught the
   warehouse error and rethrew a NEW `Error` carrying curated fix text, whose
   message matched none of `isSnowflakeAccessError`'s patterns — so the rethrow
   silently de-classified the failure, `withColumnModeFailureSurfaced` never
   paused the pipeline, and the card kept showing a healthy pipeline while the
   companion column went stale forever. Observed live: `status='active'`,
   `status_message` NULL after a denied ALTER/UPDATE. It worked on SQL Server
   only because that builder rethrows the raw driver error. Fixed with a typed
   `ColumnModeAccessError` (classification travels by type and `cause`, never by
   matching text across a rethrow) and pinned by a parity test — including a
   guard against the test passing vacuously.
2. *The consent gate could be bypassed.* `PATCH /api/pipelines/[id]` accepted an
   `export_kind` transition into `'column'` with no consent flag, no
   companion-conflict guard and no per-table provisioning — all three of which
   `POST` enforces. Live-proven: a table pipeline was PATCHed to column mode
   having never sent `column_write_consent`, and Prism then ran
   `ALTER TABLE … ADD COLUMN` on the source. Existing data survived (the
   "never modify another column" promise held; the *consent* promise did not).
   API-only — no UI path sends `export_kind` on PATCH — but the route is
   `requireValidSession`, so any authenticated user could do it. Now refused
   with `column_mode_requires_creation`; switching *away* from column mode is
   still allowed.

**What is still NOT TESTED, and why it matters:**

- ~~**§5(b) default-deny on Snowflake.**~~ **CLOSED 2026-08-08 — ENFORCED.**
  Unblocked by having an operator create the `PRELAUNCH_OWNER` role and fixtures
  outside `PRISM_SERVICE`'s hierarchy (`docs/prelaunch-rbac-fixture.sql`). See
  §2 for the full result. This also removes the "contained only by default-deny"
  caveat on the consent-bypass fix — that backstop is now verified, not assumed.
- ~~**§4 on Snowflake**~~ **CLOSED 2026-08-08 — PASS (17/17).** Re-run against
  `TEST_DB.PUBLIC.PRELAUNCH_RBAC_SRC`, owned by `PRELAUNCH_OWNER` with Prism
  holding only SELECT+UPDATE — the realistic customer shape, which makes a
  `REVOKE` actually bite. Operator ran the revoke and re-grant by hand.

  With UPDATE revoked (9/9): the sync **failed loudly** instead of reporting
  success; the pipeline went to **`paused`** with `status_reason =
  'column_mode_access'`; the message carried the exact copy-pasteable fix
  (`GRANT UPDATE ON TABLE … TO ROLE PRISM_SERVICE; ALTER TABLE … ADD COLUMN IF
  NOT EXISTS "CARRIER_STANDARDIZED" VARCHAR;`); the source table stayed
  byte-identical (`EXCEPT` 0/0, 5 rows vs 5); and the 4 previously-written
  companion values **survived** — a privilege failure degrades cleanly rather
  than destroying prior work.

  After re-granting (8/8): the sync succeeded, a deliberately changed mapping
  (`Verizon` → `Verizon Wireless`) propagated to exactly the 2 affected rows,
  `AT&T` rows were untouched, the NULL-carrier row kept a NULL companion, the
  pause flag cleared, and the originals were **still** byte-identical. The
  mapping change matters: the guarded UPDATEs touch 0 rows in steady state, so
  a no-op sync would have "passed" without proving anything.

  **This sub-item FAILED on 2026-08-07 and passes now because of the
  `ColumnModeAccessError` fix.** Before it, this exact scenario left the
  pipeline showing `active` with `status_message` NULL while the companion
  column silently went stale forever.
**SQL Server least privilege — CLOSED 2026-08-08, PASS (11/11).** The earlier
mssql leg ran as `sa` (sysadmin, owns everything), so privilege failures and
grant scope were never really exercised. Re-run against a purpose-built fixture:
`prelaunch_owner` owning the schema and tables, and `prelaunch_lowpriv` — what
Prism connected as — **owning nothing** and holding only what a real install
grants (broad on Prism's own `PRISM_DB.INTERNAL`, narrow on customer data:
`SELECT`+`UPDATE` on exactly one table).

- Column mode works at least privilege — no ownership needed, 3/3 companion
  values written.
- §1.5(d) grant scope: the consented table is readable and writable; a **sibling
  table in the same schema is neither**. The grant does not leak.
- §1.4: revoking `UPDATE` produced a loud failure, `status='paused'`,
  `status_reason='column_mode_access'`, the exact `GRANT UPDATE ON OBJECT::…`
  fix SQL, and the source table **unchanged**.

*Methodology note worth keeping.* The first attempt failed on `CREATE TABLE
permission denied` and nearly became a false bug report ("column mode's consent
SQL never grants CREATE TABLE"). The install script grants exactly that
(`01_internal_tables.mssql.sql:180-183`, commented "staging tables") — the
column-mode sync builds its staging table in `PRISM_DB.INTERNAL`, Prism's own
schema. The fixture was under-privileged, not the product. An under-privileged
fixture also makes §1.4 pass for the wrong reason: the pause fires on the wrong
error. Always confirm the *specific* denial the test intends.

**Known limitation, by design, worth telling customers:** the consent-time grant
is table-wide `UPDATE`, not column-scoped — proven live on SQL Server, where the
service session was permitted to overwrite an unrelated column. The "never
modify another column" promise therefore rests on application code
(`assertCompanionColumnSafe` + the guarded UPDATEs), with no warehouse-level
backstop. SQL Server *could* be narrowed to `GRANT UPDATE ON OBJECT::<table>(<col>_STANDARDIZED)`;
Snowflake has no column-level UPDATE grant, so code is the only control there.

The user-facing disclaimer (Column option in the connect form) states the intent
and the no-liability position; this test is what makes the intent credible.

## 1b. Environment hygiene — operator-only flags (MANDATORY, 2 minutes)

Three env flags are for operators only and must be **absent or `false`** in any
customer installation. Each weakens or fakes something the customer relies on:

| Flag | What it does if left on |
|---|---|
| `PRISM_DEBUG_TOOLS` | Exposes `/debug` and `/api/admin/table/*` (raw table contents) to any session holder, **and** makes `verify-install` return raw driver text to the browser instead of the sanitized message |
| `PRISM_FRESH_SETUP` | Makes `/setup`, the `/home` gate, `verify-install` and both status GETs falsely report that no credentials exist |
| `PRISM_DEBUG_ARTIFACTS` | Writes LLM breakdown and validation-audit JSON — which contain customer values — to the OS temp dir |

**Check before every customer deploy:**

```bash
grep -nE '^(PRISM_DEBUG_TOOLS|PRISM_FRESH_SETUP|PRISM_DEBUG_ARTIFACTS)=true' stand-ui/.env.local
# expect: no output
```

The server also warns loudly at boot when any of these is `true`, and says
"PRODUCTION" in the banner when `NODE_ENV=production` (`instrumentation.ts`).
It warns rather than refusing to start, because the same file is used for local
development where these flags are legitimate — a process that refused to boot
would simply get the guard deleted.

Status: **the boot warning shipped 2026-08-08.** This item stays open per
install: it is a deploy-time check, not something the codebase can settle.
Two of these flags survived in the operator's local `.env.local` across three
separate QA passes (SEC-08), which is why it is a checklist item at all.

## 2. Snowflake RBAC default-deny verification — **CLOSED 2026-08-08: ENFORCED**

Verified live against `TEST_DB.PRELAUNCH_NOGRANT`, a schema `PRISM_SERVICE` was
never granted anything on, probing as the real service identity
(`PRISM_SVC` / role `PRISM_SERVICE`):

| Probe | Result |
|---|---|
| `SELECT` the secret column | DENIED |
| `UPDATE` the table | DENIED |
| `SELECT COUNT(*)` | DENIED |
| `SHOW COLUMNS` (metadata) | DENIED |
| `SHOW SCHEMAS LIKE …` | 0 rows — the schema is not even visible |
| **Control:** `SELECT` a table Prism IS granted | ALLOWED (5 rows) |

The control is what makes this meaningful: the probe was capable of succeeding
and did not. **4/4 denied. Default-deny is enforced on this account.**

**The earlier "default-deny failure" was a misdiagnosis, and the real cause is
worth knowing.** During this run Prism *could* read an ungranted table in
`TEST_DB.PUBLIC` — but `UPDATE` on the same table was refused. That asymmetry
led to the actual explanation:

```
SHOW FUTURE GRANTS IN SCHEMA TEST_DB.PUBLIC
  -> SELECT on TABLE -> PRISM_SERVICE
SHOW GRANTS ON TABLE …PRELAUNCH_RBAC_DENY
  -> SELECT -> PRISM_SERVICE (granted by PRELAUNCH_OWNER)
```

A standing **future grant** meant the table was granted to `PRISM_SERVICE` the
instant it was created. That was an explicit grant, not a default-deny failure.
Snowflake behaved correctly throughout.

**This has a customer-facing consequence, and it is by design.** The future
grant comes from Prism's own onboarding — `00_bootstrap.sql:53` and the setup
wizard's Part D (`app/setup/page.tsx:248`):

```sql
GRANT SELECT ON FUTURE TABLES IN SCHEMA <db>.<schema> TO ROLE PRISM_SERVICE;
```

It exists so new source tables are readable without re-granting. The trade-off:
**any table anyone later creates in a granted schema becomes readable by Prism
automatically.** A customer granting Part D on a shared schema is consenting to
more than the tables that exist that day. This belongs in the customer security
brief, and a customer who wants tighter scope should grant per-table instead of
per-schema.

## 3. Non-Anthropic LLM providers (existing, still open)

The Copilot / OpenAI / Gemini paths have never run end to end. Test before any
customer selects them, or hide the cards in `/setup` step 4. (See memory note
`llm-provider-testing-needed` and CLAUDE.md → Deferred items.)
