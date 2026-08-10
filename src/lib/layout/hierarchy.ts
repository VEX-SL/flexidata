/**
 * Layout hierarchy — the deterministic immutable structural tree of a document.
 *
 * Milestone 4 ships hierarchy construction only: the chain
 *
 *     Document → Page → Region (UNKNOWN) → Block → Line → Word
 *
 * as a frozen, queryable tree. This module defines the node model, the
 * immutable node factory, the sibling comparator and the immutable
 * `LayoutHierarchy` container.
 *
 * The five semantic levels reuse the Milestone 2 `NODE_LEVEL` vocabulary
 * (Page/Region/Block/Line/Word) verbatim — no parallel vocabulary is
 * introduced. The single root is a Document container node at
 * `HIERARCHY_ROOT_LEVEL`; the root is a container that wraps the level
 * vocabulary, not a sixth semantic level.
 *
 * Determinism: sibling order is a pure comparator (OCR reading order priority
 * through source references, then stable geometric order, then id). The
 * container normalizes every parent's children with it on construction, so
 * trees never depend on the order of the input node array. All query views
 * are frozen copies.
 */
import type { BBox } from "@/lib/pipeline/types";
import type { NodeLevel } from "./node-levels";
import { NODE_LEVEL, NODE_LEVELS } from "./node-levels";
import type { RegionType } from "./region-types";
import { isRegionType } from "./region-types";
import {
  createConfidenceComponents,
  createConfidenceProfile,
  defaultCompositeScore,
} from "./confidence";
import type {
  CompositeScorePolicy,
  ConfidenceProfile,
} from "./confidence";

/** Stable id of the root Document node of a hierarchy. */
export const HIERARCHY_DOCUMENT_ID = "document";

/**
 * The root level of the structural hierarchy. The root is a container node
 * that wraps the level vocabulary — it is not a sixth semantic level.
 */
export const HIERARCHY_ROOT_LEVEL = "Document" as const;

export type HierarchyRootLevel = typeof HIERARCHY_ROOT_LEVEL;

/** The level of a hierarchy node: the root container plus the node vocabulary. */
export type HierarchyLevel = NodeLevel | HierarchyRootLevel;

/** All hierarchy levels, coarsest first (root container + vocabulary). */
export const HIERARCHY_LEVELS: readonly HierarchyLevel[] = [
  HIERARCHY_ROOT_LEVEL,
  ...NODE_LEVELS,
];

const HIERARCHY_LEVEL_SET: ReadonlySet<string> = new Set(HIERARCHY_LEVELS);

/** Runtime guard for levels arriving from untyped sources. */
export function isHierarchyLevel(value: unknown): value is HierarchyLevel {
  return typeof value === "string" && HIERARCHY_LEVEL_SET.has(value);
}

/** Link back to the source OCR primitive that produced a node. */
export interface HierarchySourceRef {
  /** 0-based page index of the source word (always 0 in this milestone). */
  readonly pageIndex: number;
  /** 0-based line index into the source OcrDocument. */
  readonly lineIndex: number;
  /** 0-based word index within the line; absent for line-level references. */
  readonly wordIndex?: number;
}

/** Immutable per-node metadata. Structural keys only — never OCR text. */
export interface HierarchyMetadata {
  /** Page index for Page nodes; word index for Word nodes. */
  readonly index?: number;
}

/** A node of the structural hierarchy. Deep-frozen by the factory. */
export interface HierarchyNode {
  readonly id: string;
  readonly level: HierarchyLevel;
  readonly parentId: string | null;
  /** Page this node belongs to; -1 for the Document root. */
  readonly pageIndex: number;
  /** Visual box in page coordinates. */
  readonly bbox: BBox;
  /** The bbox mapped onto the unit square of the build's page size. */
  readonly normalizedBBox: BBox;
  /** Aggregated confidence profile of this node's content. */
  readonly confidence: ConfidenceProfile;
  /** Child node ids, deterministically ordered. */
  readonly children: readonly string[];
  /** Source OCR references; empty for derived structural containers. */
  readonly sourceRefs: readonly HierarchySourceRef[];
  /** Immutable structural metadata. */
  readonly metadata: HierarchyMetadata;
  /** Role of a REGION node. Always UNKNOWN in this milestone. */
  readonly regionType?: RegionType;
}

