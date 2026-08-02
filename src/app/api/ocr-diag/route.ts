import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = {
    node: process.version,
    cwd: process.cwd(),
    time: new Date().toISOString(),
  };

  const candidates = [
    "/ROOT/node_modules/tesseract.js-core",
    path.join(process.cwd(), "node_modules", "tesseract.js-core"),
    path.resolve("node_modules/tesseract.js-core"),
    path.join(path.dirname(process.execPath), "..", "node_modules", "tesseract.js-core"),
    "/var/task/node_modules/tesseract.js-core",
  ];

  const found: Array<Record<string, unknown>> = [];
  for (const dir of candidates) {
    let listing: string[] | null = null;
    let err: string | null = null;
    try {
      listing = fs.readdirSync(dir);
    } catch (e) {
      err = String(e);
    }
    if (listing || err) {
      found.push({
        dir,
        exists: !!listing,
        listing: listing,
        error: err,
        wasmStat: listing
          ? (() => {
              try {
                const st = fs.statSync(path.join(dir, "tesseract-core-relaxedsimd.wasm"));
                return { size: st.size };
              } catch (e2) {
                return { missing: String(e2) };
              }
            })()
          : null,
      });
    }
  }
  out.coreDirs = found;

  // where does require('tesseract.js-core/...') resolve? use process.module paths via Module._nodeModulePaths
  const Module = require("module");
  const modulePaths = Module._nodeModulePaths(path.join("/ROOT", ".next", "server", "app", "api"));
  out.modulePaths = modulePaths;
  const glob = require("fs").readdirSync as (p: string) => string[];
  const searchRoots = ["/ROOT/node_modules", path.join(process.cwd(), "node_modules")];
  for (const root of searchRoots) {
    try {
      const entries = glob(root);
      out["has_" + root] = entries.filter((e) => e.includes("tesseract") || e.includes("wasm-feature"));
    } catch {
      out["has_" + root] = "unreadable";
    }
  }

  return NextResponse.json(out);
}
