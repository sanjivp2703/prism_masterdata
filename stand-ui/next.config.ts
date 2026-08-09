import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module — must stay external to the server bundle.
  // Both of these must stay OUT of the bundle and be required at runtime.
  //
  // better-sqlite3 is a native addon. re2-wasm loads `build/wasm/re2.wasm` by
  // path relative to its own package, so bundling it rewrites that path and the
  // build fails with ENOENT on re2.wasm while collecting page data.
  serverExternalPackages: ['better-sqlite3', 're2-wasm'],

  experimental: {
    // MUST comfortably exceed the documented 20 MB CSV/Excel upload limit.
    //
    // Next's router proxy defaults to 10 MiB and, crucially, TRUNCATES rather
    // than erroring: body-streams.js cuts the stream and only console.warns.
    // /api/pipelines/file then fails to parse the mangled JSON, and the route
    // used to swallow that into `body = {}` — so `rows` was [] and the
    // 200,000-row cap could never fire, while the caller got a nonsense
    // "source_type must be csv, excel, or sheets" error.
    //
    // It also broke LEGAL uploads: 100,000 rows x 6 short columns (half the row
    // cap, and only a few MB as .xlsx so it passed the client's 20 MB guard)
    // serialises to ~17.4 MiB of JSON and was silently truncated.
    //
    // 64 MB leaves headroom for JSON overhead on a 20 MB source file. The row
    // count — not the byte size — remains the real guardrail, and it can now
    // actually be reached. See KI-163.
    proxyClientMaxBodySize: 64 * 1024 * 1024,
  },
};

export default nextConfig;
