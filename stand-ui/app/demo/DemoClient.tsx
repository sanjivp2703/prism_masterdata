'use client';

/**
 * Public interactive demo (/demo).
 *
 * A browser-only walk through the product's core loop — choose a column, auto
 * group, review, export, then watch new values get standardized — on invented
 * sample data. It deliberately makes NO network requests: the grouping is the
 * pre-written result in demo-data.ts and all state lives in this component, so
 * the page needs no session, touches no warehouse and spends no AI budget.
 *
 * The review rows mirror RunReviewClient's layout and chip styling so the demo
 * looks like the real screen; it shares no state or code path with it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { DEMO_DATASETS, type DemoDataset, type DemoGroup } from './demo-data';

const WEBSITE_URL = 'https://getprismdata.co/';
const MAX_ALIAS_LENGTH = 200; // same cap as the real review screens
const PREVIEW_ROWS = 8;

type Step = 'pick' | 'grouping' | 'review' | 'exported';

const STEPS: { key: Step; label: string }[] = [
  { key: 'pick',     label: 'Choose a column' },
  { key: 'grouping', label: 'Auto group' },
  { key: 'review',   label: 'Review' },
  { key: 'exported', label: 'Export' },
];

const GROUPING_PHASES = [
  'Checking the lookup for values confirmed before',
  'Grouping the remaining values with AI',
  'Merging groups that describe the same thing',
];

interface Arrival {
  value:  string;
  count:  number;
  name:   string;
  source: 'lookup' | 'ai';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function cloneGroups(groups: DemoGroup[]): DemoGroup[] {
  return groups.map(g => ({ ...g, items: g.items.map(i => ({ ...i })) }));
}

/** Source values in a believable row order: one from each group in turn. */
function interleavedValues(dataset: DemoDataset): string[] {
  const out: string[] = [];
  const longest = Math.max(...dataset.groups.map(g => g.items.length));
  for (let i = 0; i < longest; i++) {
    for (const g of dataset.groups) {
      if (g.items[i]) out.push(g.items[i].value);
    }
  }
  return out;
}

