/**
 * Layout edge vocabulary — the directed relation types the semantic graph
 * understands. Values are the exact tokens the architecture defines; the union
 * type is the compile-time guarantee that edge kinds are never stringly-typed.
 *
 * Milestone 2 defines the vocabulary and the first-class edge object only.
 * Edge derivation (spatial/order algorithms) belongs to later milestones.
 */

/** Every directed relation the layout graph can carry. */
export const LAYOUT_EDGE_TYPE = {
  CONTAINS: "CONTAINS",
  CHILD_OF: "CHILD_OF",
  ADJACENT: "ADJACENT",
  ALIGNED_HORIZONTAL: "ALIGNED_HORIZONTAL",
  ALIGNED_VERTICAL: "ALIGNED_VERTICAL",
  READING_NEXT: "READING_NEXT",
  READING_PREVIOUS: "READING_PREVIOUS",
} as const;

export type LayoutEdgeType =
  (typeof LAYOUT_EDGE_TYPE)[keyof typeof LAYOUT_EDGE_TYPE];

/** All edge types in vocabulary order (deterministic iteration). */
export const LAYOUT_EDGE_TYPES: readonly LayoutEdgeType[] = Object.values(
  LAYOUT_EDGE_TYPE
);

const EDGE_TYPE_SET: ReadonlySet<string> = new Set(LAYOUT_EDGE_TYPES);

/** Runtime guard for edge types arriving from untyped sources. */
export function isLayoutEdgeType(value: unknown): value is LayoutEdgeType {
  return typeof value === "string" && EDGE_TYPE_SET.has(value);
}

/**
 * A first-class immutable directed edge. The `type` is a member of the
 * `LayoutEdgeType` union, never a free-form string.
 */
export interface TypedLayoutEdge {
  /** The relation this edge expresses. */
  readonly type: LayoutEdgeType;
  /** Source node id. */
  readonly from: string;
  /** Target node id. */
  readonly to: string;
}
