export interface Domain {
  domain_id:             number;
  name:                  string;
  description:           string | null;
  standardization_rules: string | null;  // JSON array of free-text rule strings
  convention_type:       string | null;  // null | 'regex' | 'examples' | 'natural'
  convention_value:      string | null;
  convention_rules:      string | null;  // JSON of structured naming rules
  usage_count:           number;
  last_used_at:          string | null;
  created_at:            string | null;
}
