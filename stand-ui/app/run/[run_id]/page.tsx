import Link from 'next/link';
import RunReviewClient from './RunReviewClient';

function PrismMark({ size = 32 }: { size?: number }) {
  const h = size;
  const w = Math.round(size * 1.28);
  const cx = w / 2;
  const cy = h / 2;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden="true">
      <polygon points={`0,0 0,${h} ${cx},${cy}`} fill="#1A1A2E" />
      <polygon points={`${w},0 ${w},${h} ${cx},${cy}`} fill="#378ADD" />
      <circle cx={cx} cy={cy} r={size * 0.065} fill="white" />
    </svg>
  );
}

function humanizeDate(val: string | undefined | null): string {
  if (!val) return '—';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return (
      d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) +
      ' · ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    );
  } catch {
    return String(val);
  }
}

function MetaItem({ label, value }: { label: string; value: string | undefined | null }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs" style={{ color: 'var(--text-hint)' }}>{label}</span>
      <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
        {value || '—'}
      </span>
    </div>
  );
}

export default async function RunPage({
  params,
}: {
  params: Promise<{ run_id: string }>;
}) {
  const { run_id } = await params;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runData: any = null;

  try {
    const response = await fetch(`http://localhost:8000/api/run/${run_id}`, { cache: 'no-store' });
    if (response.ok) {
      const result = await response.json();
      runData = result.data;
    }
  } catch {
    // Run data is optional — the client component handles the alias mapping independently.
  }

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: 'var(--page-bg)', padding: 'var(--page-padding-y) var(--page-padding-x)' }}
    >
      <div className="max-w-6xl mx-auto">
        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="mb-8">
          {/* Logo — links back home */}
          <Link href="/home" className="inline-flex items-center gap-2.5 group mb-6">
            <PrismMark size={32} />
            <span
              className="text-lg font-semibold tracking-tight transition-colors"
              style={{ color: 'var(--text-primary)' }}
            >
              Prism
            </span>
          </Link>

          {runData && (
            <>
              {/* Row 1: Concept · Source · Column · Created by */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-1">
                <MetaItem label="Concept" value={runData.CONCEPT_KEY} />
                <MetaItem label="Source" value={runData.SOURCE_RELATION} />
                <MetaItem label="Column" value={runData.SOURCE_COLUMN} />
                <MetaItem label="Created by" value={runData.CREATED_BY_NAME} />
              </div>
              {/* Row 2: Mode · Date */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-1.5">
                <MetaItem label="Mode" value={runData.MODE} />
                <MetaItem label="Date" value={humanizeDate(runData.CREATED_AT)} />
              </div>
            </>
          )}
        </div>

        {/* ── Run review card ─────────────────────────────────────────────── */}
        <RunReviewClient runId={run_id} initialRunStatus={runData?.RUN_STATUS} />
      </div>
    </div>
  );
}
