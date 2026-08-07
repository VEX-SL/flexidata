/**
 * Milestone 10 — layout evidence.
 *
 * Turns extracted layout nodes into deterministic, immutable evidence records:
 * OCR text, node id, source refs, bbox, containing region, confidence and
 * reading-order position. A pure read layer — no inference, no cleaning,
 * no AI.
 *
 * Text is resolved strictly through `LayoutSourceRef`s into the source OCR of
 * the context (`LayoutDocument.source`): word nodes read their word, line
 * nodes read their source line, and composite nodes (block/region/page/
 * document) reconstruct the reading-ordered join of their word texts. Nothing
 * is duplicated: the entry references the frozen shared confidence profile
 * and copies only the small immutable fields it owns.
 */
import type { BBox, OcrLine } from "@/lib/pipeline/types";
import type { HierarchyLevel, HierarchyNode, HierarchySourceRef } from "./hierarchy";
import { NODE_LEVEL } from "./node-levels";
import type { RegionType } from "./region-types";
import type { ConfidenceDistribution } from "./types";
import type { ConfidenceProfile } from "./confidence";
import { LayoutReader } from "./layout-reader";

/** The region that owns a node, in evidence shape. */
export interface EvidenceRegion {
  readonly id: string;
  readonly regionType?: RegionType;
}

/** Immutable evidence record for one extracted layout node. */
export interface LayoutEvidenceEntry {
  readonly nodeId: string;
  readonly level: HierarchyLevel;
  /** OCR text of the node's content (reconstructed from source refs). */
  readonly text: string;
  /** Source OCR references of the node (frozen copy). */
  readonly sourceRefs: readonly HierarchySourceRef[];
  /** Visual box in page coordinates (frozen copy). */
  readonly bbox: BBox;
  /** The nearest containing REGION, or null when none exists. */
  readonly region: EvidenceRegion | null;
  /** Composite confidence distribution of the node's profile. */
  readonly confidence: ConfidenceDistribution;
  /** The full frozen confidence profile (shared, never duplicated). */
  readonly confidenceProfile: ConfidenceProfile;
  /** 0-based position in the reading sequence, or null when absent. */
  readonly readingPosition: number | null;
}

export class LayoutEvidence {
  /** The reader this evidence layer navigates (never mutated). */
  readonly reader: LayoutReader;

  constructor(reader: LayoutReader) {
    this.reader = reader;
    Object.freeze(this);
  }

  /** Evidence for one node; undefined for unknown ids. */
  for(nodeId: string): LayoutEvidenceEntry | undefined {
    const node = this.reader.get(nodeId);
    if (node === undefined) return undefined;
    const readingPosition = this.reader.readingPosition(node.id);
    const region = this.regionOf(node);
    return Object.freeze({
      nodeId: node.id,
      level: node.level,
      text: this.ocrText(node),
      sourceRefs: Object.freeze(
        node.sourceRefs.map((ref) => Object.freeze({ ...ref }))
      ),
      bbox: Object.freeze({ ...node.bbox }),
      region: region === null ? null : Object.freeze(region),
      confidence: node.confidence.aggregate,
      confidenceProfile: node.confidence,
      readingPosition: readingPosition === undefined ? null : readingPosition,
    });
  }

  /** Evidence for many nodes, in input order; unknown ids are skipped. */
  forMany(nodeIds: readonly string[]): readonly LayoutEvidenceEntry[] {
    const out: LayoutEvidenceEntry[] = [];
    for (const id of nodeIds) {
      const entry = this.for(id);
      if (entry !== undefined) out.push(entry);
    }
    return Object.freeze(out);
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private ocrText(node: HierarchyNode): string {
    if (node.level === NODE_LEVEL.WORD) {
      const ref = node.sourceRefs[0];
      return ref === undefined ? "" : this.wordText(ref);
    }
    if (node.level === NODE_LEVEL.LINE) {
      const ref = node.sourceRefs[0];
      if (ref === undefined) return "";
      const line = this.sourceLine(ref.lineIndex);
      return line === undefined ? "" : line.text;
    }
    return this.compositeWords(node)
      .map((word) => this.ocrText(word))
      .join(" ");
  }

  private wordText(ref: HierarchySourceRef): string {
    if (ref.wordIndex === undefined) return "";
    const line = this.sourceLine(ref.lineIndex);
    return line?.words[ref.wordIndex]?.text ?? "";
  }

  private sourceLine(lineIndex: number): OcrLine | undefined {
    const source = this.reader.sourceOcr;
    return source === undefined ? undefined : source.lines[lineIndex];
  }

  /** A node's word descendants ordered by reading position (pre-order fallback). */
  private compositeWords(node: HierarchyNode): readonly HierarchyNode[] {
    const descendantIds = new Set(
      this.reader
        .descendants(node.id)
        .filter((candidate) => candidate.level === NODE_LEVEL.WORD)
        .map((candidate) => candidate.id)
    );
    if (descendantIds.size === 0) return Object.freeze([]);
    const inReadingOrder = this.reader
      .readingNodes()
      .filter(
        (candidate) =>
          candidate.level === NODE_LEVEL.WORD &&
          descendantIds.has(candidate.id)
      )
      .map((candidate) => this.reader.get(candidate.id))
      .filter((candidate): candidate is HierarchyNode => candidate !== undefined);
    if (inReadingOrder.length === descendantIds.size) {
      return Object.freeze(inReadingOrder);
    }
    return Object.freeze(
      this.reader
        .descendants(node.id)
        .filter((candidate) => candidate.level === NODE_LEVEL.WORD)
    );
  }

  private regionOf(node: HierarchyNode): EvidenceRegion | null {
    if (node.level === NODE_LEVEL.REGION) {
      return this.toEvidenceRegion(node);
    }
    let current = this.reader.parent(node.id);
    while (current !== null) {
      if (current.level === NODE_LEVEL.REGION) {
        return this.toEvidenceRegion(current);
      }
      current = this.reader.parent(current.id);
    }
    return null;
  }

  private toEvidenceRegion(node: HierarchyNode): EvidenceRegion {
    return node.regionType === undefined
      ? { id: node.id }
      : { id: node.id, regionType: node.regionType };
  }
}
