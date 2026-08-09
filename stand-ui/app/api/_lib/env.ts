// Small env-reading utilities shared across server modules. Pure reads — no
// warehouse or driver dependencies (but server-only: env vars must never be
// read from client bundles).
import 'server-only';

export function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : undefined;
}

/** Dev-only fresh-install simulation (PRISM_FRESH_SETUP=true): status/prefill
 *  surfaces and the setup gate pretend env credentials don't exist, so the
 *  onboarding flow behaves like a bare customer deployment. The REAL service
 *  connection (withWarehouse) and LLM key resolution are never affected. */
export function isFreshSetupSim(): boolean {
  return (getOptionalEnv('PRISM_FRESH_SETUP') ?? '').toLowerCase() === 'true';
}
