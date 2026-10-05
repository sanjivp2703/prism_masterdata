/**
 * Export-kind parsing + standardized-column naming — a pure module (no
 * `server-only`) shared by API routes, the poller/tick processors, and the UI.
 *
 * The four output options a pipeline can have:
 *   'table'  — materialized copy of the source, rebuilt after each pass
 *   'view'   — live warehouse view, created once (Snowflake only)
 *   'column' — standardized values written into a `<col>_STANDARDIZED`
 *              companion column added to the SOURCE table itself (NULL until
 *              the raw value is standardized). Column-mode pipelines store
 *              export_table_fqn = table_fqn (the source table IS the export
 *              destination) so every existing rebuild trigger, the
 *              once-per-table rebuild dedup, and UI card grouping work
 *              unchanged.
 *   (a fourth UI option, "Lookup table", is represented as
 *   export_table_fqn = NULL — no export object at all, kind irrelevant)
 */
export type ExportKind = 'table' | 'view' | 'column';

/** Narrow an untrusted value to an ExportKind (unknown → 'table'). */
export function asExportKind(v: unknown): ExportKind {
  return v === 'view' || v === 'column' ? v : 'table';
}

/**
 * Name of the standardized companion column maintained in 'column' mode.
 * Both warehouse implementations MUST use this — it is also what the UI
 * shows the user, and what the setup copy promises.
 */
export function standardizedColumnName(sourceColumn: string): string {
  return `${sourceColumn}_STANDARDIZED`;
}

/**
 * GUARDRAIL — column mode's core promise is that Prism NEVER modifies the
 * customer's own columns; the only writable target is a Prism-created
 * `<col>_STANDARDIZED` companion. Every column-mode write path (both
 * warehouses) MUST call this immediately before building its ALTER/UPDATE
 * statements, passing the exact identifier about to be used as the write
 * target plus every watched (raw) column on the table. It throws — aborting
 * the sync before any SQL runs — unless the target (a) is exactly what
 * standardizedColumnName() produces for a watched column, and (b) does not
 * collide with any watched raw column. Pure + parity-tested; do not weaken
 * without updating docs/internal/PRELAUNCH_CHECKLIST.md.
 */
export function assertCompanionColumnSafe(
  writeTarget:       string,
  watchedRawColumns: string[],
): void {
  const expected = new Set(watchedRawColumns.map(c => standardizedColumnName(c).toUpperCase()));
  const target   = writeTarget.toUpperCase();
  if (!expected.has(target)) {
    throw new Error(
      `[Guardrail] Refusing to write to column "${writeTarget}" — it is not the ` +
      `standardized companion of any watched column. Prism only ever writes ` +
      `<column>_STANDARDIZED companion columns it created.`,
    );
  }
  for (const raw of watchedRawColumns) {
    if (raw.toUpperCase() === target) {
      throw new Error(
        `[Guardrail] Refusing to write to "${writeTarget}" — it is a watched source ` +
        `column. Prism never modifies the customer's own columns.`,
      );
    }
  }
}
