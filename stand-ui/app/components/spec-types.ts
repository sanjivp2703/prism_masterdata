/**
 * Per-column standardization spec — the replacement for domains. Mirrors the
 * `column_specs` SQLite row (see app/api/_lib/column-specs.ts). `spec_id` is the
 * column's lookup scope; it lives in the pipeline's historical `domain_id` slot.
 */
export interface ColumnSpec {
  spec_id:               number;
  pipeline_id:           number | null;
  table_fqn:             string | null;
  column_name:           string;
  description:           string;
  standardization_rules: string | null;  // JSON array of free-text rule strings
  convention_type:       string | null;  // null | 'regex' | 'examples' | 'natural'
  convention_value:      string | null;
  convention_rules:      string | null;  // JSON of structured naming rules
  created_at:            string | null;
  updated_at:            string | null;
}
