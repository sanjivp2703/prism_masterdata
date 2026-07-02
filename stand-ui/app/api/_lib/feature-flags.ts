// ── Feature Flags (temporary shim) ───────────────────────────────────────────
//
// The basic tier has been removed — the app is premium-only. This shim keeps
// the surface that app/admin/page.tsx and app/api/admin/config still import;
// both are scheduled for removal in a later phase, after which this file can
// be deleted entirely.
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

export const APP_MODE_CONFIG = {
  premium: {
    label:       'Premium',
    description: 'Automated pipeline. New values are continuously detected, standardized, and written back to the source column via a Snowflake masking policy — no manual step required.',
    color:       '#065F46',
    bg:          '#D1FAE5',
    border:      '#6EE7B7',
  },
} as Record<AppMode, AppModeConfig>;

/** The app is premium-only; always returns 'premium'. */
export function getAppMode(): AppMode {
  return 'premium';
}
