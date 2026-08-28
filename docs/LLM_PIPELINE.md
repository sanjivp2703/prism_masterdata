# LLM Grouping, Run Lifecycle & Export

Read this before touching grouping, prompts, the referee, or the export write path.

---

## Classification System (Current)

The deterministic scoring pipeline has been replaced with a single LLM call per chunk. Key
principles:

- No metadata generation — no tokenization or importance scoring (the deleted legacy deterministic pipeline). A lightweight matching-only normalization (`PRISM_NORMALIZE`) IS applied to compare/dedup literals; it does not generate stored metadata beyond the `normalized_value` column on `LITERAL_ALIAS_MATCHES`.
- Hash lookup first — literal value match (normalized) against `LITERAL_ALIAS_MATCHES` before any LLM call
- Single JSON blob per run — run state in `RUN_STATE`, one read on page load, one write per sync, optimistic-concurrency `rev` field
- User-first, fail-open export — the user's decisions are written taking precedence

### Legacy code (deleted)

The original deterministic pipeline has been **deleted**: `grouping-phase0.ts`–
`grouping-phase4.ts`, `grouping-pipeline.ts`, `grouping-llm.ts`, `grouping-utils.ts`,
`feature-payload.ts`, `llm-pairscore.ts`, `llm-confidence.ts`, `redis-cache.ts`,
`clique-detection.ts`, and `pairscore.ts` are gone — the last two survive only as type
definitions in `app/api/_lib/grouping-types.ts` (`RunItemForPairing`, `FinalGroup`, …),
which the live LLM grouping flow still consumes. `masking-policy.ts` was also deleted: the
masking feature was never wired into the product — **do not claim Prism supports masking
policies** (the poller's `checkSourceHealth` still *detects* policies on watched columns
purely to skip/pause safely).

---

## Run Lifecycle

### 1. Run creation
1. Insert into `RUNS` with `run_status = 'created'`
2. Distinct-value scan of the source column — **deduped on the normalized form**: `GROUP BY PRISM_NORMALIZE(...)` + `ANY_VALUE(...)` (a representative original), NOT a raw `SELECT DISTINCT`
3. Write skeleton state blob — items populated, groups = [], ungrouped = []

### 2. Auto Group (triggered by button click, not run creation)
1. Read items from state blob — do NOT re-query source table
2. Literal lookup — single hash lookup against `LITERAL_ALIAS_MATCHES` for all items at once (stored `normalized_value` vs `normalizeLiteral` of the item)
3. Lookup chunk — group matched items by alias; `alias_name_source = 'lookup_validated'`, `confidence = 'h'`; skip LLM entirely
4. LLM chunking — unmatched items are **sorted by `normalizeLiteral`** then split into chunks of ≤25 at **first-token boundaries** (`sortAndChunkItems`, backtrack ≤`CHUNK_BOUNDARY_SLACK=7`), so lexical variants of one entity land in the same chunk instead of relying on the merge pass; all chunks sent in parallel (`CHUNK_CONCURRENCY = 20`, env-overridable)
5. Merge pass — deterministic pre-merge of identically-named groups first, then one LLM merge call; lookup names always win (matched on `normalizeLiteral(name)`)
6. Write final state blob (bumping `rev`); update `run_status` to `'running'`; LLM-grouped items are stamped with `initial_alias_name/group_id/confidence` (Case C baseline)

The "EXISTING CANONICAL NAMES" list handed to the LLM = this run's lookup-hit aliases +
**the run's own current group names** (unexported passes / failed-export retries must reuse
them) + top-200 of the spec's aliases by usage + (only when the 200 cap was hit) a
retrieval slice of approved names whose first word matches a batch first word.

Chunks whose LLM call fails even after retries become **honest fallbacks**: self-mapped
singletons with `alias_name_source = 'llm_failed'`, `confidence = 'l'`,
`needs_review = true` — never silently marked high-confidence.

Items the LLM leaves unassigned also become self-mapped `needs_review` singletons (nothing
is ever left unmapped), and **all self-map alias names are made convention-compliant**:
deterministic form rules first (`applyConventionRules`), then one batched name-fix LLM
attempt (`fixNamesForConvention`) for names still violating the regex/constraints (skipped
for `llm_failed` literals — the API is unhealthy right then); still-failing names keep the
deterministic best effort and stay `needs_review`. Literals whose convention-adjusted names
collide share one group.

