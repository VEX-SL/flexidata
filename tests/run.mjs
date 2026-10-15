import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    // Node 26 is strip-only (`--experimental-transform-types` no longer exists),
    // and nothing in src/ or tests/ needs the transform anyway: there are no
    // enums, namespaces or parameter properties to lower.
    "--experimental-loader",
    "./tests/loader.mjs",
    "--import",
    "./tests/set-require.mjs",
    "tests/_entry.ts",
  ],
  {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, FLEXIDATA_STUB_AI: "1" },
  }
);

process.exit(result.status ?? 1);
