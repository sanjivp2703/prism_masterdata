# Prism — Integration & Platform Strategy

Business/strategy context that previously lived only in conversation.
Decisions recorded 2026-08-12. This is the "which platforms, in what order,
and what do we tell prospects" document — the technical parity details live
in `docs/WAREHOUSES.md` and the per-platform port plans.

## 1. Warehouse roadmap

**Live today (4):** Snowflake (original, most battle-tested), Microsoft SQL
Server, PostgreSQL, MySQL. One warehouse per installation, chosen in the
setup wizard.

**Next port worth building proactively: Oracle.** The legacy-industry ICP
(manufacturing, distribution, healthcare back offices) runs Oracle heavily.
Implementation notes for when it starts: `node-oracledb` in thin mode (no
Instant Client install), and mind the classic **empty-string-IS-NULL trap**
(`''` = NULL in Oracle VARCHAR2 — the normalization/dedup layer must treat
the two as one value or lookups silently split).

**"On request" only — build when a deal pulls it, never speculatively:**
Db2/AS400, Teradata, SAP HANA, Progress/OpenEdge, and similar legacy
platforms. Each is a real port (dialect + detection + export swap semantics)
with a tiny standalone market; a signed prospect is the trigger.

**MariaDB: deferred deliberately.** Despite looking like "free MySQL
support", it lacks the functional key parts the MySQL export/detection path
relies on — treat it as unsupported rather than half-supported.

**A note on the native (Marketplace) edition:** the Snowflake Native App
edition (docs/NATIVE_APP_PLAN.md) is Snowflake-only by definition and does
not participate in this roadmap — multi-warehouse breadth is the standard
edition's story.

## 2. Microsoft Dynamics — the real story

This matters because "do you support Dynamics?" is a landing-page-level
question for the ICP.

- **Dynamics GP / NAV / AX (legacy, on-prem):** plain SQL Server databases →
  **supported TODAY** through the mssql adapter. It is honest to say
  "Dynamics" on the landing page on this basis.
- **Dynamics 365 F&O:** no customer-accessible database is bundled — but the
  sanctioned export path (BYOD / Synapse Link) lands the data in the
  customer's own Azure SQL / Synapse, which the mssql adapter reads. Support
  = "via your existing BYOD/Synapse replica".
- **Dynamics 365 CE / Dataverse:** exposes only a **read-only TDS endpoint**.
  Prism could READ from it, but every write path (export table, column mode)
  is impossible there — supporting it directly requires an architecture
  split between the SOURCE (Dataverse) and the DATA PLANE (a writable
  warehouse elsewhere), which the current one-warehouse-per-install design
  does not have. **Write-back** to Dataverse would be a Web API integration
  writing a consent-gated custom field (mirroring column mode's consent
  design). Both are "build only when a prospect pulls it".
- **Qualification question for sales calls:** *"Do you report on your
  Dynamics data outside Dynamics?"* — a yes means a replica already exists
  (SQL Server / Synapse / warehouse) and Prism works today; a no means they
  are the Dataverse-direct case above.

**The replica pattern generalizes:** Salesforce, NetSuite, HubSpot etc. are
the same shape — customers who report on that data already sync it into a
warehouse Prism supports. SaaS-direct connectors are not the product;
standardizing the replica is.

## 3. Round-trip smoothing package (file workflows)

For customers whose "database" is really an export/reimport workflow
(Dynamics wizards, ERP file loads):

1. **Edit-in-place export** — SHIPPED 2026-08-12 (`file-inplace.ts`): the
   one-time flow hands back the customer's own CSV/XLSX bytes with only the
   standardized cells changed — hidden GUID columns, styles, and column
   order survive reimport wizards.
2. D365 static-worksheet recognizer + GUID-column banner — pending.
3. Changed-rows-only output + change report — pending (the export route
   already returns `cells_changed`; the surface doesn't exist yet).
4. Guided "D365 recipe" surface (export → clean → reimport walkthrough) —
   pending.
5. Power Automate bridge template — pending.

## 4. Positioning language

- **"Warehouse"** is the marketing umbrella term for every backend (including
  plain SQL Server/Postgres/MySQL databases) — one word, no taxonomy on the
  landing page.
- **Dynamics 365 landing-page claim** (approved wording direction): "clean
  exported data instantly / standardize continuously alongside your
  reporting database / direct write-back on request" — three tiers matching
  the three real support levels above, promising nothing that requires the
  unbuilt Dataverse integration.
