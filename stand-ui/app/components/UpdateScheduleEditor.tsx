'use client';

/**
 * Update time window editor — shared by the new-pipeline connect form and the
 * pipeline card's Settings tab. Three choices:
 *
 *   • Time window (default Mon–Fri, 9 AM–5 PM) — days + start/end hours editable
 *   • 24/7 — auto-update around the clock
 *   • Manual only — never auto-update; the owner triggers standardization
 *
 * Times are captured in the editor's browser timezone (IANA name stored on the
 * schedule) so the server evaluates the window in the user's local time.
 */

import { useState } from 'react';
import {
  DEFAULT_UPDATE_SCHEDULE,
  type UpdateSchedule,
  type UpdateScheduleType,
  type WindowSchedule,
} from '@/app/api/_lib/update-schedule';

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function browserTimezone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
  catch { return undefined; }
}

function hourLabel(h: number): string {
  const wrapped = h % 24;
  if (wrapped === 0) return '12 AM';
  if (wrapped === 12) return '12 PM';
  return wrapped < 12 ? `${wrapped} AM` : `${wrapped - 12} PM`;
}

export const SCHEDULE_TYPE_HELP: Record<UpdateScheduleType, string> = {
  window: 'New values are standardized and exported every 10 minutes during this window. Values that arrive outside it queue up and go out when the window opens.',
  always: 'New values are standardized and exported every 10 minutes, around the clock.',
  manual: 'Prism never updates on its own. New values queue up until you trigger standardization and approve the results.',
};

interface Props {
  value:     UpdateSchedule;
  onChange:  (s: UpdateSchedule) => void;
  disabled?: boolean;
}

export default function UpdateScheduleEditor({ value, onChange, disabled }: Props) {
  // Remember the last window config so toggling away and back doesn't lose it.
  const [lastWindow, setLastWindow] = useState<WindowSchedule>(
    value.type === 'window' ? value : { ...DEFAULT_UPDATE_SCHEDULE, timezone: browserTimezone() },
  );

  function selectType(type: UpdateScheduleType) {
    if (type === value.type) return;
    if (type === 'window') onChange({ ...lastWindow, timezone: lastWindow.timezone ?? browserTimezone() });
    else onChange({ type });
  }

  function patchWindow(patch: Partial<WindowSchedule>) {
    if (value.type !== 'window') return;
    const next: WindowSchedule = { ...value, ...patch, timezone: value.timezone ?? browserTimezone() };
    setLastWindow(next);
    onChange(next);
  }

  function toggleDay(d: number) {
    if (value.type !== 'window') return;
    const days = value.days.includes(d)
      ? value.days.filter(x => x !== d)
      : [...value.days, d].sort();
    if (days.length === 0) return; // a window needs at least one day
    patchWindow({ days });
  }

  const win = value.type === 'window' ? value : null;

  return (
    <div>
      <div
        className="inline-flex rounded-button overflow-hidden border-[0.5px] w-full"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}
      >
        {([
          { id: 'window', label: 'Time window' },
          { id: 'always', label: '24/7' },
          { id: 'manual', label: 'Manual only' },
        ] as const).map(({ id, label }, i) => (
          <button
            key={id}
            type="button"
            onClick={() => selectType(id)}
            disabled={disabled}
            className="flex-1 py-2 text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              backgroundColor: value.type === id ? 'var(--accent)' : 'transparent',
              color:           value.type === id ? 'white' : 'var(--text-muted)',
              borderRight:     i < 2 ? '0.5px solid var(--border)' : undefined,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-hint)' }}>
        {SCHEDULE_TYPE_HELP[value.type]}
      </p>

      {win && (
        <div
          className="mt-2 rounded-button border-[0.5px] px-3 py-2.5"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}
        >
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {/* Days of week */}
            <div className="flex items-center gap-1">
              {DAY_LETTERS.map((letter, d) => {
                const on = win.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(d)}
                    disabled={disabled}
                    title={DAY_NAMES[d]}
                    aria-pressed={on}
                    className="w-6 h-6 text-[11px] font-medium rounded-button border-[0.5px] transition-colors disabled:opacity-50"
                    style={{
                      borderColor:     on ? 'var(--accent-border)' : 'var(--border)',
                      backgroundColor: on ? 'var(--accent-tint)' : 'transparent',
                      color:           on ? 'var(--accent-strong)' : 'var(--text-hint)',
                    }}
                  >
                    {letter}
                  </button>
                );
              })}
            </div>

            {/* Hours */}
            <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <select
                value={win.start_hour}
                onChange={e => patchWindow({ start_hour: Number(e.target.value) })}
                disabled={disabled}
                className="text-xs px-1.5 py-1 rounded-button border-[0.5px] outline-none disabled:opacity-50"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h} disabled={h === win.end_hour}>{hourLabel(h)}</option>
                ))}
              </select>
              <span style={{ color: 'var(--text-muted)' }}>to</span>
              <select
                value={win.end_hour}
                onChange={e => patchWindow({ end_hour: Number(e.target.value) })}
                disabled={disabled}
                className="text-xs px-1.5 py-1 rounded-button border-[0.5px] outline-none disabled:opacity-50"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
              >
                {Array.from({ length: 24 }, (_, i) => i + 1).map(h => (
                  <option key={h} value={h} disabled={h === win.start_hour}>{hourLabel(h)}</option>
                ))}
              </select>
            </div>
          </div>

          {win.timezone && (
            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
              Times are in your timezone ({win.timezone.replace(/_/g, ' ')}).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
