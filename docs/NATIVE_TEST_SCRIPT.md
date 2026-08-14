# Prism Native — consumer test script

The manual pass to run in a **fresh Snowflake account** installing Prism from a
listing share, before anything is sold. Work top to bottom — the order is a
realistic consumer journey, and later tests depend on earlier state. Check the
box only when the **expected result** matched exactly; anything else gets
written down verbatim (error text especially) even if it "mostly worked".

Legend: **[CORE]** must pass before selling · **[EDGE]** should pass, fix or
consciously accept · **[DEFER]** only if the feature ships in native v1.

Companion docs: `NATIVE_APP_PLAN.md` (N3/N4 exit criteria this script covers),
`PRELAUNCH_CHECKLIST.md` §1 (column mode's own mandatory protocol).

---

## 0. Account + listing setup (provider side, once)

- [ ] **0.1** New Snowflake account created in a region with SPCS support.
      Note the region — if Cortex doesn't serve Claude there, test 1.6 matters.
- [ ] **0.2** Provider account: private listing created from `PRISM_PKG`,
      shared to the new account. Same-org = `DISTRIBUTION=INTERNAL` (no scan);
      cross-org forces the security scan (N5 territory — know which you're in).
- [ ] **0.3** Consumer account has a second human user besides the installer
      (for role and visibility tests). Give it a password and a default
      warehouse; no special privileges.

## 1. Install & first run

- [ ] **1.1 [CORE]** Install the app from the listing (Snowsight →
      Marketplace/Apps). Grant the requested account privileges (compute pool,
      warehouse, endpoint binding, `SNOWFLAKE.CORTEX_USER`) in the permission
      UI — nothing should require a worksheet.
- [ ] **1.2 [CORE]** `CALL <app>.app_code.start_app()` → pool + `PRISM_APP_WH`
      + service created; `SHOW ENDPOINTS IN SERVICE <app>.services.prism_app`
      returns an ingress URL within ~2 min.
- [ ] **1.3 [CORE]** Installer opens the URL → Snowflake auth → terms
      interstitial appears ONCE → accept → lands on home as **Admin**.
- [ ] **1.4 [CORE]** `/setup` shows the native "Prism is ready" page (grant
      SQL + caller opt-in + Cortex note) — NOT the credential wizard.
- [ ] **1.5 [CORE]** Native cuts hold: one-time sources are Snowflake table /
      CSV·Excel / paste only (no Google Sheets anywhere); no email-invitation
      UI; `/debug` → 404.
- [ ] **1.6 [EDGE]** If the region lacks Claude on Cortex: first grouping
      fails with a model-unavailable message →
      `ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'AWS_US'` fixes it.
- [ ] **1.7 [CORE]** Second user opens the URL → arrives as **user** (not
      admin): no Settings menu item, no member management; pipelines and
      mappings visible.

## 2. Access & grants (the consumer's first real friction)

- [ ] **2.1 [CORE]** With NO data grants: type any real table into the
      one-time card → clean "Prism can't see this table" message, never a raw
      SQL error. "Don't see your table?" panel shows grant SQL with the REAL
      app name filled in.
- [ ] **2.2 [CORE]** Run the single-table grant SQL → table appears in the
      picker suggestions; columns load.
- [ ] **2.3 [CORE]** Run the whole-schema form (ALL + FUTURE TABLES) on a
      second schema → create a brand-new table there afterwards → it's
      immediately usable with no further grants.
- [ ] **2.4 [CORE]** Caller grants NOT opted in: one-time on a table only the
      user (not the app) can read → clean rejection telling them to ask the
      owner / use the panel. Fails closed, no hang, no raw error.
- [ ] **2.5 [CORE]** Run the caller-grant opt-in SQL from the panel (needs
      MANAGE CALLER GRANTS; run ALL statements — Snowsight ▶ runs only one!)
      → repeat 2.4's one-time end-to-end INCLUDING export to a new table in
      that database. Verify with `SHOW GRANTS TO APPLICATION <app>` that the
      app still has zero direct grants there, and the export table is owned by
      the USER's role.
- [ ] **2.6 [EDGE]** No dev-mode mirror needed: 2.5 works WITHOUT any
      `GRANT CALLER ... TO ROLE` statements (listing installs have no owner
      role — this failing means the dev-mode rule leaked into production).

## 3. One-time standardization — Snowflake table source

- [ ] **3.1 [CORE]** Single column → review groups → export, **Create new
      table** → table exists with all source columns, watched column
      standardized, unmapped/NULL values passed through raw.
- [ ] **3.2 [CORE]** Export again, **create mode, same name** → honest
      "already exists" message (never silently replaced, never a grants
      panel).
- [ ] **3.3 [CORE]** Export, **Overwrite existing** onto a table you own →
      contents replaced; row count right.
- [ ] **3.4 [CORE]** Multi-column session (2 columns, different specs) →
      per-column review pages → one export carrying both standardized columns.
- [ ] **3.5 [CORE]** One-time history: both sessions listed with target +
      date; opening an archived session shows its mappings.
- [ ] **3.6 [EDGE]** Re-export of an already-exported session updates the SAME
      archive row (no duplicates in history).
- [ ] **3.7 [EDGE]** Column with >20,000 distinct values → clean "connect it
      as a pipeline" refusal at creation (nothing half-created; earlier
      columns of the same session may orphan — known, cosmetic).
- [ ] **3.8 [EDGE]** Naming convention on a one-time spec (regex, e.g.
      `^[A-Z][a-z]+$`): LLM names conform; typing a violating rename in review
      is blocked with the per-requirement reason; examples/natural convention
      shows as guidance and does NOT block renames.

## 4. One-time — file & paste sources

- [ ] **4.1 [CORE]** CSV upload: header row auto-detected AND the override
      control shown; column picked; grouped; export as **CSV download** → the
      downloaded file is the ORIGINAL file with only standardized cells
      changed (hidden/extra columns, order intact).
- [ ] **4.2 [CORE]** XLSX upload, multi-tab: tab selector appears (no
      auto-pick); export as **Excel download** → in-place edit, styles intact,
      other tabs untouched.
- [ ] **4.3 [EDGE]** Legacy `.xls`: works, but export falls back to a
      regenerated file (not byte-identical — expected).
- [ ] **4.4 [CORE]** Unsupported file (`.txt`, `.pdf`) → clear rejection
      naming the allowed types.
- [ ] **4.5 [CORE]** Paste values (newline-separated, then tab-separated) →
      dedupe count shown → grouped → CSV export.
- [ ] **4.6 [CORE]** File-source session exported to a **warehouse table** →
      table created with the file's columns, standardized columns substituted.
- [ ] **4.7 [EDGE]** Oversize upload (>20 MB or >200k rows) → clear error
      suggesting a Snowflake table instead.
- [ ] **4.8 [EDGE]** CSV whose header is NOT row 1 (title rows above) →
      detection picks the right row; override works when it doesn't.

## 5. Review UI mechanics (any run)

- [ ] **5.1 [CORE]** Drag a value between groups; rename a group; create a new
      group; move a value out to ungrouped — all stick.
- [ ] **5.2 [CORE]** Autosave: make edits, wait ~35 s, hard-reload → edits
      survived. Close-tab warning appears with unsaved changes.
- [ ] **5.3 [EDGE]** Two tabs on the same run: edit in both → second save gets
      a conflict and refetches rather than silently clobbering.
- [ ] **5.4 [EDGE]** Unplaceable/odd values arrive as self-mapped
      needs-review singletons — nothing is ever just missing.
- [ ] **5.5 [EDGE]** Rename longer than 200 chars → blocked with a banner.

## 6. Pipelines — creation & output modes

- [ ] **6.1 [CORE]** Pipeline on a granted table, **Table** output, **24/7**
      schedule → baseline review → Accept → Begin → export table appears
      (app-owned), card shows Live + "Standardized table last updated".
- [ ] **6.2 [CORE]** Detection loop on 6.1: INSERT a brand-new value → queued
      within ~1 min (card queue count) → next 10-min tick standardizes it →
      export includes it. INSERT a variant of a known value → standardized at
      the tick with NO review needed (lookup path).
- [ ] **6.3 [CORE]** DELETE source rows → export drops them within ~1 min
      (hygiene rebuild). UPDATE a value → old gone, new queued.
- [ ] **6.4 [CORE]** Consumer grants SELECT on the export table to one of
      their roles → trigger another rebuild (insert a value) → **the grant
      survives** (COPY GRANTS).
- [ ] **6.5 [CORE]** **View** output mode → view exists at activation;
      reflects new mappings without rebuilds; break it (drop the view) →
      "Recreate view now" in Settings repairs it.
- [ ] **6.6 [CORE]** **Lookup table only** mode → no export object; mappings
      accumulate; lookup export (§8) still works.
- [ ] **6.7 [DEFER]** **Column** mode — ONLY if shipping in v1: consent
      checkbox required; companion `<col>_STANDARDIZED` appears; existing
      columns untouched; echo settles after one cycle. Run the FULL
      `PRELAUNCH_CHECKLIST.md` §1 protocol, not just this line.
- [ ] **6.8 [CORE]** "Export unstandardized values" toggle: default OFF →
      export has mapped rows only; flip ON in Settings → raw rows included on
      the next refresh.
- [ ] **6.9 [CORE]** Add a second column to the live pipeline (+ on the card)
      → new column goes through review while the first column's card STAYS
      visible and live; after Begin, both columns standardize.
- [ ] **6.10 [CORE]** Schedules: **Manual only** — poller still detects and
      queues, but nothing standardizes until "Update Standardizations" is
      clicked. **Window** — values arriving in a closed window wait; drain at
      the first tick after it opens (shrink a window to test same-day).
- [ ] **6.11 [EDGE]** Pause the pipeline → detection stops acting; Resume →
      picks up cleanly.
- [ ] **6.12 [EDGE]** Duplicate prevention: same table+column pipeline again
      → refused, not a second card.
- [ ] **6.13 [EDGE]** Abandon a creation after "Create initial
      standardizations" (close the tab) → an Incomplete card appears on
      Connect with working Continue and ✕ (delete).
- [ ] **6.14 [EDGE]** Drop the source table of a live pipeline → pipeline
      pauses with a human-readable message (no raw driver text); recreate the
      table → resume works.
- [ ] **6.15 [EDGE]** Bulk load: insert a few hundred rows in one statement →
      all queued and standardized across ticks; nothing silently dropped.

## 7. Mass events & recovery

- [ ] **7.1 [EDGE]** TRUNCATE + full reload of the source → within the hour
      (top-of-hour sweep) or after a manual update, the export matches the new
      contents.
- [ ] **7.2 [EDGE]** Suspend (`stop_app()`), wait 10+ min, resume
      (`start_app()`) → pipelines resume from state (block volume): queue
      intact, next tick standardizes; no re-onboarding, no lost pipelines.

## 8. Lookup & mappings

- [ ] **8.1 [CORE]** Mappings tab shows confirmed mappings for the pipeline's
      spec.
- [ ] **8.2 [CORE]** Lookup export: **CSV** and **Excel** downloads; **Snowflake
      table** to the default name AND to a custom FQN. A `PRISM`-internal
      target is refused. (No Sheets option in native.)
- [ ] **8.3 [EDGE]** Spec with pre-standardized values seeded at creation →
      the first run hash-hits them (no LLM, correct groups, no review noise).
- [ ] **8.4 [EDGE]** Referee sanity: in a pipeline baseline review, move a
      lookup-matched value into an obviously wrong group and rename a
      lookup-validated alias → export → the mistaken change is reverted (or
      kept — record which; the bar is "extremely confident").

## 9. Billing & usage (the money path — hand-count everything)

- [ ] **9.1 [CORE]** Fresh install starts at 0. Standardize a known count of
      distinct values (e.g. a 50-value one-time) → Usage shows exactly +50.
- [ ] **9.2 [CORE]** Re-encounters are free: insert variants of already-mapped
      values into a pipeline → total does NOT increase.
- [ ] **9.3 [CORE]** Cross the free tier with a counted fixture (e.g. the
      1,200-value generator) → free stops at exactly 1,000; billable = total −
      1,000; "Billed to date" = billable × $0.025.
- [ ] **9.4 [CORE]** **Billing events land**: within Snowflake's latency, the
      provider account's paid-usage views show events matching the app's own
      meter (whole-cent events; sub-cent carry means totals match to <$0.01).
      This is the piece no dev install could prove.
- [ ] **9.5 [CORE]** As the consumer, `CALL <app>.app_code.EMIT_BILLING(...)`
      → fails (proc invisible). Consumers cannot bill themselves.
- [ ] **9.6 [EDGE]** Back-to-back passes minutes apart → later emission
      retries cleanly if rate-limited (pending drains; nothing double-bills —
      compare meter vs events after).

## 10. Team & sessions

- [ ] **10.1 [CORE]** Admin promotes the second user to admin → they see
      Settings; demote → gone again (session updates without re-login, or on
      next request).
- [ ] **10.2 [CORE]** Remove a member → their open session dies on the next
      action (revocation is instant); re-opening the app re-provisions them
      fresh (decide if that's acceptable or needs a block-list before GA).
- [ ] **10.3 [EDGE]** Last admin cannot demote/remove themselves.

## 11. Upgrade & uninstall (N4's drills, consumer-side)

- [ ] **11.1 [CORE]** Publish a patch (any small change) → upgrade the app →
      pipelines keep running, data intact, no re-consent, no re-grants.
- [ ] **11.2 [EDGE]** Deliberately broken setup script in a throwaway patch →
      upgrade fails → the app still runs the previous patch (framework
      rollback). Do this LAST before 11.3.
- [ ] **11.3 [CORE]** **Uninstall**: `DROP APPLICATION <app> CASCADE` → pool,
      warehouse, service gone; no orphaned account-level objects. **Record
      what happens to app-owned export tables in consumer schemas** — if they
      vanish with the app, that's a real data-loss surprise for customers and
      needs either a pre-uninstall export step or explicit docs. This is an
      open product question, not a pass/fail.

## 12. Cosmetics & disclosures sweep (one pass at the end)

- [ ] **12.1** Every error seen during this script was human-readable — no raw
      SQL, no driver codes, no "PRISM_SERVICE" grant SQL shown to a consumer.
- [ ] **12.2** Live pulse / amber "Standardizing…" states appear and clear
      correctly; timestamps humanized; no stale "Last updated" after activity.
- [ ] **12.3** `/terms` and `/privacy` load; copy is the reviewed version (not
      placeholders) before real customers see them.
- [ ] **12.4** The Usage explainer, caller-grant panel copy, and column-mode
      consent (if shipped) say what actually happens — read them as a
      skeptical customer would.

---

**When done:** file every failure verbatim, then reconcile against the N3/N4
exit criteria in `NATIVE_APP_PLAN.md` — this script is a superset of both.