function formatConfidence(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function confidenceColorClass(score: number): string {
  if (score >= 0.9) return 'text-confidence-high';
  if (score >= 0.7) return 'text-confidence-med';
  return 'text-confidence-low';
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// ── Small presentational pieces ──────────────────────────────────────────────

function PrismMark({ size = 30 }: { size?: number }) {
  const h = size;
  const w = Math.round(size * 1.28);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden="true">
      <polygon points={`0,0 0,${h} ${w / 2},${h / 2}`} fill="#1A1A2E" />
      <polygon points={`${w},0 ${w},${h} ${w / 2},${h / 2}`} fill="#378ADD" />
      <circle cx={w / 2} cy={h / 2} r={size * 0.065} fill="white" />
    </svg>
  );
}

function DragDots() {
  return (
    <div
      className="grid gap-[3px]"
      style={{ gridTemplateColumns: 'repeat(2, 3px)', width: 9, height: 15 }}
      aria-hidden="true"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="w-[3px] h-[3px] rounded-full" style={{ backgroundColor: 'var(--border)' }} />
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-card border-[0.5px] ${className}`}
      style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}
    >
      {children}
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-button text-sm font-medium transition-opacity"
      style={{
        backgroundColor: 'var(--accent)',
        color: '#fff',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2 rounded-button border-[0.5px] text-sm font-medium"
      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-secondary)' }}
    >
      {children}
    </button>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wide mb-2" style={{ color: 'var(--text-hint)' }}>
      {children}
    </div>
  );
}

const cellStyle: React.CSSProperties = { borderBottom: '0.5px solid var(--border-subtle)' };

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DemoClient({ showBrand }: { showBrand: boolean }) {
  const [datasetKey, setDatasetKey] = useState(DEMO_DATASETS[0].key);
  const dataset = DEMO_DATASETS.find(d => d.key === datasetKey) ?? DEMO_DATASETS[0];

  const [step, setStep]     = useState<Step>('pick');
  const [phase, setPhase]   = useState(0);
  const [groups, setGroups] = useState<DemoGroup[]>(() => cloneGroups(dataset.groups));
  /** Group ids removed by a rename-merge → the group that absorbed them. */
  const [mergedInto, setMergedInto] = useState<Record<string, string>>({});

  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [dragOverId, setDragOverId]       = useState<string | null>(null);
  const [editingId, setEditingId]         = useState<string | null>(null);
  const [editingValue, setEditingValue]   = useState('');
  const [renameError, setRenameError]     = useState<string | null>(null);

  const [exportTab, setExportTab] = useState<'table' | 'lookup'>('table');
  const [checking, setChecking]   = useState(false);
  const [arrivals, setArrivals]   = useState<Arrival[] | null>(null);

  // Simulated work runs on timers started from click handlers; clear whatever
  // is still pending if the visitor leaves mid-animation.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  function later(fn: () => void, ms: number) {
    timers.current.push(setTimeout(fn, ms));
  }

  const sourceValues = useMemo(() => interleavedValues(dataset), [dataset]);
  const totalRows = useMemo(
    () => dataset.groups.reduce((n, g) => n + g.items.reduce((m, i) => m + i.count, 0), 0),
    [dataset],
  );

  /** value → canonical name, from the groups as the reviewer left them. */
  const mapping = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const it of g.items) m.set(it.value, g.name);
    return m;
  }, [groups]);

  const filledGroups  = groups.filter(g => g.items.length > 0);
  const distinctCount = groups.reduce((n, g) => n + g.items.length, 0);
  const reviewCount   = groups.reduce((n, g) => n + g.items.filter(i => i.needsReview).length, 0);
  const arrivedRows   = (arrivals ?? []).reduce((n, a) => n + a.count, 0);

  // ── Step transitions ───────────────────────────────────────────────────────

  function chooseDataset(key: string) {
    const next = DEMO_DATASETS.find(d => d.key === key);
    if (!next) return;
    setDatasetKey(key);
    setGroups(cloneGroups(next.groups));
    setMergedInto({});
  }

  function runAutoGroup() {
    setStep('grouping');
    setPhase(0);
    later(() => setPhase(1), 700);
    later(() => setPhase(2), 1700);
    later(() => setStep('review'), 2500);
  }

  function startOver() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setGroups(cloneGroups(dataset.groups));
    setMergedInto({});
    setSelectedValue(null);
    setEditingId(null);
    setRenameError(null);
    setArrivals(null);
    setChecking(false);
    setExportTab('table');
    setStep('pick');
  }

  function exportMappings() {
    setSelectedValue(null);
    setEditingId(null);
    setRenameError(null);
    setStep('exported');
  }

  // ── Review edits ───────────────────────────────────────────────────────────

  function moveItem(value: string, toGroupId: string) {
    setGroups(prev => {
      const from = prev.find(g => g.items.some(i => i.value === value));
      if (!from || from.id === toGroupId) return prev;
      const item = from.items.find(i => i.value === value)!;
      return prev.map(g => {
        if (g.id === from.id)   return { ...g, items: g.items.filter(i => i.value !== value) };
        // A value the reviewer placed by hand no longer needs review.
        if (g.id === toGroupId) return { ...g, items: [...g.items, { ...item, needsReview: false }] };
        return g;
      });
    });
    setSelectedValue(null);
  }

  function addGroup() {
    const taken = new Set(groups.map(g => g.name.toLowerCase()));
    let name = 'New group';
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `New group ${n}`;
    const id = `custom-${Date.now()}`;
    setGroups(prev => [{ id, name, items: [] }, ...prev]);
    setEditingId(id);
    setEditingValue(name);
    setRenameError(null);
  }

  function startRename(group: DemoGroup) {
    setEditingId(group.id);
    setEditingValue(group.name);
    setRenameError(null);
  }

  function commitRename(groupId: string) {
    const name = editingValue.trim();
    const current = groups.find(g => g.id === groupId);
    if (!current || !name || name === current.name) { setEditingId(null); setRenameError(null); return; }
    if (name.length > MAX_ALIAS_LENGTH) {
      setRenameError(`Names can be at most ${MAX_ALIAS_LENGTH} characters.`);
      return;
    }
    // Renaming onto an existing name merges the two groups.
    const twin = groups.find(g => g.id !== groupId && g.name.toLowerCase() === name.toLowerCase());
    if (twin) {
      setGroups(prev => prev
        .filter(g => g.id !== groupId)
        .map(g => (g.id === twin.id ? { ...g, items: [...g.items, ...current.items] } : g)));
      setMergedInto(prev => ({ ...prev, [groupId]: twin.id }));
    } else {
      setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, name } : g)));
    }
    setEditingId(null);
    setRenameError(null);
  }

  // ── Simulated pipeline ─────────────────────────────────────────────────────

  function simulateNewData() {
    setChecking(true);
    later(() => {
      const next = cloneGroups(groups);
      const log: Arrival[] = [];
      for (const inc of dataset.incoming) {
        const known = next.find(g => g.items.some(i => i.value === inc.value));
        if (known) {
          log.push({ value: inc.value, count: inc.count, name: known.name, source: 'lookup' });
          continue;
        }
        // Follow rename-merges so the value lands where the reviewer put that group.
        let id = inc.groupId;
        while (mergedInto[id]) id = mergedInto[id];
        const target = next.find(g => g.id === id) ?? next[0];
        target.items.push({ value: inc.value, count: inc.count, confidence: 0.93 });
        log.push({ value: inc.value, count: inc.count, name: target.name, source: 'ai' });
      }
      setGroups(next);
      setArrivals(log);
      setChecking(false);
    }, 1400);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const stepIndex = STEPS.findIndex(s => s.key === step);
  const standardizedColumn = `${dataset.column}_STANDARDIZED`;

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--page-bg)' }}>
      <div className="mx-auto w-full px-4 sm:px-10 pb-16" style={{ maxWidth: 1040, paddingTop: 72 }}>

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            {showBrand && <PrismMark />}
            <h1 className="text-[22px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
              {showBrand ? 'Prism demo' : 'Interactive demo'}
            </h1>
          </div>
          <a
            href={WEBSITE_URL}
            className="text-sm font-medium"
            style={{ color: 'var(--accent-strong)', textDecoration: 'none' }}
          >
            Get Prism for your data →
          </a>
        </div>

        {/* Honesty banner */}
        <div
          className="rounded-card border-[0.5px] px-4 py-3 text-sm mb-6"
          style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent-border)', color: 'var(--accent-strong)' }}
        >
          This demo runs entirely in your browser on made-up sample data. The grouping is
          simulated, and nothing you do here is saved or sent anywhere.
        </div>

        {/* Stepper */}
        <ol className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-6 text-sm">
          {STEPS.map((s, i) => {
            const done = i < stepIndex;
            const active = i === stepIndex;
            return (
              <li key={s.key} className="flex items-center gap-2">
                <span
                  className="inline-flex items-center justify-center rounded-full text-[11px] font-medium"
                  style={{
                    width: 20, height: 20,
                    backgroundColor: active || done ? 'var(--accent)' : 'var(--surface)',
                    color: active || done ? '#fff' : 'var(--text-hint)',
                    border: active || done ? 'none' : '0.5px solid var(--border)',
                  }}
                >
                  {done ? '✓' : i + 1}
                </span>
                <span
                  className={active ? 'font-medium' : ''}
                  style={{ color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}
                >
                  {s.label}
                </span>
              </li>
            );
          })}
        </ol>

        {/* ── Step 1: choose a column ──────────────────────────────────────── */}
        {step === 'pick' && (
          <div className="flex flex-col gap-6">
            <Card>
              <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                Pick a messy column
              </h2>
              <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
                Each sample is a text column where the same thing has been typed many different ways.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                {DEMO_DATASETS.map(d => {
                  const on = d.key === dataset.key;
                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => chooseDataset(d.key)}
                      aria-pressed={on}
                      className="text-left rounded-card px-4 py-3"
                      style={{
                        backgroundColor: on ? 'var(--accent-tint)' : 'var(--surface)',
                        border: on ? '2px solid var(--accent-border)' : '0.5px solid var(--border)',
                        padding: on ? '11px 15px' : undefined,
                      }}
                    >
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{d.label}</div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{d.blurb}</div>
                    </button>
                  );
                })}
              </div>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <Eyebrow>Source table</Eyebrow>
                <div className="text-sm font-mono mb-3" style={{ color: 'var(--text-secondary)' }}>
                  {dataset.tableFqn}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-hint)' }}>
                        <th className="py-2 pr-4 font-medium" style={cellStyle}>Id</th>
                        <th className="py-2 pr-4 font-medium" style={cellStyle}>{dataset.otherColumn.name.toLowerCase()}</th>
                        <th className="py-2 font-medium" style={{ ...cellStyle, color: 'var(--accent-strong)' }}>
                          {dataset.column.toLowerCase()}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sourceValues.slice(0, PREVIEW_ROWS).map((v, i) => (
                        <tr key={v}>
                          <td className="py-2 pr-4" style={{ ...cellStyle, color: 'var(--text-hint)' }}>{1001 + i}</td>
                          <td className="py-2 pr-4" style={{ ...cellStyle, color: 'var(--text-secondary)' }}>
                            {dataset.otherColumn.values[i % dataset.otherColumn.values.length]}
                          </td>
                          <td className="py-2" style={{ ...cellStyle, color: 'var(--text-primary)' }}>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs mt-3" style={{ color: 'var(--text-hint)' }}>
                  {plural(totalRows, 'row', 'rows')} · {plural(sourceValues.length, 'distinct value', 'distinct values')} in this column
                </p>
              </Card>

              <Card>
                <Eyebrow>Column spec</Eyebrow>
                <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
                  You describe the column once, in plain English. Prism groups against this.
                </p>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Description</div>
                <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>{dataset.spec.description}</p>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Standardization rules</div>
                <ul className="text-sm mb-4 list-disc pl-5" style={{ color: 'var(--text-secondary)' }}>
                  {dataset.spec.rules.map(r => <li key={r}>{r}</li>)}
                </ul>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Naming convention</div>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{dataset.spec.convention}</p>
              </Card>
            </div>

            <div>
              <PrimaryButton onClick={runAutoGroup}>Auto group this column</PrimaryButton>
            </div>
          </div>
        )}

        {/* ── Step 2: simulated grouping ───────────────────────────────────── */}
        {step === 'grouping' && (
          <Card>
            <h2 className="text-base font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
              Grouping {plural(sourceValues.length, 'distinct value', 'distinct values')}
            </h2>
            <ul className="flex flex-col gap-3" aria-live="polite">
              {GROUPING_PHASES.map((label, i) => (
                <li key={label} className="flex items-center gap-3 text-sm">
                  <span
                    className="inline-flex items-center justify-center w-4 h-4"
                    style={{ color: i < phase ? 'var(--confidence-high)' : 'var(--accent)' }}
                  >
                    {i < phase ? '✓' : i === phase ? <Spinner /> : null}
                  </span>
                  <span style={{ color: i <= phase ? 'var(--text-secondary)' : 'var(--text-hint)' }}>{label}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* ── Step 3: review ───────────────────────────────────────────────── */}
        {step === 'review' && (
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Review the proposed groups
                </h2>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                  {plural(distinctCount, 'value', 'values')} in {plural(filledGroups.length, 'group', 'groups')}
                  {reviewCount > 0 && <> · {plural(reviewCount, 'value needs', 'values need')} a look</>}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <SecondaryButton onClick={addGroup}>Add a group</SecondaryButton>
                <PrimaryButton onClick={exportMappings}>Export</PrimaryButton>
              </div>
            </div>

            <p className="text-xs mb-3" style={{ color: 'var(--text-hint)' }}>
              Drag a value onto another group to move it — or tap a value, then tap the group it belongs in.
              Double-click a name to rename it. Yellow values are ones the AI was unsure about.
            </p>

            {selectedValue && (
              <div
                className="rounded-button border-[0.5px] px-3 py-2 text-xs mb-3"
                style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent-border)', color: 'var(--accent-strong)' }}
              >
                Moving &ldquo;{selectedValue}&rdquo; — choose the group it belongs in.{' '}
                <button type="button" onClick={() => setSelectedValue(null)} className="underline">Cancel</button>
              </div>
            )}
            {renameError && (
              <div
                className="rounded-button border-[0.5px] px-3 py-2 text-xs mb-3"
                style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
              >
                {renameError}
              </div>
            )}

            <div className="flex flex-col gap-1">
              {groups.map(group => {
                const isDragOver = dragOverId === group.id;
                const isTarget = isDragOver || (selectedValue !== null && !group.items.some(i => i.value === selectedValue));
                return (
                  <div
                    key={group.id}
                    className="grid items-start py-[13px] rounded-row transition-colors"
                    style={{
                      gridTemplateColumns: '28px minmax(110px, 170px) 1fr',
                      cursor: selectedValue !== null && isTarget ? 'pointer' : undefined,
                      ...(isDragOver
                        ? { backgroundColor: 'var(--accent-tint)', borderLeft: '2px solid var(--accent)' }
                        : { borderLeft: '2px solid transparent' }),
                    }}
                    onDragOver={(e) => { e.preventDefault(); setDragOverId(group.id); }}
                    onDragLeave={() => setDragOverId(prev => (prev === group.id ? null : prev))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverId(null);
                      const value = e.dataTransfer.getData('text/plain');
                      if (value) moveItem(value, group.id);
                    }}
                    onClick={() => { if (selectedValue !== null) moveItem(selectedValue, group.id); }}
                  >
                    <div className="flex justify-center pt-1.5"><DragDots /></div>

                    <div
                      className="px-2 text-sm"
                      onDoubleClick={() => startRename(group)}
                      title={editingId !== group.id ? 'Double-click to rename' : undefined}
                    >
                      {editingId === group.id ? (
                        <input
                          autoFocus
                          value={editingValue}
                          aria-label="Group name"
                          onChange={(e) => setEditingValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={() => commitRename(group.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(group.id);
                            if (e.key === 'Escape') { setEditingId(null); setRenameError(null); }
                          }}
                          className="w-full px-2 py-1 text-sm rounded-button border-[0.5px] outline-none"
                          style={{ borderColor: 'var(--accent)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
                        />
                      ) : (
                        <span className="font-semibold break-words" style={{ color: 'var(--text-primary)' }}>
                          {group.name}
                        </span>
                      )}
                    </div>

                    <div className="px-2">
                      {group.items.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {group.items.map(it => {
                            const selected = selectedValue === it.value;
                            return (
                              <button
                                key={it.value}
                                type="button"
                                draggable
                                aria-pressed={selected}
                                onDragStart={(e) => {
                                  e.dataTransfer.setData('text/plain', it.value);
                                  e.dataTransfer.effectAllowed = 'move';
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedValue(selected ? null : it.value);
                                }}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill cursor-move text-xs"
                                style={{
                                  ...(it.needsReview
                                    ? { backgroundColor: '#FEF9C3', border: '0.5px solid #FDE047', color: '#713F12' }
                                    : { backgroundColor: 'var(--border-subtle)', border: '0.5px solid var(--border)', color: 'var(--text-secondary)' }),
                                  ...(selected ? { outline: '2px solid var(--accent)', outlineOffset: 1 } : {}),
                                }}
                              >
                                {it.value}
                                <span className={`text-[10px] font-medium ${confidenceColorClass(it.confidence)}`}>
                                  {formatConfidence(it.confidence)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-xs italic" style={{ color: 'var(--text-hint)' }}>No items yet</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* ── Step 4: export + automated pipeline ──────────────────────────── */}
        {step === 'exported' && (
          <div className="flex flex-col gap-6">
            <Card>
              <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                {plural(distinctCount, 'messy value', 'messy values')} → {plural(filledGroups.length, 'standard name', 'standard names')}
              </h2>
              <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
                In the real product this is written to your warehouse: a lookup table of confirmed
                mappings, and a standardized copy of the table with one extra column.
              </p>

              <div
                className="inline-flex p-0.5 rounded-button border-[0.5px] mb-4"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--border-subtle)' }}
              >
                {([['table', 'Standardized table'], ['lookup', 'Lookup table']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setExportTab(key)}
                    aria-pressed={exportTab === key}
                    className="px-3 py-1.5 rounded-toggle-option text-sm font-medium"
                    style={exportTab === key
                      ? { backgroundColor: 'var(--surface)', color: 'var(--text-primary)', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }
                      : { color: 'var(--text-muted)' }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="overflow-x-auto">
                {exportTab === 'table' ? (
                  <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-hint)' }}>
                        <th className="py-2 pr-4 font-medium" style={cellStyle}>Id</th>
                        <th className="py-2 pr-4 font-medium" style={cellStyle}>{dataset.column.toLowerCase()}</th>
                        <th className="py-2 font-medium" style={{ ...cellStyle, color: 'var(--accent-strong)' }}>
                          {standardizedColumn.toLowerCase()}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(arrivals ?? []).map((a, i) => (
                        <tr key={`new-${a.value}`} style={{ backgroundColor: 'var(--accent-tint)' }}>
                          <td className="py-2 pr-4 pl-2" style={{ ...cellStyle, color: 'var(--text-hint)' }}>
                            {1001 + totalRows + i}
                          </td>
                          <td className="py-2 pr-4" style={{ ...cellStyle, color: 'var(--text-secondary)' }}>
                            {a.value}
                            <span
                              className="ml-2 px-1.5 py-0.5 rounded-pill text-[10px] font-medium"
                              style={{ backgroundColor: 'var(--surface)', border: '0.5px solid var(--accent-border)', color: 'var(--accent-strong)' }}
                            >
                              New
                            </span>
                          </td>
                          <td className="py-2 font-medium" style={{ ...cellStyle, color: 'var(--text-primary)' }}>{a.name}</td>
                        </tr>
                      ))}
                      {sourceValues.slice(0, PREVIEW_ROWS).map((v, i) => (
                        <tr key={v}>
                          <td className="py-2 pr-4 pl-2" style={{ ...cellStyle, color: 'var(--text-hint)' }}>{1001 + i}</td>
                          <td className="py-2 pr-4" style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{v}</td>
                          <td className="py-2 font-medium" style={{ ...cellStyle, color: 'var(--text-primary)' }}>
                            {mapping.get(v) ?? v}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-hint)' }}>
                        <th className="py-2 pr-4 font-medium" style={cellStyle}>Standard name</th>
                        <th className="py-2 font-medium" style={cellStyle}>Values that map to it</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filledGroups.map(g => (
                        <tr key={g.id}>
                          <td className="py-2 pr-4 font-medium align-top" style={{ ...cellStyle, color: 'var(--text-primary)' }}>
                            {g.name}
                          </td>
                          <td className="py-2" style={{ ...cellStyle, color: 'var(--text-secondary)' }}>
                            {g.items.map(i => i.value).join(' · ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {exportTab === 'table' && (
                <p className="text-xs mt-3" style={{ color: 'var(--text-hint)' }}>
                  Showing {PREVIEW_ROWS + (arrivals?.length ?? 0)} of {plural(totalRows + arrivedRows, 'row', 'rows')}.
                  Your original column is never changed.
                </p>
              )}
            </Card>

            <Card>
              <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                Then it runs on its own
              </h2>
              <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
                Prism watches the source table. Values it has seen before are matched instantly from the
                lookup; only genuinely new ones go to the AI. Try it — add some new rows to the source.
              </p>

              {arrivals === null ? (
                <PrimaryButton onClick={simulateNewData} disabled={checking}>
                  {checking ? <><Spinner /> Standardizing new rows</> : 'Simulate new data arriving'}
                </PrimaryButton>
              ) : (
                <>
                  <ul className="flex flex-col" aria-live="polite">
                    {arrivals.map(a => (
                      <li
                        key={a.value}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                        style={cellStyle}
                      >
                        <span style={{ color: 'var(--text-secondary)' }}>{a.value}</span>
                        <span style={{ color: 'var(--text-hint)' }}>→</span>
                        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{a.name}</span>
                        <span
                          className="px-2 py-0.5 rounded-pill text-[11px] font-medium"
                          style={a.source === 'lookup'
                            ? { backgroundColor: 'var(--border-subtle)', border: '0.5px solid var(--border)', color: 'var(--text-muted)' }
                            : { backgroundColor: 'var(--accent-tint)', border: '0.5px solid var(--accent-border)', color: 'var(--accent-strong)' }}
                        >
                          {a.source === 'lookup' ? 'Matched from lookup' : 'New value · grouped by AI'}
                        </span>
                        <span className="text-xs" style={{ color: 'var(--text-hint)' }}>{plural(a.count, 'row', 'rows')}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs mt-3" style={{ color: 'var(--text-hint)' }}>
                    {plural(arrivedRows, 'new row', 'new rows')} standardized — no one had to review anything.
                    The table above now includes them.
                  </p>
                </>
              )}
            </Card>

            <div className="flex flex-wrap items-center gap-3">
              <SecondaryButton onClick={() => setStep('review')}>Back to review</SecondaryButton>
              <SecondaryButton onClick={startOver}>Try another column</SecondaryButton>
              <a
                href={WEBSITE_URL}
                className="px-4 py-2 rounded-button text-sm font-medium"
                style={{ backgroundColor: 'var(--accent)', color: '#fff', textDecoration: 'none' }}
              >
                Get Prism for your data
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
