import Link from 'next/link';
import GlobalStandardizationsClient from './GlobalStandardizationsClient';

function PrismMark({ size = 32 }: { size?: number }) {
  const h  = size;
  const w  = Math.round(size * 1.28);
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

export default function GlobalStandardizationsPage() {
  return (
    <div
      className="min-h-screen"
      style={{
        backgroundColor: 'var(--page-bg)',
        padding: 'var(--page-padding-y) var(--page-padding-x)',
      }}
    >
      <div className="mx-auto max-w-6xl">
        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="mb-8">
          {/* Logo — links back home, same pattern as run page */}
          <Link href="/home" className="inline-flex items-center gap-2.5 group mb-6">
            <PrismMark size={32} />
            <span
              className="text-lg font-semibold tracking-tight transition-colors"
              style={{ color: 'var(--text-primary)' }}
            >
              Prism
            </span>
          </Link>

          <div className="text-xs font-bold tracking-wider uppercase mb-1" style={{ color: '#6366F1' }}>
            Global Library
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Global Standardizations
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)', maxWidth: 520 }}>
            Canonical alias–to–raw-value mappings used across all runs. Edit
            groupings here, then export — changes are written directly to the
            database without LLM validation.
          </p>
        </div>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <GlobalStandardizationsClient />
      </div>
    </div>
  );
}
