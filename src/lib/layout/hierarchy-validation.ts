/**
 * Layout hierarchy validation — the M4 contract checks over hierarchy trees.
 *
 * Every validator is mutation-free, deterministic and returns the shared
 * frozen `ValidationResult`. The structural validators operate on plain node
 * collections (mirroring the Milestone 2 validation style) so they can run on
 * any node set, including ones that violate the `LayoutHierarchy` constructor
 * guarantees; the container-level validators take the frozen instance.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import { validationResult } from "./validation";
import type { ValidationResult } from "./validation";
import { HIERARCHY_ROOT_LEVEL } from "./hierarchy";
import type { HierarchyNode, LayoutHierarchy } from "./hierarchy";
import { NODE_LEVEL } from "./node-levels";
import { boxContains } from "./geometry";

/** Every non-root node references an existing parent that lists it. */
export function validateSingleParent(
  nodes: readonly HierarchyNode[]
): ValidationResult {
  const errors: string[] = [];
  const byId = indexById(nodes);
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const parent = byId.get(node.parentId);
    if (parent === undefined) {
      errors.push(`node ${node.id} references unknown parent ${node.parentId}`);
    } else if (!parent.children.includes(node.id)) {
      errors.push(
        `node ${node.id} is not listed by its parent ${node.parentId}`
      );
    }
  }
  return validationResult(errors);
}

/** No child id is owned by more than one parent or listed twice. */
export function validateUniqueOwnership(
  nodes: readonly HierarchyNode[]
): ValidationResult {
  const errors: string[] = [];
  const claimedBy = new Map<string, string>();
  for (const node of nodes) {
    const seenInParent = new Set<string>();
    for (const childId of node.children) {
      if (seenInParent.has(childId)) {
        errors.push(`node ${node.id} lists child ${childId} more than once`);
      }
      seenInParent.add(childId);
      const owner = claimedBy.get(childId);
      if (owner !== undefined && owner !== node.id) {
        errors.push(
          `node ${childId} is owned by both ${owner} and ${node.id}`
        );
      }
      claimedBy.set(childId, node.id);
    }
  }
  return validationResult(errors);
}

/** Every parent bbox contains every child bbox (edges inclusive). */
export function validateHierarchyContainment(
  nodes: readonly HierarchyNode[]
): ValidationResult {
  const errors: string[] = [];
  const byId = indexById(nodes);
  for (const node of nodes) {
    for (const childId of node.children) {
      const child = byId.get(childId);
      if (child !== undefined && !boxContains(node.bbox, child.bbox)) {
        errors.push(`node ${node.id} does not contain child ${childId}`);
      }
    }
  }
  return validationResult(errors);
}

/**
 * Parent chains terminate at a single root: exactly one node has no parent,
 * every other chain reaches it without revisiting a node.
 */
export function validateParentChain(
  nodes: readonly HierarchyNode[]
): ValidationResult {
  const errors: string[] = [];
  const byId = indexById(nodes);
  const roots = nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1) {
    errors.push(`expected exactly one root node, found ${roots.length}`);
  }
  for (const node of nodes) {
    const seen = new Set<string>();
    let cur: string | undefined = node.id;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const current = byId.get(cur);
      cur = current === undefined ? undefined : current.parentId ?? undefined;
    }
    if (cur !== undefined) {
      errors.push(`parent chain from node ${node.id} does not terminate`);
    }
  }
  return validationResult(errors);
}

/** Every node's page matches its nearest Page ancestor and its source refs. */
export function validatePageOwnership(
  nodes: readonly HierarchyNode[]
): ValidationResult {
  const errors: string[] = [];
  const byId = indexById(nodes);
  for (const node of nodes) {
    if (node.level === HIERARCHY_ROOT_LEVEL || node.level === NODE_LEVEL.PAGE) {
      continue;
    }
    let expected: number | undefined;
    let cur: HierarchyNode | undefined = node;
    while (cur !== undefined && cur.parentId !== null) {
      cur = byId.get(cur.parentId);
      if (cur !== undefined && cur.level === NODE_LEVEL.PAGE) {
        expected = cur.pageIndex;
        break;
      }
    }
    if (expected === undefined) {
      errors.push(`node ${node.id} has no page ancestor`);
      continue;
    }
    if (node.pageIndex !== expected) {
      errors.push(
        `node ${node.id} has page ${node.pageIndex} but its page ancestor is ${expected}`
      );
    }
    const ref = node.sourceRefs[0];
    if (ref !== undefined && ref.pageIndex !== node.pageIndex) {
      errors.push(
        `node ${node.id} page ${node.pageIndex} does not match its source ref page ${ref.pageIndex}`
      );
    }
  }
  return validationResult(errors);
}

