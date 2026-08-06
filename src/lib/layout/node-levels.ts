/**
 * Semantic node hierarchy levels. These are the levels the graph vocabulary
 * understands, listed coarsest to finest. Milestone 2 defines the levels only;
 * hierarchy construction is a later milestone.
 */
export const NODE_LEVEL = {
  PAGE: "Page",
  REGION: "Region",
  BLOCK: "Block",
  LINE: "Line",
  WORD: "Word",
} as const;

export type NodeLevel = (typeof NODE_LEVEL)[keyof typeof NODE_LEVEL];

/** All levels from coarsest to finest (deterministic iteration). */
export const NODE_LEVELS: readonly NodeLevel[] = Object.values(NODE_LEVEL);

const NODE_LEVEL_SET: ReadonlySet<string> = new Set(NODE_LEVELS);

/** Runtime guard for levels arriving from untyped sources. */
export function isNodeLevel(value: unknown): value is NodeLevel {
  return typeof value === "string" && NODE_LEVEL_SET.has(value);
}
