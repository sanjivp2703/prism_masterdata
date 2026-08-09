import RunReviewClient from './RunReviewClient';
import { getRunHeader } from '@/app/api/_lib/run-header';
import { sanitizeConventionRules, hasAnyRule } from '@/app/api/_lib/convention-rules';

export default async function RunPage({
  params,
}: {
  params: Promise<{ run_id: string }>;
}) {
  const { run_id } = await params;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runData: any = null;

  try {
    runData = await getRunHeader(run_id);
  } catch {
    // Run data is optional — the client component handles the alias mapping independently.
  }

  // Deterministic naming convention for the run's column spec (regex pattern and/or
  // structured form rules) — used to validate user renames in the review UI.
  let convention: { type: string | null; value: string; rules: ReturnType<typeof sanitizeConventionRules> | null } | null = null;
  if (runData) {
    let rules: ReturnType<typeof sanitizeConventionRules> | null = null;
    try {
      const parsed = runData.convention_rules ? JSON.parse(String(runData.convention_rules)) : null;
      const sanitized = sanitizeConventionRules(parsed);
      if (hasAnyRule(sanitized)) rules = sanitized;
    } catch { /* malformed rules JSON → no rule enforcement */ }
    const type  = runData.convention_type ? String(runData.convention_type) : null;
    const value = runData.convention_value ? String(runData.convention_value) : '';
    // Pass the convention through for EVERY type that has content, not just the
    // enforceable ones. `examples` and `natural` cannot be mechanically checked,
    // but the reviewer should still SEE the contract they are renaming under —
    // previously they got nothing at all for those two types (SPEC-04).
    //
    // Safe to widen: the client's rename guard only blocks on structured rules
    // or type === 'regex', so a non-enforceable convention arrives as display
    // context and cannot start rejecting valid renames.
    if (rules || (type && value.trim())) {
      convention = { type, value, rules };
    }
  }

  // The column spec's free-text standardization rules — shown to the reviewer so
  // they can see the contract they're reviewing under (not enforced client-side).
  let standardizationRules: string[] = [];
  let domainName = '';
  if (runData) {
    // The column name is the "concept" now; it titles the rules panel.
    domainName = runData.column_name ? String(runData.column_name) : '';
    try {
      const parsed = runData.standardization_rules ? JSON.parse(String(runData.standardization_rules)) : null;
      if (Array.isArray(parsed)) standardizationRules = parsed.map(String).filter(Boolean);
    } catch { /* malformed rules JSON → no panel */ }
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--page-bg)' }}>
      <RunReviewClient
        runId={run_id}
        initialRunStatus={runData?.RUN_STATUS}
        sourceRelation={runData?.SOURCE_RELATION}
        sourceColumn={runData?.SOURCE_COLUMN}
        convention={convention}
        standardizationRules={standardizationRules}
        domainName={domainName}
      />
    </div>
  );
}