export interface CreateHierarchyNodeOptions {
  readonly id: string;
  readonly level: HierarchyLevel;
  readonly parentId: string | null;
  readonly pageIndex: number;
  readonly bbox: BBox;
  readonly normalizedBBox: BBox;
  readonly confidence: ConfidenceProfile;
  readonly children?: readonly string[];
  readonly sourceRefs?: readonly HierarchySourceRef[];
  readonly metadata?: HierarchyMetadata;
  readonly regionType?: RegionType;
}

/**
 * Create an immutable hierarchy node. Rejects empty ids, unknown levels,
 * non-finite boxes and region types attached to non-region nodes.
 */
export function createHierarchyNode(
  opts: CreateHierarchyNodeOptions
): HierarchyNode {
  if (opts.id.length === 0) {
    throw new Error("hierarchy node id must not be empty");
  }
  if (!isHierarchyLevel(opts.level)) {
    throw new Error(`unknown hierarchy level: ${String(opts.level)}`);
  }
  if (opts.regionType !== undefined) {
    if (opts.level !== NODE_LEVEL.REGION) {
      throw new Error(
        `region type only applies to REGION nodes: ${opts.id}`
      );
    }
    if (!isRegionType(opts.regionType)) {
      throw new Error(`unknown region type: ${String(opts.regionType)}`);
    }
  }
  if (!isFiniteBox(opts.bbox)) {
    throw new Error(`node ${opts.id} has a non-finite bbox`);
  }
  if (!isFiniteBox(opts.normalizedBBox)) {
    throw new Error(`node ${opts.id} has a non-finite normalized bbox`);
  }
  const node: HierarchyNode = {
    id: opts.id,
    level: opts.level,
    parentId: opts.parentId,
    pageIndex: opts.pageIndex,
    bbox: Object.freeze({ ...opts.bbox }),
    normalizedBBox: Object.freeze({ ...opts.normalizedBBox }),
    confidence: opts.confidence,
    children: Object.freeze([...(opts.children ?? [])]),
    sourceRefs: Object.freeze(
      (opts.sourceRefs ?? []).map((ref) => Object.freeze({ ...ref }))
    ),
    metadata: Object.freeze({ ...(opts.metadata ?? {}) }),
    ...(opts.regionType !== undefined
      ? { regionType: opts.regionType }
      : {}),
  };
  return Object.freeze(node);
}

/**
 * Parent confidence aggregation: each child contributes one sample whose six
 * component values are the child profile's per-component means, carrying the
 * child's presence mask so a component stays measured for the parent whenever
 * any child measured it. Uses only the existing `createConfidenceProfile`
 * aggregation; empty children yield a neutral profile.
 */
export function aggregateChildConfidence(
  children: readonly HierarchyNode[],
  policy: CompositeScorePolicy = defaultCompositeScore
): ConfidenceProfile {
  const samples = children.map((child) =>
    createConfidenceComponents(
      {
        ocr: child.confidence.ocr.mean,
        geometric: child.confidence.geometric.mean,
        structural: child.confidence.structural.mean,
        boundary: child.confidence.boundary.mean,
        typological: child.confidence.typological.mean,
        order: child.confidence.order.mean,
      },
      child.confidence.measured
    )
  );
  return createConfidenceProfile(samples, policy);
}

/**
 * Deterministic sibling order. OCR reading order has priority (via source
 * references: page, then line, then word); otherwise the order is the stable
 * geometric top-to-bottom / left-to-right order of the boxes, with id as the
 * final tie-break. Page nodes order by their page index. The comparator never
 * depends on JS iteration order.
 */
