# Design System & UI Patterns

Read this before any UI work. The hard rules (0.5px borders, sentence-case copy,
portal every floating element) are summarised in CLAUDE.md; the details live here.

---

## Typography

- Font: Inter (Google Fonts), weights 400/500/600 only — never 700
- 400 Regular: body text, meta labels, chip values
- 500 Medium: button labels, toggle options, status pills
- 600 Semibold: page title, card titles, alias names, section headings

## Color Tokens

| Token | Hex | Usage |
|---|---|---|
| `page-bg` | `#F4F6F8` | Page background |
| `surface` | `#FFFFFF` | Card/panel backgrounds |
| `surface-hover` | `#F9FAFB` | Row hover state |
| `accent` | `#378ADD` | Primary buttons, active states, links |
| `accent-strong` | `#185FA5` | Pressed state, text on accent-tint |
| `accent-tint` | `#EAF1FE` | Ghost button bg, selected chip bg |
| `accent-border` | `#C5D8FC` | Borders on accent-tint elements |
| `text-primary` | `#1A1A2E` | Headings, alias names |
| `text-secondary` | `#374151` | Body text, value chips |
| `text-muted` | `#6B7280` | Meta labels, helper text |
| `text-hint` | `#9CA3AF` | Placeholders, counts, empty states |
| `border` | `#E5E7EB` | Card/chip/button borders — always 0.5px |
| `border-subtle` | `#F3F4F6` | Row dividers — always 0.5px |
| `confidence-high` | `#0F6E56` | ≥90% — muted green |
| `confidence-med` | `#BA7517` | 70-89% — muted amber |
| `confidence-low` | `#A32D2D` | <70% — muted red |

## Border Radius — hard-edge (near-square, technical/professional feel)

Defined as CSS variables in `app/globals.css` (`--radius-*`) and mapped to Tailwind
utilities (`rounded-card`, `rounded-button`, `rounded-toggle-option`, `rounded-pill`,
`rounded-row`) via `@theme inline`. Change the tokens to retune globally.

