import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const ROOT = pathResolve(fileURLToPath(new URL("../", import.meta.url)));
const TESSERACT_MAIN = pathResolve(ROOT, "src", "lib", "tesseract-main.ts");

// tesseract-main.ts resolves its CJS require via `eval("require")` (opaque to
// Turbopack so the Next build can't trace the dynamic path.join). Plain Node
// ESM has no `require` binding, so when the harness loads it we swap the line
// for createRequire before evaluation. Run the harness with
// `--import ./tests/set-require.mjs` so the module can also be imported
// statically (that preload binds `require` on the main thread's globalThis).
export async function load(url, context, nextLoad) {
  let matched = false;
  try {
    matched = fileURLToPath(url) === TESSERACT_MAIN;
  } catch {}
  if (matched) {
    const real = await nextLoad(url, context);
    let source =
      typeof real.source === "string"
        ? real.source
        : new TextDecoder().decode(real.source);
    if (!source.includes("createRequire")) {
      source = source.replace(
        'const runtimeRequire = eval("require");',
        "const runtimeRequire = createRequire(import.meta.url);"
      );
      source = 'import { createRequire } from "node:module";\n' + source;
    }
    return { ...real, source };
  }

  // Node's type stripping does not accept the `.tsx` extension (even for
  // JSX-free files). Load such files ourselves and hand the source back as
  // plain strippable TypeScript so JSX-free test/component logic runs.
  if (url.endsWith(".tsx")) {
    const file = fileURLToPath(url);
    const source = await readFile(file, "utf8");
    return { format: "module-typescript", source, shortCircuit: true };
  }

  return nextLoad(url, context);
}

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
  if (specifier === "next/server") {
    const stub = pathResolve(ROOT, "tests", "stubs", "next-server.ts");
    return { shortCircuit: true, url: pathToFileURL(stub).href };
  }

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
