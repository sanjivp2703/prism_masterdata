import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Warehouse-adapter boundary (docs/MSSQL_PORT_PLAN.md): database drivers may
  // only be imported inside app/api/_lib/warehouse/ — everything else goes
  // through the warehouse facade so a second warehouse can slot in behind it.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["app/api/_lib/warehouse/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "snowflake-sdk",
              message:
                "Driver imports are only allowed inside app/api/_lib/warehouse/. Use the warehouse facade (@/app/api/_lib/warehouse) instead.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