- Cards / main containers: 3px (`rounded-card`)
- Buttons / toggle containers: 2px (`rounded-button`)
- Toggle group individual options: 2px (`rounded-toggle-option`)
- Value chips / status pills / ungrouped chips: 2px (`rounded-pill`) — slightly-rounded rectangles, NOT full pills
- Checkboxes: 50% (kept round)
- Row hover highlight: 2px (`rounded-row`)
- Avatars, status dots, progress bars, spinners, toggle switches, numbered step/notification circles stay round (`rounded-full` / `borderRadius: '50%'`) — do NOT sharpen these.
- **Multi-select squares** (the 18×18 pick boxes in the column pickers) use `borderRadius: 5` — a deliberate softer square that reads as selectable rather than as a status chip, used identically in `AutoExportHome`, `PipelinesView` and `OneTimeStandardizationCard`. Documented 2026-08-08 (UI-01) after an audit flagged it as off-token; every OTHER hardcoded radius found in that audit (a 12px and a 6px dropdown, a 7px card wrapper) was genuinely off-system and has been moved to `var(--radius-card)`.
- Status pills/badges use `rounded-pill` (not Tailwind's `rounded-full`) so they pick up the sharp radius.

## Borders

- All borders: **0.5px** — non-negotiable
- Default: `0.5px solid #E5E7EB`
- Row dividers: `0.5px solid #F3F4F6`
- Drag-over active state: `2px left border #378ADD` (only exception)
- Featured card accent: `2px full border #C5D8FC` (only exception)

## Shadows

Essentially none — shadows are functional, never decorative. Two sanctioned uses:

- The active toggle option (`0 1px 3px rgba(0,0,0,0.08)`) — shows selected state.
- **Floating elements that leave the page plane** — portaled tooltips, dropdown menus and the avatar button (`PipelinesView`, `UserMenu`, `RoleBadge`). These overlay other content, so a shadow is what separates them from what they cover; without it a portaled menu reads as part of the card beneath it. Documented 2026-08-08 (UI-01) after an audit found five undocumented values in use.

Never add a shadow to a card, panel, row or button that sits IN the page flow.

## Spacing

- Page outer padding: 32px top/bottom, 40px left/right
- Card internal padding: 24px
- Group row vertical: ~13px, horizontal: ~12px
- Gap between value chips: 6px
- Gap between ungrouped chips: 8px
- Gap between group rows: 4px
- Gap between major card sections: 24px

## Copy & Tone

- Sentence case everywhere in the COPY — never write a label or badge string in ALL CAPS. This is about the source text: `How it works`, not `HOW IT WORKS`.
- **Sanctioned exception — the small-caps eyebrow treatment.** A handful of 10–11px labels (section eyebrows, table column headers, data-type chips) carry the Tailwind `uppercase` class plus `tracking-wide`/`tracking-wider`. That is a deliberate *typographic* treatment, not shouted copy, and it is distinct from the rule above: the underlying string stays sentence case (or, for type chips, is explicitly `.toLowerCase()`d first) and only the rendering is capitalised. Keep it to small, secondary, non-prose labels. **Status pills are NOT in this exception** — they read "In review", "Created", "Completed" in both source and render, which is what the rule was written for (audited 2026-08-08, UI-01).
- Humanize timestamps — "May 8, 2026 · 6:54 PM" not "5/8/2026, 6:54:22 PM"
- Humanize counts — "3 values need a home" not "Ungrouped items (3)"
- Status labels — "In review", "Created", "Completed" (not "IN REVIEW")
- Empty states encouraging — "No items yet" not blank

---

## Portal Tooltips and Dropdowns

**Always use `createPortal` for any floating UI (tooltips, dropdowns, menus) that lives
inside a card or panel.** Pipeline cards and column-picker rows use `overflow: hidden`
which clips `position: absolute` children. Portal to `document.body` + `position: fixed`
+ `getBoundingClientRect()` is the required pattern.

- `DomainInfoTooltip` in `AutoExportHome.tsx` — hover tooltip, `pointerEvents: 'none'`
- "Update Standardizations" dropdown in `PipelinesView.tsx` — click dropdown using `stdTriggerRef` / `stdMenuRef` / `menuPos` state / `openStdMenu()` / click-outside handler via refs. Portaled with `position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999, width: 220`
- `Toast.tsx` in `app/components/` — shared portaled toast notifications.

**Critical:** use `width: NNN` (exact), NOT `minWidth`. A portaled `position: fixed`
element with only `minWidth` will stretch to the viewport width because the
fixed-position stacking context has no `overflow: hidden` parent to constrain it.

---

## State Management (Client) — `RunReviewClient.tsx`

- Do NOT write to the warehouse on every drag/rename — state is maintained in memory on the client
- A 30-second autosave timer writes the full blob (with `expectedRev`) whenever there are unsaved changes; suspended while an export is in flight
- `pagehide` flushes via `navigator.sendBeacon` (which can't read the response — acceptable); `beforeunload` warns when unsaved changes exist; the two are debounced against double-firing
- On a `409 conflict` the client refetches the server blob and replaces its local state
- On page load: fetch blob by `run_id` — one query, no joins — hydrate UI directly
- The per-group review checkmarks ("Checked X/Y" counter + round check button on each group row) were **removed 2026-07-13** from BOTH review UIs (`RunReviewClient` and `OneTimeReviewClient`) at the user's request — they were purely client-side state, never persisted or sent anywhere. Do not reintroduce them.

---

## Pipeline Detail UI (`stand-ui/app/home/PipelineDetail.tsx`)

### Activity Status (polling ring REMOVED 2026-07-13)

The old `RefreshRing` 30-second countdown ring, the "refreshes every 30s / Next refresh
in Ns" copy, and the teal "Checking for new values" scanning state are **gone from the
UI** (removed with the move to 10-minute-tick standardization). Do not reintroduce them.
What remains:

- **ActivityTab live status**: a green pulse dot "Live · watching for new values" for active cards, replaced by an amber pulse "Standardizing data" while a standardization pass runs (`isStandardizing` prop — driven by SSE `standardizing_started`/`_finished`, which `beginStandardization`/`endStandardization` broadcast from every path: the 10-minute tick, the manual Auto-standardize, and initial baselines).
- **Collapsed card**: while standardizing, the "Standardized table last updated X ago" line under the schedule badge is replaced by an amber pulse "Standardizing…" (same `running` flag that drives the button's spinner), so the animation is visible without expanding the card.
- **Live timestamps without reload**: `fully_synced_at` re-renders via the SSE-driven `fetchPipelines()` refetches (`metrics_updated` fires every poll cycle and after every rebuild; `standardizing_finished` also refetches), and a 30 s `setClockTick` interval in `PipelinesView` re-renders relative labels even when no events land (paused pipelines).
- The backend still emits `scanning_started`/`_finished` each poll cycle; the client now ignores them (`scanningPipelines`/`cycleResetAt`/`markCycleReset` state was deleted). ONE freshness timestamp — **"Standardized table last updated"** (`fully_synced_at`) — replaces the earlier separate "Last updated"/"Last standardized" pair (user request 2026-07-13: a single timestamp meaning "source checked and everything standardized+exported, or nothing new"; renamed from "Last updated" the same day at the user's request). It sits at the TOP of the Activity tab (right-aligned next to the Live/Standardizing status; the old milestones list is gone — "Created" moved to a small hint at the bottom of the Settings tab) and on the collapsed row as "Standardized table last updated X ago" under the schedule badge.
- **Columns + specs tooltip**: the Activity tab's per-column breakdown (Column | Spec | Standardized) renders for EVERY card — single-column included. Next to each column sits an ⓘ (`SpecInfoIcon`, exported from `PipelinesView`) that opens on hover OR click (click pins; outside-click closes) a PORTALED fixed-position panel with the spec's description, standardization rules (parsed JSON array), and naming convention (structured rules + regex/examples/natural `convention_value`). Full spec records come from one `/api/column-specs` fetch in `PipelinesView` (`specsById` map → `PipelineDetail` prop). There is deliberately NO spec chip on the collapsed title row.

### Card-visibility rule (don't hide a live pipeline)

`PipelinesView` hides a card while its export is still being set up for the first time —
but only when the export has **no** live (active/paused) column. Compute
`exportsWithLiveColumn` first; an export is hidden only if every one of its columns is
`pending_baseline`. Adding a column to an already-live pipeline creates a
`pending_baseline` row sharing that export, so a naive "hide if any column is
pending_baseline" wrongly hides the live pipeline → a "blank pipeline page" while the new
column's baseline run builds. Do not reintroduce that.

**Pipelines tab empty states:** two distinct cases — (1) `pipelines.length === 0` → "No
pipelines yet" with a prompt to use Connect tab; (2) pipelines exist but ALL are hidden by
card-visibility (every pipeline is `pending_baseline` with no live sibling) → "Pipeline
setup not complete" message directing to the Connect tab.

**Incomplete pipeline cards (Connect tab):** when a user has `pending_baseline` pipelines
they created (`created_by === accountId`), the Connect tab shows cards below the form with
an "Incomplete" badge, table name, column info, a "Continue" button (POST to
`create-initial-run` → navigate to `/run/{run_id}`), and an X button to DELETE the
pipeline. Grouped by `table_fqn` so multi-column setups show as one card. Only visible to
the pipeline's creator — admins don't see other users' incomplete setups here. Does NOT
affect one-time standardizations (those use `RUNS` with `run_type='one_time'`).

**Add a column to an existing pipeline:** the `+` on a table card opens `AddColumnModal`;
each chosen column gets its own spec via the inline `ColumnSpecField`, is created
`pending_baseline` (sharing the table's export + update schedule), then the review wizard
opens for it.

### Logo Navigation

The Prism logo (`app/layout.tsx`) links to `/home?tab=connect`. `AutoExportHome.tsx` reads
`useSearchParams()` to respond to the `tab` param and switch tabs, so clicking the logo
from any tab always navigates to Connect. `AutoExportHome` is wrapped in `<Suspense>` in
`home/page.tsx` because `useSearchParams()` requires a Suspense boundary in the App Router.

---

## Export Lookup Table (UI)

Users can export the lookup table (`LITERAL_ALIAS_MATCHES` joined with
`APPROVED_ALIAS_NAMES`) from two surfaces:

- **Pipeline cards** (`PipelinesView.tsx`) — "Lookup table" button (download icon) in the card toolbar. Opens `ExportLookupModal` with `columns` prop containing the card's columns. For multi-column pipelines, the modal shows a column picker so the user selects which spec's mappings to export.
- **Pipeline detail — Mappings tab** (`PipelineDetail.tsx`) — the same modal, pre-scoped to the open column's spec. (The old domain-library `StandardizationsView.tsx` page was deleted with the domains removal.)

### `ExportLookupModal` (`app/components/ExportLookupModal.tsx`)

Shared portaled modal (`createPortal` to `document.body`, z-index 60). Four format options
in a 2x2 grid:

- **CSV** — client-side blob: fetches from `GET /api/global-standardizations?domain_id=N`, builds CSV string, triggers download
- **Excel** — client-side blob: same fetch, dynamic `import('xlsx')`, triggers `.xlsx` download
- **Google Sheets** — `POST /api/global-standardizations/export` with `{ format: 'sheets', domain_id, domain_name }`. Handles 401 → Google OAuth redirect. Opens the created sheet in a new tab.
- **Snowflake** — `POST /api/global-standardizations/export` with `{ format: 'snowflake', domain_id, domain_name, snowflakeTableFqn? }`. Shows an optional target table name input; default is `PRISM_DB.PUBLIC.<NAME>_LOOKUP` (mssql: `PRISM_DB.EXPORTS.*`). The route parses/quotes the user-supplied FQN part-by-part and refuses `PRISM_DB.INTERNAL` targets.

### `POST /api/global-standardizations/export` extensions

The export route accepts optional `domain_id` and `domain_name` in the request body —
**historical names: `domain_id` carries a spec_id** and filters the lookup to that spec;
`domain_name` is the display name used for the Google Sheet title and the default
warehouse table name.

---

## Shared UI components

`app/components/` — `ColumnSpecEditor`, `ColumnSpecField`, `ExportLookupModal`, `Toast`,
`RoleBadge`, `ConventionEditor`, `SpecChangeWarning`, `UserMenu`, `UpdateScheduleEditor`,
plus the `spec-types.ts` `ColumnSpec` interface.