### 3. User review
State maintained in memory on client; autosave every 30 s; `pagehide` flushes via
`sendBeacon`; `beforeunload` warns on unsaved changes; on a 409 the client refetches the
server blob and replaces its local copy. (Details: docs/DESIGN_SYSTEM.md → State Management.)

### 4. Export — USER-FIRST, FAIL-OPEN
1. Read final state blob
2. Detect Case A / Case B / Case C deviations (no DB writes yet)
3. Mark the run `'validating'` (double-export guard — a run already `'validating'`/`'completed'`/`'failed'` does not re-trigger the write pass; repeat calls return the same counts)
4. **If any cases exist**, the validation LLM would run first — inside the background pass, before the single write — with its keep/revert verdicts baked into that write. **FAIL-OPEN**: on failure the export proceeds with `decisions = null` (every case defaults to keeping the user's change) and `validation_status: 'failed'` is recorded in the state blob after the write. Validation failure never blocks or loses an export. *(Currently the referee is disabled — see below — so this step is always skipped.)*
5. **Write everything in one pass** (`writeAllDecisions`): bulk-upsert grouped items into `LITERAL_ALIAS_MATCHES` (via `alias_id` FK, setting `normalized_value`), upsert alias names into `APPROVED_ALIAS_NAMES`, increment `usage_count`. Bulk MERGEs dedup their source rows on `normalizeLiteral` and are **batched at `EXPORT_MERGE_BATCH = 5000` rows per statement** (Snowflake caps binds at ~65k/statement; the batches are idempotent upserts so partial-failure retries are safe).
6. On successful write → `run_status = 'completed'`. Only a failure of the write itself marks the run `'failed'`.
7. `PIPELINE_QUEUE` cleanup after export is scoped to the run's normalized literals only (never a blanket pipeline-wide delete).

Steps 4–6 normally run in the background after the HTTP response (fire-and-forget); the
wizard's `wait: true` path awaits the write (by construction it has no Case A/B/C, so no
LLM round-trip).

### 5. Export validation LLM (the "referee") — **DISABLED 2026-08-18 (owner decision)**

**The referee no longer runs.** During the client-sim rehearsal the owner watched Case A
revert a deliberate user move (a lookup-confirmed "Boost" dragged into the AT&T group) and
decided the customer's specified mapping must always win — no LLM second-guessing of the
reviewer. Exports now write the user's decisions verbatim, always: the
`EXPORT_REFEREE_ENABLED = false` flag in `runWriteAndValidatePass` (op-export.ts) skips the
whole referee block, `decisions = null` flows into `writeAllDecisions` (the documented
fail-open path), and `VALIDATION_LOG` receives no new rows (table retained, vestigial). The
Case A/B/C detection machinery, prompts, and `initial_*` stamps are retained behind the flag
— re-enabling is a one-line change.

What follows documents the retained machinery as it behaves WHEN enabled. It reviews ONLY
user changes that contradict a trusted baseline:

- **Case A** — user moved a `matched_from_lookup = true` item to a different group
- **Case B** — user renamed a `lookup_validated` alias name
- **Case C** — user moved an item out of a **high-confidence (`h`) initial LLM group** (detected via the `initial_*` item stamps; the initial standardization is trusted like the lookup). The revert target is the initial group's *current* alias when it still exists (legit renames respected).

