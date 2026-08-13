import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Set ONLY by the native-edition Docker build (native/Dockerfile):
  // 'standalone' emits .next/standalone (traced server + node_modules) for the
  // container image. Deliberately conditional so the standard edition's
  // `next build` + `next start` deploy path (deploy/deploy.sh) is untouched.
  // outputFileTracingRoot pins the trace to this app dir — otherwise Next
  // infers the "workspace root" from any stray parent-directory lockfile and
  // nests the standalone output under the inferred relative path.
  ...(process.env.PRISM_BUILD_STANDALONE === 'true'
    ? { output: 'standalone' as const, outputFileTracingRoot: process.cwd() }
    : {}),

  // Native module — must stay external to the server bundle.
  // Both of these must stay OUT of the bundle and be required at runtime.
  //
  // better-sqlite3 is a native addon. re2-wasm loads `build/wasm/re2.wasm` by
  // path relative to its own package, so bundling it rewrites that path and the
  // build fails with ENOENT on re2.wasm while collecting page data.
  serverExternalPackages: ['better-sqlite3', 're2-wasm'],

  // Deploy-server escape hatch ONLY (deploy/deploy.sh): the 2 GB droplet
  // OOM-kills the build's TypeScript pass, so deploy.sh type-checks on the
  // operator machine first and sets this to skip the server-side re-check.
  // Never set it anywhere a local `tsc --noEmit` hasn't already passed.
  typescript: {
    ignoreBuildErrors: process.env.PRISM_SKIP_BUILD_TYPECHECK === 'true',
  },

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
