'use client';

import { useEffect, useState } from 'react';

/**
 * The name of the warehouse this installation actually runs on, for user-facing
 * copy: "Snowflake" or "SQL Server".
 *
 * Why this exists: user-visible strings across the app hardcoded "Snowflake",
 * so a SQL Server customer was told to "connect your Snowflake account", that
 * their export would "create a Snowflake view" (a thing Prism explicitly
 * refuses on mssql), and to "load the data into a Snowflake table" — naming a
 * product they do not own and cannot act on (SEC-07 follow-up). AutoExportHome
 * had already solved this locally with its own fetch + `warehouseLabel`; this
 * hook is that pattern extracted so the other surfaces don't each re-implement
 * it, and don't each fire their own request.
 *
 * Caching: the answer is fixed for the lifetime of the installation, so the
 * first caller fetches and every later caller reads the module-level cache.
 * Concurrent first-callers share ONE in-flight promise rather than each issuing
 * a request — several of these components render together on /home.
 *
 * Defaults to 'snowflake' until resolved, matching the server's own default
 * (`getWarehouseAdapter()`), so a slow or failed fetch degrades to today's
 * behavior rather than to blank or wrong copy.
 */
export type WarehouseKind = 'snowflake' | 'mssql';

let cachedKind: WarehouseKind | null = null;
let inFlight: Promise<WarehouseKind> | null = null;

function loadKind(): Promise<WarehouseKind> {
  if (cachedKind) return Promise.resolve(cachedKind);
  if (inFlight) return inFlight;
  inFlight = fetch('/api/accounts/warehouse-kind')
    .then((r) => r.json())
    .then((d) => {
      // Cache ONLY a real answer. A response that isn't a valid kind is not an
      // answer — the realistic case is the 401 this route returns for an
      // expired session, whose body has no `kind` at all. Treating that as
      // "snowflake" and caching it would pin an mssql install to the wrong
      // vendor name for the rest of the page's life, off one transient failure.
      // Return the default UNCACHED instead, so the next caller retries.
      if (d?.kind === 'mssql' || d?.kind === 'snowflake') {
        cachedKind = d.kind as WarehouseKind;
        return cachedKind;
      }
      return 'snowflake' as WarehouseKind;
    })
    .catch(() => 'snowflake' as WarehouseKind)
    // Clear the in-flight slot either way: a failed fetch must not pin every
    // future caller to a rejected/defaulted promise for the rest of the session.
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function useWarehouseKind(): WarehouseKind {
  const [kind, setKind] = useState<WarehouseKind>(cachedKind ?? 'snowflake');
  useEffect(() => {
    let alive = true;
    loadKind().then((k) => { if (alive) setKind(k); });
    return () => { alive = false; };
  }, []);
  return kind;
}

/** The display name for the active warehouse — use this in user-facing copy. */
export function useWarehouseLabel(): string {
  return useWarehouseKind() === 'mssql' ? 'SQL Server' : 'Snowflake';
}