Does NOT review: accepted automated groupings (trusted); renames of `llm_proposed` groups
(proposing better names is the user's job); ungrouped items (not written to DB).

**The bar is deliberately high**: the system prompt frames the user as a domain expert whose
changes are presumed correct — revert (`'o'`) only when *extremely confident* the change is
a mistake; when torn, keep. The prompt also carries a **SPEC CONTEXT block** (column
name/description, standardization rules, naming-convention requirements — built by
`loadValidationSpecContext`/`buildValidationSystemPrompt`) so verdicts are informed, and
rule violations count as evidence under the same bar. Output is **structurally validated
against exactly what was sent** (unknown literals/aliases ignored; missing verdicts default
to keeping the user's change). All decisions logged to `VALIDATION_LOG` and the debug audit
JSON. `runOpExportDirect` (auto pipelines, no user) skips validation entirely.

---

## LLM Integration

**Model**: `claude-sonnet-4-6` for ALL calls — grouping chunks, merge pass, and validation.
Chunk and merge model IDs are env-overridable via `PRISM_CHUNK_MODEL` / `PRISM_MERGE_MODEL`.

**AI provider**: resolved by `getLlmProviderConfig()` (`_lib/anthropic-key.ts`) →
`{ provider: 'anthropic' | 'openai' | 'gemini', apiKey, model, source }` (`asLlmProvider()`
narrows untrusted strings). Workspace config (`workspace_llm_config` — `provider`,
credential in the legacy-named `anthropic_api_key` column, `model` override; saved on
`/setup` step 4, validated live before saving, encrypted at rest, 10 s cache +
`invalidateAnthropicKeyCache()`) → `ANTHROPIC_API_KEY` env fallback (always provider
`'anthropic'`). `getAnthropicApiKey()` returns the active provider's credential.

**OpenAI-format path (OpenAI + Gemini)**: `callAnthropicWithRetry` is the single dispatch
point — for any non-Anthropic workspace provider it translates the Anthropic-shaped payload
to OpenAI chat-completions format and back (`OPENAI_STYLE_PROVIDERS` map: OpenAI →
`api.openai.com/v1/chat/completions`; Gemini → Google's OpenAI-compat endpoint
`generativelanguage.googleapis.com/v1beta/openai/chat/completions`), so all downstream code
is provider-agnostic; `cache_control` is dropped (prompt caching is Anthropic-only).
Non-Anthropic providers also get a lower chunk concurrency cap
(`NON_ANTHROPIC_CHUNK_CONCURRENCY`, default 3 vs. `CHUNK_CONCURRENCY`'s default 20) and a
longer 429 retry backoff — neither provider's rate limits are as generous as Anthropic's
production tier, and free/low tiers (e.g. Gemini's free tier) are blown through instantly
by 20 simultaneous chunk calls.

Pinned models: `DEFAULT_OPENAI_MODEL` = `gpt-4.1`, `DEFAULT_GEMINI_MODEL` =
`gemini-flash-latest` (Google's maintained current-flash alias — a hard-pinned version
number risks 404ing as "no longer available to new users" the moment Google deprecates it,
as `gemini-2.5-flash` did; env-overridable via `PRISM_OPENAI_MODEL` / `PRISM_GEMINI_MODEL`)
— best structured-JSON fit at the lowest cost tier per provider.

**⚠️ Neither non-Anthropic path has been end-to-end tested against a production-tier
account** (see memory note llm-provider-testing-needed). GitHub Copilot was removed as a
provider option (2026-07-27) — it has no standalone API key of its own; it only re-exposes
OpenAI/other models, so it added no real coverage.

### Prism-provided AI (vendor key)

For clients with no LLM account, Sanjiv sets HIS Anthropic key as `ANTHROPIC_API_KEY` in
that client's deployment at install time — the env-fallback tier exists precisely for this.
The client then sails through `/setup` step 4 ("already configured on the server" → Keep
current setup) and never needs a provider account; if they later get their own, saving it
in step 4 takes precedence instantly (clean graduation, no redeploy).

Operating rules: **one Anthropic Console Workspace per client** with its own key + monthly
spend limit (per-client cost visibility, blast-radius containment, one-key revocation on
churn) — never share one key across clients. Usage bills to Sanjiv, so "AI included"
pricing must assume the client's data volume. This model is **Claude-only by design** — no
env fallback exists for OpenAI/Gemini. Admin-only route: `GET/POST
/api/accounts/llm-provider` (`{provider, credential}`; `{clear:true}` reverts to env;
replaced the old `anthropic-key` route). **New code must never read
`process.env.ANTHROPIC_API_KEY` directly** — all key reads go through `_lib/anthropic-key.ts`.

### Reliability
- Chunk, merge, AND export-validation calls retry **twice with backoff** on 429/5xx and **once** on a parse failure (shared `callAnthropicWithRetry` + `JSON_ONLY_REMINDER`, exported from `llm-one-prompt-grouping.ts`).
- A chunk that still fails after retries degrades to honest `'llm_failed'` singleton fallbacks (confidence `'l'`, `needs_review: true`) — never a silent `'h'`.
- Group confidence is the LLM's real `h`/`m`/`l` band; lookup groups are `'h'`.
- Literal values are JSON-escaped when embedded in prompts; LLM-proposed names are validated (length cap 200 chars, no newlines) before use.
- The merge call uses `max_tokens: 8000`.

---

## Grouping Prompt Content (system prompt, `SYSTEM_PROMPT_TEMPLATE`)

- **Task definition with an operational test**: same real-world entity "written differently — not merely related, similar, or from the same family" — with an explicit announcement that STANDARDIZATION RULES **override** this default (a rule may direct grouping related-but-distinct entities, e.g. subsidiaries under a parent). The merge prompt carries the same override; the rules block itself states it takes precedence over the same-entity test and the bias against grouping.
- **VARIATION TYPES checklist**: 11 transformation classes (acronyms full/partial, word abbreviations/truncations, typos/spelling variants, separators/punctuation, affixes, word order, split/joined words, diacritics, codes/identifiers, rebrands, cross-language), each with a one-line cross-domain example — "check these before leaving a singleton".
- **DO NOT GROUP section** (deferring to rules/DEFINITION): lookalike different entities, ambiguous acronyms → unassigned, parent-vs-subsidiary granularity; plus a worked Country/USSR example.
- **Scoped caution**: bias-against-grouping applies to genuine uncertainty and may never be used to dodge an applicable rule.
- **Per-item payload is minimal**: `literal_value` (JSON-escaped) + `is_pure_acronym` flag only. The old deterministic-pipeline metadata fields (`cleaned_value`, token arrays) still exist on `RunItemForPairing` for `namescore.ts` compatibility but are always empty in live callers and no longer sent to the LLM (`pickBestAliasName` derives its own tokens from the raw literal).
- **Merge representatives are diverse**: each group shows its shortest, longest, and most character-distinct literals (`pickDiverseReps`), not the first three.

---

## Prompt Caching

The system prompt for the grouping chunks is sent with
`cache_control: { type: 'ephemeral' }` on its last block, so the whole system prefix —
including the "EXISTING CANONICAL NAMES" block — is cacheable. That block is **not** just
"the top 200 aliases": it is this run's lookup-hit aliases, then this run's own current
group names, then the top 200 of the spec's aliases by `usage_count`, plus a retrieval
slice when the 200 cap was hit (`op-auto-group-run.ts`).

**What the cache actually buys — corrected three times (LLM-01); read the code, not the
history.** Two earlier versions of this paragraph were both wrong, in opposite directions:
the original claimed all parallel chunks share one cached prefix (false — chunks dispatched
together race the cache WRITE, so none of them reads it); the first correction claimed the
saving lands on the merge pass, the name-fix pass and successive runs over the same spec
(also false — those are different prompts, and that block is not stable).

**What is true:**

- **Within one run, across batches — this is the real saving, and it is the largest one.** Chunks are dispatched in batches of `CHUNK_CONCURRENCY` (20), not in a single `Promise.all`. Batch 1 pays and writes; batches 2..N read it. **Anthropic only.** The benefit therefore *scales with run size*: at 25 items per chunk and 20 chunks per batch, a full 5,000-value drain **of previously-unseen values** is ~200 chunks ≈ 10 batches, so ~90% of chunks hit a warm prefix. Count unmatched items only — values that hash-hit `LITERAL_ALIAS_MATCHES` never reach the LLM, so a queue that is mostly lookup hits produces far fewer chunks and correspondingly less benefit. A run of ≤20 chunks is a single batch and gets nothing at all.
- **On retries.** A retried call re-sends a byte-identical prefix seconds later.
- **Not across runs, in practice.** `existingAliasNames` leads with run-specific content (this run's lookup hits, this run's group names) and the single breakpoint covers the entire block, so any difference at the front voids the whole read. Even the top-200 tail reorders, because export bumps `usage_count` / `last_used_at`. One real exception: when `existingAliasNames` is EMPTY the names block is dropped entirely and the cached prefix is just the base system prompt, which carries nothing run-specific — so two runs on a brand-new spec (no lookup hits, no approved aliases, no existing groups) inside the TTL do share a prefix. That is the first-baseline case, e.g. clicking "Create initial standardizations" twice.
- **Nothing at all on OpenAI or Gemini.** `toOpenAiPayload` flattens the system blocks to one plain string and drops `cache_control`; `fromOpenAiBody` reports `cache_read_input_tokens: 0` unconditionally. On those providers the batching still happens — at `NON_ANTHROPIC_CHUNK_CONCURRENCY` (3), not 20 — but it is purely a rate-limit guard and buys no cache reuse whatsoever. Do not read the batch arithmetic above as applying to them.
- **Not across call types.** The merge call builds its own system text (`buildMergeSystemPrompt`) with its own breakpoint — a separate cache entry, not the chunk one. The name-fix call (`fixNamesForConvention`) sets **no `cache_control` at all** and so participates in caching not at all.
- TTL is the `ephemeral` default (~5 minutes); nothing requests a longer one.

Serializing the first chunk to warm the cache before dispatching the rest is DECLINED
(owner decision) — it adds ~3–5 s to every run. Note the trade is larger than it first
looked: it would warm *all* subsequent batches, not merely help the occasional cold run.

---

## LLM Output Formats

**Grouping chunk prompt:**
```json
{"g":[[[item_indices],"proposed_name","h|m|l"],...],"u":[item_index,...]}
```
- `g` — groups: [item_indices (1-indexed), proposed_name, confidence]
- `u` — flat array of ungrouped item indices
- `h`/`m`/`l` — high/medium/low confidence

**Merge pass prompt:**
```json
{"m":[[[group_indices],"merged_name|null"],...]}
```
No merges needed: `{"m":[]}`

**Export validation prompt:**
```json
{
  "case_a": [{"lv": "literal_value", "k": "u|o"}, ...],
  "case_b": [{"original_alias": "string", "new_alias": "string", "k": "u|o", "apply_to_all": true}],
  "case_c": [{"lv": "literal_value", "k": "u|o"}, ...]
}
```
- `k = 'u'` — keep user's change (the default for missing/malformed verdicts)
- `k = 'o'` — revert to original (requires the model be *extremely confident* it's a mistake)

---

## Merge Name Precedence

- Lookup group + non-lookup group → always use lookup group's alias_name. Lookup-vs-LLM group reconciliation matches names on `normalizeLiteral(name)` (so casing/whitespace variants of the same name collide correctly) — this documented invariant is now true in the live merge path.
- Two lookup groups → **first-seen wins** (audited 2026-08-08, REV-04). This was documented as "the alias with the higher `usage_count`", but no such tie-break exists: the lookup SELECT in `op-auto-group-run.ts` never fetches `usage_count`, and `addToPendingGroup` collapses normalize-equal alias names purely in iteration order. The documented behaviour was aspirational. In practice the case is rare — it needs two DIFFERENT approved alias names that normalize to the same string within one spec (e.g. `AT&T` and `at&t `), which the export's own dedup already works to prevent. Implementing the tie-break would mean fetching `usage_count` in that SELECT and ordering the collapse by it; left as-is deliberately rather than adding a query for a case the data model discourages.
- Two non-lookup groups → LLM proposes merged name

## Group Naming

- The group's alias name comes from the **LLM's `proposed_name`** (its real-world canonical name), threaded through `FinalGroup.proposed_name` (types in `grouping-types.ts`) and carried through the merge pass (`applyMerges` uses the merge LLM's `merged_name`). `pickBestAliasName` (a deterministic pick from the input strings) is only a **fallback** for safety-net singletons or unidentifiable entities.
- The grouping + merge prompts (`llm-one-prompt-grouping.ts`) instruct the model to: identify the real entity and use its commonly-used canonical name (may differ from any input string); prefer the full common name over an acronym (use an acronym only when it genuinely IS the common name — IBM, AT&T); and **FIRST reuse an existing approved alias name verbatim** when a group matches one.
- The spec's existing `APPROVED_ALIAS_NAMES` (top 200 by `usage_count`) are passed into both prompts as the cached "EXISTING CANONICAL NAMES" list so the model snaps new groups onto already-approved names instead of coining near-duplicates.

---

## Performance Targets

- Auto Group to UI results: under 10 seconds for most runs
- LLM chunks run fully in parallel; wall time = slowest single chunk (~3–5 s)
- Hash lookup eliminates LLM calls for all previously seen values
- Blob read/write: one warehouse query per page load, one per sync interval
