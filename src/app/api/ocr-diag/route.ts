import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = { node: process.version, cwd: process.cwd() };

  try {
    const Module = require("module");
    const resolvedCore = Module._resolveFilename("tesseract.js-core/tesseract-core-relaxedsimd", module);
    out.resolvedCore = resolvedCore;
    out.resolvedCoreDir = path.dirname(resolvedCore);
    try {
      out.resolvedCoreDirListing = fs.readdirSync(path.dirname(resolvedCore));
    } catch (e) {
      out.resolvedCoreDirListing = String(e);
    }
    try {
      out.wasmStat = fs.statSync(path.join(path.dirname(resolvedCore), "tesseract-core-relaxedsimd.wasm")).size;
    } catch (e) {
      out.wasmStat = String(e);
    }
    try {
      const resolvedTess = Module._resolveFilename("tesseract.js", module);
      out.resolvedTesseract = resolvedTess;
      out.workerPath = path.join(path.dirname(resolvedTess), "src", "worker", "node", "defaultOptions.js");
    } catch (e) {
      out.resolvedTesseract = String(e);
    }
    const modulePaths = Module._nodeModulePaths(path.dirname(module.filename || process.cwd()));
    out.routeModulePaths = modulePaths;
    out.routeFilename = module.filename || null;
  } catch (e) {
    out.error = String(e);
  }

  // root layout
  const roots = ["/ROOT", "/var/task"];
  for (const root of roots) {
    try {
      const st = fs.lstatSync(root);
      out[`lstat_${root}`] = { isSymlink: st.isSymbolicLink(), isDir: st.isDirectory() };
    } catch (e) {
      out[`lstat_${root}`] = String(e);
    }
  }
  for (const nm of ["/ROOT/node_modules", "/var/task/node_modules"]) {
    try {
      out[`listing_${nm}`] = fs.readdirSync(nm).filter((e) => e.includes("tesseract") || e.includes("core") || e.includes("wasm") || e.includes("xenova") || e.includes("napi"));
    } catch (e) {
      out[`listing_${nm}`] = String(e);
    }
  }

  return NextResponse.json(out);
}
