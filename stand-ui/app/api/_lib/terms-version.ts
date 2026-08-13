// Pure module (no server-only) — shared by the accept-terms page (client),
// the OAuth callback, the accept-terms API route, and the /home gate.
//
// The single source of truth for which revision of /terms + /privacy users
// must have accepted. Accounts store the version they accepted
// (accounts.terms_accepted_version, migration 017); anyone whose stored
// version is below this is routed through /accept-terms before using the app.
//
// BUMP THIS (and only this) when the terms materially change — every user is
// re-prompted on their next sign-in or /home visit. Do not bump for typo-level
// edits; re-consent fatigue makes real changes invisible.
export const CURRENT_TERMS_VERSION = 1;
