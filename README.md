# Prism

**Messy values in. One standard out.**

Prism is a warehouse-native data standardization platform. It sits on top of
your database, recognizes when different text values mean the same thing —
`att`, `AT&T wireless`, `a t and t` — and maps them all to one canonical name
(`AT&T`). After a one-time human review, it keeps doing that automatically as
new data arrives.

**Website:** <https://getprismdata.co/>

---

## Contents

- [The problem](#the-problem)
- [Who it is for](#who-it-is-for)
- [How it works](#how-it-works)
- [Capabilities](#capabilities)
- [Two editions](#two-editions)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security and data residency](#security-and-data-residency)
- [Documentation](#documentation)
- [License](#license)

---

## The problem

Free-text columns drift. The same customer, vendor, carrier or product gets
typed a dozen different ways across systems and over time. Every report that
groups by that column then undercounts, every join misses rows, and every
analyst writes their own `CASE WHEN` cleanup that nobody else can reuse.

Prism replaces those one-off fixes with a single, shared, reviewed mapping per
column — stored in your own warehouse, applied continuously.

## Who it is for

- **Data and analytics engineers** who own pipelines and want standardization
  to be a managed step rather than hand-maintained SQL.
- **Analysts and BI teams** who build reports and dashboards on columns that
  cannot be trusted to group correctly.
- **Operations and data-governance owners** who know what the correct names
  are and need a simple way to review and approve mappings without writing SQL.
- **Teams building AI or LLM features** on warehouse data, where inconsistent
  values quietly degrade results.

It is built for organizations whose data already lives in Snowflake, SQL
Server, PostgreSQL or MySQL. For one-off jobs it also cleans a spreadsheet or
file directly.

## How it works

Prism has two halves: a one-time setup per column that a person reviews, and an
automated pipeline that keeps the result current.

### 1. Describe the column

For each column you create a **column spec** — a short description of what the
column holds, optional plain-English standardization rules ("treat regional
subsidiaries as the parent company"), and an optional naming convention (for
example title case, or a pattern the names must match). The spec is locked when
the run starts, so every later decision is made against the same contract.

### 2. Connect a source

Point Prism at a table in your warehouse and pick the column to standardize.
(A file or Google Sheet can be cleaned too — see
[One-time standardization](#one-time-standardization).)

### 3. Auto-group

Prism reads the distinct values and groups them in three stages:

1. **Lookup** — values that were already confirmed in the past are matched
   instantly by a normalized hash, with no AI call.
2. **AI grouping** — the remaining values are split into chunks and grouped in
   parallel by a large language model, guided by the column spec.
3. **Merge pass** — a final pass reconciles the chunks so the same entity
   proposed in two chunks becomes one group. Names that were already confirmed
   always win over newly proposed ones.

If the AI fails or is unsure, Prism says so: the value is flagged for review
rather than being given a confident-looking guess.

### 4. Review

A person reviews the proposed groups in the web UI: drag values between groups,
rename a group, create new groups. This is the only step that needs a human.

### 5. Export

Confirmed mappings are written to a **lookup table** in your warehouse, and
Prism builds the standardized output in the form you chose (see
[Output modes](#output-modes)).

### 6. Stay in sync, automatically

From then on a background pipeline keeps the output current:

- **Every minute**, a *poll pass* checks each source for new or changed values
  and adds them to a queue. It only detects and queues — an idle check costs
  nothing on the warehouse.
- **Every 10 minutes**, a *standardization tick* drains the queue for pipelines
  whose update window is open: known values are matched from the lookup, new
  ones are grouped by the AI, and the export is rebuilt.
- **Every hour**, a reconciliation sweep compares the source against the lookup
  and rebuilds exports as a safety net.

Deleted and updated source rows drop out of the export on the same cycle.

## Capabilities

### Sources

Pipelines watch live warehouse tables. Each warehouse detects changes in the
cheapest way it natively supports:

| Warehouse | How new values are detected |
|---|---|
| Snowflake | Streams |
| Microsoft SQL Server | Change Tracking, or tiered diff scans where it is unavailable |
| PostgreSQL | Diff scans gated by a free write-counter heartbeat |
| MySQL (8.0.19+) | Diff scans gated by a table-update-time heartbeat |

One installation runs against one warehouse platform, chosen in the setup
wizard. All four are implemented behind a common adapter layer and held to the
same behavior by parity tests.

Files and spreadsheets — CSV, Excel and Google Sheets — are sources for the
[one-time flow](#one-time-standardization) rather than for pipelines: a
pipeline exists to keep a *live* source standardized, and a file is cleaned
once.

### Output modes

| Mode | What Prism produces |
|---|---|
| **Table** | A standardized copy of the source table, rebuilt as data changes |
| **View** | A live view over the source joined to the mappings (not available on SQL Server) |
| **Column** | A companion `<COLUMN>_STANDARDIZED` column alongside the original |
| **Lookup table only** | Just the `value → canonical name` mapping, for you to join yourself |

Prism never modifies your existing source columns, and it refuses any export
whose destination would overwrite the source table.

### Standardization

- **AI grouping** of variant spellings, abbreviations and typos.
- **Plain-English rules** per column, which can override the default
  "same entity" grouping when your business logic calls for it.
- **Naming conventions** — structured rules, examples, or a regular expression
  the canonical names must follow.
- **A shared, cumulative lookup** per column spec: every confirmed mapping is
  reused, so the AI is only asked about values it has never seen.
- **Choice of AI provider** — Anthropic Claude, OpenAI or Google Gemini in the
  standard edition; Snowflake Cortex in the Native App edition, so data never
  leaves the Snowflake account.

### Review and control

- Drag-and-drop review of proposed groups, with rename and create.
- **Update schedules** — restrict automatic standardization to chosen days and
  hours (default Monday–Friday, 9–5).
- Pipeline health checks that pause a pipeline with a clear message when its
  source becomes unreachable, rather than failing silently.
- Live status in the UI over server-sent events.

### One-time standardization

A separate "clean a list once" flow standardizes the columns of a warehouse
table, an uploaded CSV/Excel file, or a Google Sheet, without creating a
pipeline or touching the shared lookup. The result can be written to a
standalone warehouse table or downloaded as CSV or Excel, or sent to Google
Sheets. For an uploaded file, Prism can return the original file with only the
standardized cells changed, leaving formatting and every other cell as it was.

### Administration

- A five-step **setup wizard** that generates the exact install SQL for the
  chosen warehouse, verifies the install, and stores credentials encrypted.
- Google sign-in with invitation-only membership and admin/user roles
  (standard edition); Snowflake-managed access (Native App edition).
- Instant session revocation.

### Built-in guardrails

Limits defer or refuse loudly; they never drop data silently.

| Limit | Behavior when exceeded |
|---|---|
| 5,000 distinct values per standardization run | The rest are processed on later passes |
| 20,000 distinct values per one-time column | Refused, with a prompt to use a pipeline |
| 100,000 rows per Google Sheet tab | Refused with a clear error |
| 20 MB / 200,000 rows per upload | Refused, with a prompt to load the data into a warehouse table |

## Two editions

Prism ships from this one codebase in two editions. They share the grouping
engine, the review UI, the lookup model and the pipeline.

| | Standard edition | Snowflake Native App edition |
|---|---|---|
| Runs | On a server you or Prism operate | Inside the customer's own Snowflake account, as a container service |
| Warehouses | Snowflake, SQL Server, PostgreSQL, MySQL | Snowflake |
| Connects with | A service user's credentials, entered in the setup wizard and stored encrypted | No credentials — access is granted to the application through Snowflake |
| AI provider | Anthropic, OpenAI or Gemini | Snowflake Cortex |
| Sign-in | Google sign-in, invitation only | Snowflake authentication |
| Google Sheets and email invitations | Available | Disabled — nothing leaves the account |
| Packaging | `deploy/` | `native/` |

The edition is selected by the `PRISM_EDITION` switch (`standard` by default,
`native` for the Marketplace build). With the switch unset, the app behaves
exactly as the standard edition. See [`native/DEVELOPING.md`](native/DEVELOPING.md).

## Architecture

```
                     ┌──────────────────────────────────────────┐
                     │            Prism web app (Next.js)       │
  Browser  ───────►  │  Review UI · API routes · setup wizard   │
                     │  Background poller + standardization tick│
                     └───────┬───────────────────────┬──────────┘
                             │                       │
               warehouse adapter layer          AI provider
           (Snowflake · SQL Server ·       (Claude · OpenAI · Gemini
              PostgreSQL · MySQL)               · Snowflake Cortex)
                             │
        ┌────────────────────┴───────────────────┐        ┌───────────────────┐
        │        Customer's warehouse            │        │  App database     │
        │  lookup tables · queue · run state     │        │  (SQLite)         │
        │  export tables/views · source tables   │        │  metadata/config  │
        └────────────────────────────────────────┘        └───────────────────┘
```

- **Web app** — Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS.
  One process serves the UI and API and runs the background jobs.
- **Warehouse adapter layer** — every piece of SQL, change detection, export
  and grant logic sits behind one adapter contract with an implementation per
  warehouse (`stand-ui/app/api/_lib/warehouse/`).
- **Two stores** — anything joined against customer data lives in the
  customer's warehouse; the local SQLite file holds only metadata and
  configuration (accounts, pipeline definitions, column specs).
- **Normalization** — a `PRISM_NORMALIZE` function installed in the warehouse
  and a TypeScript mirror of it are kept identical by tests, so a value matches
  the same way in SQL and in the app.
- **Safe regular expressions** — user-authored convention patterns are compiled
  with RE2, which cannot backtrack, so a bad pattern cannot stall the server.

## Repository layout

```
stand-ui/                 The application (Next.js) — see stand-ui/README.md
  app/                    Pages, components and API routes
  app/api/_lib/           Server library: adapters, poller, grouping, export
  scripts/                Parity tests, live warehouse suites, install runners
00_bootstrap.sql          Snowflake install: database, schemas
01_internal_tables*.sql   Install script per warehouse (tables, function, roles, grants)
02_demo_data*.sql         Demo source data per warehouse — development only
native/                   Snowflake Native App packaging (manifest, setup, Dockerfile)
deploy/                   Standard-edition server provisioning and deploy scripts
docs/                     Engineering documentation — see docs/README.md
CLAUDE.md                 Engineering rules, invariants and server-library map
```

`stand-ui` is the application's historical folder name, from before the product
was named Prism.

## Getting started

Requirements: Node.js 20 or newer, and access to one supported warehouse.

**1. Install the warehouse objects.** For Snowflake, from the repo root:

```bash
snowsql -f 00_bootstrap.sql
snowsql -f 01_internal_tables.sql
snowsql -f 02_demo_data.sql        # optional demo table — development only
```

For the other warehouses, start the dev container described in
[`docs/DEV_MSSQL.md`](docs/DEV_MSSQL.md), [`docs/DEV_POSTGRES.md`](docs/DEV_POSTGRES.md)
or [`docs/DEV_MYSQL.md`](docs/DEV_MYSQL.md) and run the matching
`npm run <mssql|pg|mysql>:install`.

**2. Run the app.**

```bash
cd stand-ui
npm install
cp .env.local.example .env.local   # fill in the "Required" block
npm run dev                        # http://localhost:8000
```

**3. Finish in the browser.** Sign in with the `ADMIN_EMAIL` account and walk
the `/setup` wizard, which connects the warehouse and the AI provider.

Every environment variable is described in
[`stand-ui/.env.local.example`](stand-ui/.env.local.example).

## Testing

All commands run from `stand-ui/`.

```bash
npx tsc --noEmit            # typecheck the application
npm run typecheck:scripts   # typecheck the maintained scripts
npm run test:parity         # pure-logic parity tests, no database needed
```

The parity suite checks that the TypeScript normalizer matches the in-warehouse
function, that SQL string escaping and each dialect's helpers behave
identically, and that header detection, the regex safety screen and the
in-place file patcher are correct. It also carries structural guards for rules
that have broken production before.

Each non-Snowflake warehouse also has four live suites that run against its dev
container — adapter and install (`-live`), change detection (`-detection`), the
full detect → standardize → export path (`-lifecycle`), and setup
(`-setup`). For example: `npm run test:pg-lifecycle`.

## Deployment

- **Standard edition** — a single small Linux server behind Caddy, managed by
  systemd. [`deploy/DEPLOY.md`](deploy/DEPLOY.md) covers provisioning and
  updates.
- **Native App edition** — a container image and an application package for
  Snowflake. [`native/DEVELOPING.md`](native/DEVELOPING.md) covers building and
  publishing; [`native/README.md`](native/README.md) is the consumer's install
  guide.

## Security and data residency

- **Customer values stay in the customer's warehouse.** Lookups, run state and
  logs all live there; the app database holds metadata and configuration only.
- **Stored credentials are encrypted** at the application level with
  AES-256-GCM, using a per-installation key.
- **Least-privilege roles** are created by the install scripts, and the setup
  wizard shows the customer's administrator every statement before it runs.
- **Sessions** are HMAC-signed and checked against a server-side version on
  every request, so revocation is immediate.

Details: [`docs/SECURITY_AND_DISCLOSURES.md`](docs/SECURITY_AND_DISCLOSURES.md)
and [`docs/CUSTOMER_SECURITY_BRIEF.md`](docs/CUSTOMER_SECURITY_BRIEF.md).

## Documentation

[`docs/README.md`](docs/README.md) indexes the engineering documentation: the
data model, pipeline internals, the AI grouping pipeline, the warehouse adapter
layer, the setup wizard, product decisions and the design history of each
warehouse port.

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE).
