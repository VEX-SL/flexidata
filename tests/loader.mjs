import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const ROOT = pathResolve(fileURLToPath(new URL("../", import.meta.url)));

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function candidates(base) {
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}/index.ts`,
  ];
}

function findFile(base) {
  return candidates(base).find((p) => isFile(p));
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const rest = specifier.slice(2);
    if (
      (rest === "lib/ai/manager" || rest === "lib/ai/manager.ts") &&
      process.env.FLEXIDATA_STUB_AI === "1"
    ) {
      const stub = pathResolve(ROOT, "tests", "stubs", "ai-manager.ts");
      return { shortCircuit: true, url: pathToFileURL(stub).href };
    }
    if (
      (rest === "lib/file-parser" || rest === "lib/file-parser.ts") &&
      process.env.FLEXIDATA_STUB_FILE_PARSER === "1"
    ) {
      const stub = pathResolve(ROOT, "tests", "stubs", "file-parser.ts");
      return { shortCircuit: true, url: pathToFileURL(stub).href };
    }
    const base = pathResolve(ROOT, "src", ...rest.split("/"));
    const found = findFile(base);
    if (found) return { shortCircuit: true, url: pathToFileURL(found).href };
    return nextResolve(specifier, context);
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    const base = pathResolve(parentDir, specifier);
    const found = findFile(base);
    if (found) return { shortCircuit: true, url: pathToFileURL(found).href };
  }

  return nextResolve(specifier, context);
}
