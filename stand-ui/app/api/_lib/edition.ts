/**
 * Product edition switch (docs/NATIVE_APP_PLAN.md).
 *
 *   'standard' — the VPS-deployed product (default; the flag ABSENT must
 *                leave standard behavior byte-identical).
 *   'native'   — the Snowflake Marketplace Native App build (SPCS container):
 *                Snowflake-only warehouse, no Google Sheets surfaces, no
 *                invitations/SMTP, no Sentry, debug tools hard-off.
 *
 * Pure module — NO `server-only` import, deliberately: client components need
 * the edition to hide cut surfaces. Client bundles read
 * NEXT_PUBLIC_PRISM_EDITION (inlined at build time by Next); the bare
 * PRISM_EDITION var is the server/scripts fallback. The native Docker image
 * sets both at build. Client-side hiding is cosmetic ONLY — every cut surface
 * has a server-side guard that is the real gate.
 */
export type PrismEdition = 'standard' | 'native';

/** Narrow an untrusted string to an edition. Anything but 'native' → 'standard'. */
export function asPrismEdition(v: unknown): PrismEdition {
  return String(v ?? '').trim().toLowerCase() === 'native' ? 'native' : 'standard';
}

export function prismEdition(): PrismEdition {
  return asPrismEdition(process.env.NEXT_PUBLIC_PRISM_EDITION ?? process.env.PRISM_EDITION);
}

export function isNativeEdition(): boolean {
  return prismEdition() === 'native';
}

/** Shared 403 body for native-edition-gated API routes. */
export function nativeEditionUnavailable(feature: string): Response {
  return Response.json(
    { error: `${feature} is not available in this edition of Prism.` },
    { status: 403 },
  );
}