/** Following parent pointers from any node never revisits a node. */
export function validateNoCycles(
  nodes: readonly HierarchyNode[]
): ValidationResult {
  const errors: string[] = [];
  const byId = indexById(nodes);
  for (const node of nodes) {
    const seen = new Set<string>([node.id]);
    let cur: HierarchyNode | undefined = node;
    while (cur !== undefined && cur.parentId !== null) {
      if (seen.has(cur.parentId)) {
        errors.push(`cycle detected through node ${node.id}`);
        break;
      }
      seen.add(cur.parentId);
      cur = byId.get(cur.parentId);
    }
  }
  return validationResult(errors);
}

/** The instance and every node (with all owned structures) are frozen. */
export function validateFrozenHierarchy(
  hierarchy: LayoutHierarchy
): ValidationResult {
  const errors: string[] = [];
  if (!Object.isFrozen(hierarchy)) {
    errors.push("hierarchy instance is not frozen");
  }
  for (const node of hierarchy.nodes()) {
    const paths: string[] = [];
    collectNonFrozenPaths(node, "", new Set(), paths);
    for (const path of paths) {
      errors.push(`node ${node.id} is not deep-frozen at ${path}`);
    }
  }
  return validationResult(errors);
}

/** Two builds of identical input reproduce identical trees. */
export function validateDeterministicHierarchy(
  first: LayoutHierarchy,
  second: LayoutHierarchy
): ValidationResult {
  const errors: string[] = [];
  const a = first.nodes();
  const b = second.nodes();
  if (a.length !== b.length) {
    errors.push(`node count differs (${a.length} vs ${b.length})`);
  } else {
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        errors.push(`nodes[${i}] differs between builds`);
      }
    }
  }
  return validationResult(errors);
}

/**
 * Every positioned word of the source OCR (words carrying a bbox) is covered
 * by exactly one Word node, and no Word node references a source word that
 * does not exist. Unpositioned words are out of scope.
 */
export function validateCompleteOcrCoverage(
  ocr: OcrDocument,
  hierarchy: LayoutHierarchy
): ValidationResult {
  const errors: string[] = [];
  const expected = new Set<string>();
  ocr.lines.forEach((line, li) => {
    line.words.forEach((word, wi) => {
      if (word.bbox) expected.add(`0:${li}:${wi}`);
    });
  });
  const actual = new Set<string>();
  for (const node of hierarchy.nodesAtLevel(NODE_LEVEL.WORD)) {
    const ref = node.sourceRefs[0];
    if (ref === undefined || ref.wordIndex === undefined) {
      errors.push(`word node ${node.id} has no word source ref`);
      continue;
    }
    actual.add(`${ref.pageIndex}:${ref.lineIndex}:${ref.wordIndex}`);
  }
  for (const key of sortedSet(expected)) {
    if (!actual.has(key)) {
      errors.push(`word ${key} is not covered by the hierarchy`);
    }
  }
  for (const key of sortedSet(actual)) {
    if (!expected.has(key)) {
      errors.push(`hierarchy covers unknown word ${key}`);
    }
  }
  return validationResult(errors);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function indexById(
  nodes: readonly HierarchyNode[]
): ReadonlyMap<string, HierarchyNode> {
  const byId = new Map<string, HierarchyNode>();
  for (const node of nodes) byId.set(node.id, node);
  return byId;
}

function collectNonFrozenPaths(
  value: unknown,
  path: string,
  seen: Set<object>,
  out: string[]
): void {
  if (value === null || typeof value !== "object") return;
  const obj = value as object;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (!Object.isFrozen(obj)) {
    out.push(path.length === 0 ? "<root>" : path);
  }
  for (const key of Object.keys(obj)) {
    const nextPath = path.length === 0 ? key : `${path}.${key}`;
    collectNonFrozenPaths(
      (obj as Record<string, unknown>)[key],
      nextPath,
      seen,
      out
    );
  }
}

function sortedSet(set: Set<string>): string[] {
  return [...set].sort((a, b) => a.localeCompare(b));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      const key = aKeys[i];
      if (key !== bKeys[i]) return false;
      if (
        !deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key]
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return a === b;
}
