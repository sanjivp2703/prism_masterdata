// ── Feature Flags ────────────────────────────────────────────────────────────
//
// Active mode is set via the NEXT_PUBLIC_APP_MODE environment variable in
// .env.local.  Change the value and restart the dev server to switch modes.
//
// Valid values:
//   basic    — Ad hoc analysis (default)
//   premium  — Fully automated pipeline with continuous polling and masking
//
// ─────────────────────────────────────────────────────────────────────────────

export type AppMode = 'basic' | 'premium';

export interface AppModeConfig {
  label:       string;
  description: string;
  color:       string;
  bg:          string;
  border:      string;
}

export const APP_MODE_CONFIG: Record<AppMode, AppModeConfig> = {
  basic: {
    label:       'Basic',
    description: 'Ad hoc analysis. Upload a table, create a run, standardize fields, and export. The global classification map is updated on export.',
    color:       '#374151',
    bg:          '#F3F4F6',
    border:      '#E5E7EB',
  },
  premium: {
    label:       'Premium',
    description: 'Automated pipeline. New values are continuously detected, standardized, and written back to the source column via a Snowflake masking policy — no manual step required.',
    color:       '#065F46',
    bg:          '#D1FAE5',
    border:      '#6EE7B7',
  },
};

/**
 * Returns the currently active app mode.
 *
 * Safe to call in both server and client contexts — reads the
 * NEXT_PUBLIC_APP_MODE env var (baked in at build time by Next.js).
 */
export function getAppMode(): AppMode {
  const raw = process.env.NEXT_PUBLIC_APP_MODE ?? '';
  if (raw === 'premium') return 'premium';
  return 'basic';
}

/** Convenience helpers */
export const isBasicMode   = () => getAppMode() === 'basic';
export const isPremiumMode = () => getAppMode() === 'premium';

/**
 * Use at the top of Premium-only API routes. Returns a 403 Response in Basic mode,
 * or null when the request may proceed.
 */
export function premiumModeGuard(): Response | null {
  if (isPremiumMode()) return null;
  return Response.json(
    { error: 'This feature is only available in Premium mode.' },
    { status: 403 },
  );
}
