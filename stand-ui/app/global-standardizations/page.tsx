import GlobalStandardizationsClient from './GlobalStandardizationsClient';

export default async function GlobalStandardizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ domain_id?: string }>;
}) {
  const { domain_id } = await searchParams;
  const domainId = domain_id ? Number(domain_id) : null;

  return (
    <div
      className="min-h-screen"
      style={{
        backgroundColor: 'var(--page-bg)',
        padding: 'var(--page-padding-y) var(--page-padding-x)',
        paddingTop: 'calc(var(--page-padding-y) + 44px)',
      }}
    >
      <div className="mx-auto max-w-6xl">
        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="mb-8">
          <div className="text-xs font-bold tracking-wider uppercase mb-1" style={{ color: '#6366F1' }}>
            Domain Library
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Domain Standardizations
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)', maxWidth: 520 }}>
            Canonical alias–to–raw-value mappings for this domain. Edit
            groupings here, then export — changes are written directly to the
            database without LLM validation.
          </p>
        </div>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <GlobalStandardizationsClient domainId={domainId} />
      </div>
    </div>
  );
}
