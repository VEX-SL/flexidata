export interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

const registry: TestCase[] = [];

export function test(name: string, fn: () => void | Promise<void>): void {
  registry.push({ name, fn });
}

export function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

export function ok(actual: unknown, msg?: string): void {
  if (!actual) {
    throw new Error(msg ?? `expected truthy value, got ${JSON.stringify(actual)}`);
  }
}

export function equal<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "values are not equal"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

export function includes(haystack: string, needle: string, msg?: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `${msg ?? "missing expected substring"}\n  needle:   ${JSON.stringify(needle)}\n  in:       ${JSON.stringify(haystack.slice(0, 300))}`
    );
  }
}

export async function run(): Promise<void> {
  let failed = 0;
  for (const t of registry) {
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${(err as Error)?.message ?? String(err)}`);
    }
  }
  const total = registry.length;
  console.log(`\n${total - failed}/${total} tests passed`);
  if (failed > 0) process.exitCode = 1;
}
