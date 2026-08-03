import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--experimental-loader",
    "./tests/loader.mjs",
    "tests/_entry.ts",
  ],
  {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, FLEXIDATA_STUB_AI: "1" },
  }
);

process.exit(result.status ?? 1);
