const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function getNested(obj: unknown, path: string): string | undefined {
  let current: unknown = obj;

  for (const part of path.split(".")) {
    if (DANGEROUS_KEYS.has(part)) return undefined;
    if (current === null || typeof current !== "object") return undefined;

    // Use a property descriptor instead of `current[part]` so Semgrep
    // doesn't flag a dynamic read as a prototype-pollution sink, and so
    // getters are not triggered.
    const descriptor = Object.getOwnPropertyDescriptor(current, part);
    if (!descriptor || !("value" in descriptor)) return undefined;

    current = descriptor.value;
  }

  return typeof current === "string" ? current : undefined;
}