export function compareHierarchyNodes(
  a: HierarchyNode,
  b: HierarchyNode
): number {
  if (a.level === NODE_LEVEL.PAGE && b.level === NODE_LEVEL.PAGE) {
    return (a.metadata.index ?? 0) - (b.metadata.index ?? 0);
  }
  const aRef = a.sourceRefs[0];
  const bRef = b.sourceRefs[0];
  if (aRef !== undefined && bRef !== undefined) {
    const pageCmp = aRef.pageIndex - bRef.pageIndex;
    if (pageCmp !== 0) return pageCmp;
    const lineCmp = aRef.lineIndex - bRef.lineIndex;
    if (lineCmp !== 0) return lineCmp;
    const aWord = aRef.wordIndex ?? -1;
    const bWord = bRef.wordIndex ?? -1;
    if (aWord !== bWord) return aWord - bWord;
  }
  const yCmp = a.bbox.y - b.bbox.y;
  if (yCmp !== 0) return yCmp;
  const xCmp = a.bbox.x - b.bbox.x;
  if (xCmp !== 0) return xCmp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The only child level allowed under each parent level (coarsest to finest). */
const CHILD_LEVELS: Readonly<Record<HierarchyLevel, readonly HierarchyLevel[]>> = {
  [HIERARCHY_ROOT_LEVEL]: [NODE_LEVEL.PAGE],
  [NODE_LEVEL.PAGE]: [NODE_LEVEL.REGION],
  [NODE_LEVEL.REGION]: [NODE_LEVEL.BLOCK],
  [NODE_LEVEL.BLOCK]: [NODE_LEVEL.LINE],
  [NODE_LEVEL.LINE]: [NODE_LEVEL.WORD],
  [NODE_LEVEL.WORD]: [],
};

/**
 * The immutable structural tree of a document.
 *
 * The constructor validates the tree (exactly one Document root, unique ids,
 * single parent, unique ownership, level adjacency, terminating parent
 * chains) and throws on violations, then normalizes every parent's children
 * into deterministic order and freezes the instance. Query views are frozen
 * copies.
 */
export class LayoutHierarchy {
  private readonly byId: ReadonlyMap<string, HierarchyNode>;
  private readonly preOrder: readonly HierarchyNode[];
  private readonly rootNodeId: string;

  constructor(nodes: readonly HierarchyNode[]) {
    if (nodes.length === 0) {
      throw new Error("layout hierarchy requires at least one node");
    }
    const byId = new Map<string, HierarchyNode>();
    for (const node of nodes) {
      if (byId.has(node.id)) {
        throw new Error(`duplicate hierarchy node id: ${node.id}`);
      }
      byId.set(node.id, node);
    }

    let root: HierarchyNode | undefined;
    for (const node of nodes) {
      if (node.parentId !== null) continue;
      if (root !== undefined) {
        throw new Error(
          `layout hierarchy requires exactly one root, found ${node.id} and ${root.id}`
        );
      }
      root = node;
    }
    if (root === undefined) {
      throw new Error("layout hierarchy has no root node");
    }
    if (root.level !== HIERARCHY_ROOT_LEVEL) {
      throw new Error(
        `layout hierarchy root must be a Document node, got level ${String(
          root.level
        )}`
      );
    }

    // Child claims: single parent, unique ownership, level adjacency.
    const claimedBy = new Map<string, string>();
    for (const node of nodes) {
      const allowed = CHILD_LEVELS[node.level];
      for (const childId of node.children) {
        const child = byId.get(childId);
        if (child === undefined) {
          throw new Error(
            `node ${node.id} references unknown child ${childId}`
          );
        }
        if (childId === node.id) {
          throw new Error(`node ${node.id} cannot be its own child`);
        }
        if (!allowed.includes(child.level)) {
          throw new Error(
            `child ${childId} has level ${child.level} which is invalid under ${node.id} (${node.level})`
          );
        }
        const owner = claimedBy.get(childId);
        if (owner !== undefined) {
          throw new Error(
            `node ${childId} is claimed by both ${owner} and ${node.id}`
          );
        }
        claimedBy.set(childId, node.id);
        if (child.parentId !== node.id) {
          throw new Error(
            `node ${childId} declares parent ${child.parentId ?? "none"} but is claimed by ${node.id}`
          );
        }
      }
    }
    for (const node of nodes) {
      if (node.parentId === null) continue;
      if (claimedBy.get(node.id) !== node.parentId) {
        throw new Error(
          `node ${node.id} is not claimed by its parent ${node.parentId}`
        );
      }
    }

    // Parent chains must terminate at the root (acyclicity).
    for (const node of nodes) {
      const seen = new Set<string>([node.id]);
      let cur: HierarchyNode | undefined = node;
      while (cur !== undefined && cur.parentId !== null) {
        if (seen.has(cur.parentId)) {
          throw new Error(`cycle detected through node ${node.id}`);
        }
        seen.add(cur.parentId);
        cur = byId.get(cur.parentId);
      }
    }

    // Normalize: deterministic sibling order on deep-frozen copies.
    const normalized = new Map<string, HierarchyNode>();
    for (const node of nodes) {
      const sorted = [...node.children].sort((a, b) =>
        compareHierarchyNodes(byId.get(a)!, byId.get(b)!)
      );
      normalized.set(
        node.id,
        Object.freeze({
          ...node,
          children: Object.freeze(sorted),
        })
      );
    }

    const preOrder: HierarchyNode[] = [];
    const visit = (id: string): void => {
      const node = normalized.get(id)!;
      preOrder.push(node);
      for (const childId of node.children) visit(childId);
    };
    visit(root.id);

    this.byId = normalized;
    this.rootNodeId = root.id;
    this.preOrder = Object.freeze(preOrder);
    Object.freeze(this);
  }

  /** Id of the root Document node. */
  get rootId(): string {
    return this.rootNodeId;
  }

  /** Total number of nodes in the tree. */
  get nodeCount(): number {
    return this.byId.size;
  }

  /** The root Document node. */
  root(): HierarchyNode {
    return this.byId.get(this.rootNodeId)!;
  }

  /** Look up a node by id. */
  get(id: string): HierarchyNode | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** All nodes in deterministic pre-order (document first, depth-first). */
  nodes(): readonly HierarchyNode[] {
    return this.preOrder;
  }

  /** Children of a node, in deterministic order. Empty for unknown ids. */
  childrenOf(id: string): readonly HierarchyNode[] {
    const node = this.byId.get(id);
    if (node === undefined) return Object.freeze([]);
    return Object.freeze(
      node.children.map((childId) => this.byId.get(childId)!)
    );
  }

  /** Parent of a node, or null for the root/unknown ids. */
  parentOf(id: string): HierarchyNode | null {
    const node = this.byId.get(id);
    if (node === undefined || node.parentId === null) return null;
    return this.byId.get(node.parentId) ?? null;
  }

  /** All ancestors, coarsest first (root down to the immediate parent). */
  ancestorsOf(id: string): readonly HierarchyNode[] {
    const node = this.byId.get(id);
    if (node === undefined) return Object.freeze([]);
    const chain: string[] = [];
    let cur: HierarchyNode | undefined = node;
    while (cur !== undefined && cur.parentId !== null) {
      chain.push(cur.parentId);
      cur = this.byId.get(cur.parentId);
    }
    const out: HierarchyNode[] = [];
    for (let i = chain.length - 1; i >= 0; i--) {
      out.push(this.byId.get(chain[i])!);
    }
    return Object.freeze(out);
  }

  /** All descendants, pre-order, excluding the node itself. */
  descendantsOf(id: string): readonly HierarchyNode[] {
    const node = this.byId.get(id);
    if (node === undefined) return Object.freeze([]);
    const out: HierarchyNode[] = [];
    const visit = (nid: string): void => {
      for (const childId of this.byId.get(nid)!.children) {
        const child = this.byId.get(childId)!;
        out.push(child);
        visit(childId);
      }
    };
    visit(id);
    return Object.freeze(out);
  }

  /** Other children of the node's parent. Empty for the root/unknown ids. */
  siblingsOf(id: string): readonly HierarchyNode[] {
    const node = this.byId.get(id);
    if (node === undefined || node.parentId === null) return Object.freeze([]);
    return Object.freeze(
      this.byId
        .get(node.parentId)!
        .children.filter((childId) => childId !== id)
        .map((childId) => this.byId.get(childId)!)
    );
  }

  /** All nodes of a level, in pre-order. */
  nodesAtLevel(level: HierarchyLevel): readonly HierarchyNode[] {
    return Object.freeze(this.preOrder.filter((node) => node.level === level));
  }

  /** Depth of a node (root is 0). -1 for unknown ids. */
  depthOf(id: string): number {
    let depth = 0;
    let cur: HierarchyNode | undefined = this.byId.get(id);
    while (cur !== undefined && cur.parentId !== null) {
      depth += 1;
      cur = this.byId.get(cur.parentId);
    }
    return cur === undefined ? -1 : depth;
  }
}

function isFiniteBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  );
}
