/**
 * Layout block validation — the M3 contract checks over segmentation output.
 *
 * Every validator is mutation-free, deterministic and returns the shared
 * frozen `ValidationResult`. Together they pin the segmentation contract:
 * every word is assigned to exactly one block, no block is empty, block
 * boxes are valid, output is immutable, and identical input reproduces
 * identical blocks.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import { validationResult } from "./validation";
import type { ValidationResult } from "./validation";
import type { LayoutBlock } from "./blocks";
import type { SegmentationResult } from "./segmentation";

/**
 * Every word key (page:line:word) appears in at most one block — across and
 * within blocks. Combined with `validateFullWordCoverage` this pins "every
 * word assigned exactly once".
 */
export function validateBlockAssignments(
  blocks: readonly LayoutBlock[]
): ValidationResult {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const block of blocks) {
    for (const ref of block.sourceRefs) {
      const key = `${ref.pageIndex}:${ref.lineIndex}:${ref.wordIndex}`;
      if (seen.has(key)) {
        errors.push(`word ${key} is assigned to multiple blocks`);
      }
      seen.add(key);
    }
  }
  return validationResult(errors);
}

/** No block may contain zero child words. */
export function validateNoEmptyBlocks(
  blocks: readonly LayoutBlock[]
): ValidationResult {
  const errors: string[] = [];
  for (const block of blocks) {
    if (block.sourceRefs.length === 0) {
      errors.push(`block ${block.id} has no words`);
    }
  }
  return validationResult(errors);
}

/** Every block box must be finite with positive width and height. */
export function validateBlockBoxes(
  blocks: readonly LayoutBlock[]
): ValidationResult {
  const errors: string[] = [];
  for (const block of blocks) {
    if (!isValidBox(block.bbox)) {
      errors.push(`block ${block.id} has an invalid bbox`);
    }
    if (!isFiniteBox(block.normalizedBBox)) {
      errors.push(`block ${block.id} has an invalid normalized bbox`);
    }
  }
  return validationResult(errors);
}

/** Every block and all its owned structures must be frozen. */
export function validateFrozenBlocks(
  blocks: readonly LayoutBlock[]
): ValidationResult {
  const errors: string[] = [];
  for (const block of blocks) {
    const paths: string[] = [];
    collectNonFrozenPaths(block, "", new Set(), paths);
    for (const path of paths) {
      errors.push(`block ${block.id} is not deep-frozen at ${path}`);
    }
  }
  return validationResult(errors);
}

/**
 * Every positioned word of the source OCR (words carrying a bbox) is assigned
 * to exactly one block, and no block references a word that does not exist in
 * the source. Unpositioned words are out of the segmentation scope.
 */
export function validateFullWordCoverage(
  ocr: OcrDocument,
  blocks: readonly LayoutBlock[]
): ValidationResult {
  const expected = positionedWordKeys(ocr);
  const actual = new Set<string>();
  for (const block of blocks) {
    for (const ref of block.sourceRefs) {
      actual.add(`${ref.lineIndex}:${ref.wordIndex}`);
    }
  }
  const errors: string[] = [];
  for (const key of sortedSet(expected)) {
    if (!actual.has(key)) {
      errors.push(`word ${key} is not assigned to any block`);
    }
  }
  for (const key of sortedSet(actual)) {
    if (!expected.has(key)) {
      errors.push(`block references unknown word ${key}`);
    }
  }
  return validationResult(errors);
}

/**
 * Deterministic output: a re-run of the segmentation on identical input must
 * reproduce identical blocks, thresholds and skip counts.
 */
export function validateSegmentationDeterminism(
  first: SegmentationResult,
  second: SegmentationResult
): ValidationResult {
  const errors: string[] = [];
  if (first.skippedWordCount !== second.skippedWordCount) {
    errors.push(
      `skipped word count differs (${first.skippedWordCount} vs ${second.skippedWordCount})`
    );
  }
  if (!deepEqual(first.thresholds, second.thresholds)) {
    errors.push("adaptive thresholds differ between runs");
  }
  const a = first.blocks;
  const b = second.blocks;
  if (a.length !== b.length) {
    errors.push(`block count differs (${a.length} vs ${b.length})`);
  } else {
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        errors.push(`blocks[${i}] differs between runs`);
      }
    }
  }
  return validationResult(errors);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function isValidBox(box: { x: number; y: number; width: number; height: number }): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
}

function isFiniteBox(box: { x: number; y: number; width: number; height: number }): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  );
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

function positionedWordKeys(ocr: OcrDocument): Set<string> {
  const keys = new Set<string>();
  ocr.lines.forEach((line, li) => {
    line.words.forEach((word, wi) => {
      if (word.bbox) keys.add(`${li}:${wi}`);
    });
  });
  return keys;
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
      if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }
  return a === b;
}
