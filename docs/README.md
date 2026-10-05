# Prism documentation

Engineering documentation for Prism. The [root README](../README.md) is the
product overview; [`CLAUDE.md`](../CLAUDE.md) holds the hard rules, invariants
and a module-by-module map of the server library.

## Architecture and reference

| Document | Covers |
|---|---|
| [DATA_MODEL.md](DATA_MODEL.md) | Schemas, migrations, the run state blob, column specs, the two stores |
| [PIPELINE_INTERNALS.md](PIPELINE_INTERNALS.md) | Poller, change detection, ticks, exports, health guards, warehouse cost model |
| [LLM_PIPELINE.md](LLM_PIPELINE.md) | Grouping, prompts, the merge pass, the export write path, AI providers |
| [FILE_PIPELINES.md](FILE_PIPELINES.md) | The one-time flow, CSV / Excel uploads and Google Sheets sources, header-row detection (file/Sheets *pipelines* were removed — the filename is historical) |
| [WAREHOUSES.md](WAREHOUSES.md) | The adapter layer and the per-warehouse parity matrix |
| [SETUP_WIZARD.md](SETUP_WIZARD.md) | The `/setup` wizard, auth and sessions, settings, deployment |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | UI conventions, components, styling, copy rules |

## Security

| Document | Covers |
|---|---|
| [SECURITY_AND_DISCLOSURES.md](SECURITY_AND_DISCLOSURES.md) | Security posture, roles and grants, credential storage |
| [CUSTOMER_SECURITY_BRIEF.md](CUSTOMER_SECURITY_BRIEF.md) | The customer-facing summary of the above |

## Decisions and design history

| Document | Covers |
|---|---|
| [PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md) | Why the product behaves the way it does |
| [MSSQL_PORT_PLAN.md](MSSQL_PORT_PLAN.md), [POSTGRES_PORT_PLAN.md](POSTGRES_PORT_PLAN.md), [MYSQL_PORT_PLAN.md](MYSQL_PORT_PLAN.md) | How each warehouse port was planned, phased and verified |
| [NATIVE_APP_PLAN.md](NATIVE_APP_PLAN.md) | The Snowflake Native App edition plan |

## Local development

| Document | Covers |
|---|---|
| [DEV_MSSQL.md](DEV_MSSQL.md), [DEV_POSTGRES.md](DEV_POSTGRES.md), [DEV_MYSQL.md](DEV_MYSQL.md) | Dev containers and live test suites for the non-Snowflake warehouses |
| [`../native/DEVELOPING.md`](../native/DEVELOPING.md) | Building and packaging the Native App edition |
| [`../deploy/DEPLOY.md`](../deploy/DEPLOY.md) | Provisioning and updating a standard-edition server |

## A note on internal runbooks

Some documents here refer to `CLIENT_ONBOARDING`, `PRELAUNCH_CHECKLIST` and
client test scripts. Those are operational runbooks kept outside the published
repository (`docs/internal/`, untracked), so links to them do not resolve here.
