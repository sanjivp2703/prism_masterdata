/**
 * Pipeline update time windows ("update schedule").
 *
 * Replaces the old auto/manual pipeline mode. Every pipeline carries an
 * `update_schedule` describing WHEN Prism may auto-standardize new values and
 * push them into the export table:
 *
 *   • { type: 'window', days, start_hour, end_hour, timezone? }
 *       — auto-update only inside the window (default: Mon–Fri, 9 AM–5 PM)
 *   • { type: 'always' }  — auto-update around the clock (the old 'auto' mode)
 *   • { type: 'manual' }  — never auto-update; the owner triggers
 *       standardization explicitly (the old 'manual' mode)
 *
 * Outside the window (and always for 'manual'), the poller still detects and
 * queues new values, still handles deletes, and still shows unmapped values in
 * the export in raw form — only the LLM standardization is held.
 *
 * Pure module — no 'server-only' — shared by the poller/routes (evaluation)
 * and the UI (labels, option pickers).
 */

/** Days use JS Date#getDay() encoding: 0 = Sunday … 6 = Saturday. */
export interface WindowSchedule {
  type: 'window';
  days: number[];
  /** Hour the window opens, 0–23, inclusive, local to `timezone`. */
  start_hour: number;
  /** Hour the window closes, 1–24, exclusive (17 ⇒ updates stop at 5:00 PM). */
  end_hour: number;
  /**
   * IANA timezone the hours are evaluated in (e.g. "America/New_York"),
   * captured from the creator's browser. Missing/invalid → server timezone.
   */
  timezone?: string;
}

export type UpdateSchedule =
  | { type: 'always' }
  | { type: 'manual' }
  | WindowSchedule;

export type UpdateScheduleType = UpdateSchedule['type'];

/** The creation default: business hours, Mon–Fri 9 AM–5 PM. */
export const DEFAULT_UPDATE_SCHEDULE: WindowSchedule = {
  type: 'window',
  days: [1, 2, 3, 4, 5],
  start_hour: 9,
  end_hour: 17,
};

/**
 * Strict validator for API input. Returns a normalized schedule, or null when
 * the value isn't a recognizable schedule (callers 400 or fall back).
 */
export function asUpdateSchedule(v: unknown): UpdateSchedule | null {
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.type === 'always') return { type: 'always' };
  if (o.type === 'manual') return { type: 'manual' };
  if (o.type !== 'window') return null;

  const days = Array.isArray(o.days)
    ? Array.from(new Set(o.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))).sort()
    : [];
  const start = Number(o.start_hour);
  const end   = Number(o.end_hour);
  if (days.length === 0) return null;
  if (!Number.isInteger(start) || start < 0 || start > 23) return null;
  if (!Number.isInteger(end)   || end   < 1 || end   > 24) return null;
  if (start === end) return null;

  const schedule: WindowSchedule = { type: 'window', days, start_hour: start, end_hour: end };
  if (typeof o.timezone === 'string' && o.timezone.trim()) {
    schedule.timezone = o.timezone.trim();
  }
  return schedule;
}

/**
 * Tolerant parse of the stored `pipelines.update_schedule` column. Anything
 * unreadable falls back to the default window — never throws.
 */
export function parseStoredSchedule(raw: unknown): UpdateSchedule {
  return asUpdateSchedule(raw) ?? DEFAULT_UPDATE_SCHEDULE;
}

/** JSON string for the SQLite TEXT column. */
export function serializeUpdateSchedule(s: UpdateSchedule): string {
  return JSON.stringify(s);
}

/** Local day-of-week + hour for `now` in the given timezone (server tz on failure). */
function localDayHour(now: Date, timezone?: string): { day: number; hour: number } {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        hour: 'numeric',
        hourCycle: 'h23',
      }).formatToParts(now);
      const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
      const hourStr = parts.find(p => p.type === 'hour')?.value ?? '';
      const day  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
      const hour = Number(hourStr);
      if (day >= 0 && Number.isFinite(hour)) return { day, hour };
    } catch {
      // Unknown timezone string — fall through to server time.
    }
  }
  return { day: now.getDay(), hour: now.getHours() };
}

/**
 * Whether the schedule allows an automatic update right now.
 * 'always' → true; 'manual' → false; 'window' → day + hour check in the
 * schedule's timezone. An inverted window (start > end, e.g. 22→6) is treated
 * as overnight and wraps past midnight.
 */
export function isScheduleActiveNow(schedule: UpdateSchedule, now: Date = new Date()): boolean {
  if (schedule.type === 'always') return true;
  if (schedule.type === 'manual') return false;
  const { day, hour } = localDayHour(now, schedule.timezone);
  if (!schedule.days.includes(day)) return false;
  return schedule.start_hour < schedule.end_hour
    ? hour >= schedule.start_hour && hour < schedule.end_hour
    : hour >= schedule.start_hour || hour < schedule.end_hour;
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatHour(h: number): string {
  const wrapped = h % 24;
  if (wrapped === 0) return '12 AM';
  if (wrapped === 12) return '12 PM';
  return wrapped < 12 ? `${wrapped} AM` : `${wrapped - 12} PM`;
}

function formatDays(days: number[]): string {
  const sorted = Array.from(new Set(days)).sort();
  if (sorted.length === 7) return 'Every day';
  // Collapse a consecutive run (Mon–Fri) into a range label.
  const isRun = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (isRun && sorted.length > 2) return `${DAY_SHORT[sorted[0]]}–${DAY_SHORT[sorted[sorted.length - 1]]}`;
  return sorted.map(d => DAY_SHORT[d]).join(', ');
}

/** Short human label, e.g. "Mon–Fri, 9 AM–5 PM" / "24/7" / "Manual only". */
export function scheduleLabel(s: UpdateSchedule): string {
  if (s.type === 'always') return '24/7';
  if (s.type === 'manual') return 'Manual only';
  return `${formatDays(s.days)}, ${formatHour(s.start_hour)}–${formatHour(s.end_hour)}`;
}
