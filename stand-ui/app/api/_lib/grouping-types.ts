// ---------------------------------------------------------------------------
// Shared grouping types
//
// These types survived the removal of the legacy deterministic grouping
// pipeline (clique-detection.ts, pairscore.ts). They describe the shape of
// run items fed into the LLM grouping flow and the final group objects it
// produces.
// ---------------------------------------------------------------------------

/** A run item as consumed by the grouping flow. */
export interface RunItemForPairing {
  run_item_id: number;
  /** Original source string (used for not_all_caps_penalty). */
  literal_value: string;
  /** Output of pre-tokenization cleaning pass. */
  cleaned_value: string | null;
  /** Output of full normalization pass. */
  normalization_value: string | null;
  /** Standard (pre-normalization) tokens. */
  std_tokens: string[];
  /** Normalized tokens. */
  norm_tokens: string[];
}

/** Final group representation produced by the grouping flow. */
export interface FinalGroup {
  temp_group_id: string;
  member_ids: number[];
  /** true when this group contains exactly one item (a former singleton). */
  is_singleton: boolean;
  /** LLM-proposed canonical (real-world) name for the group, if any. */
  proposed_name?: string | null;
  anchor_member_ids: number[];
  absorbed_member_ids: number[];
  merged_from_group_ids: string[];
  avg_internal_score: number;
  min_internal_score: number;
}
