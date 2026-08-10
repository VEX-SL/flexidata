/**
 * Milestone 11 — layout-aware evidence.
 *
 * The evidence layer of the layout-aware path. It drives the priority ladder
 * through the M10 selection surface with zero scanning:
 *
 *     explicit region → reading-order neighbors → same block
 *     → same page → whole document
 *
 * The first scope that yields a value match wins (narrowest, most relevant);
 * every matching line inside that scope becomes evidence — nothing is skipped
 * and nothing is duplicated (scopes are searched in order and the search
 * stops once evidence exists).
 *
 * Determinism: the ladder, the value matching and the confidence combination
 * are pure functions of the frozen layout — identical OCR + identical field
 * always produce identical evidence. No randomness, no hash-order dependence.
 *
 * Confidence: `combineConfidence` deterministically averages the six existing
 * layout component means (OCR, geometric, structural, boundary, typological,
 * order) so the score is OCR + layout + reading-order confidence — the M2
 * frozen model is reused, never replaced, and a new confidence model is never
 * introduced. Without layout the previous OCR-only confidence stands.
 *
 * Fallback: the provider returns an empty array when layout is unavailable so
 * the caller's OCR-only path runs unchanged; extraction never fails because
 * layout failed.
 */
import type {
  FieldEvidence,
  FieldSchema,
  FieldValue,
  OcrLine,
} from "@/lib/pipeline/types";
import { normalizeText } from "@/lib/pipeline/ocr";
import { spanBox } from "@/lib/pipeline/geometry";
import type { ConfidenceProfile } from "@/lib/layout";
import { COMPONENT_KEYS } from "@/lib/layout";
import { LayoutAwareReader } from "./layout-aware-reader";
import type { LayoutLineView } from "./layout-aware-reader";
import { LayoutAwareSelector } from "./layout-aware-selector";
import type { EvidenceScope } from "./layout-aware-selector";
import { derivedVariants, valueNeedles } from "@/lib/pipeline/extractor/grounding";

/** Layout evidence carries the scope it was found in (proof of the ladder). */
export interface LayoutFieldEvidence extends FieldEvidence {
  /** 0-based position of the winning scope in the ladder. */
  readonly layoutRank: number;
  /** The ladder scope that produced this evidence. */
  readonly scope: EvidenceScope;
}

/** Options for the layout-aware evidence builder. */
export interface LayoutEvidenceOptions {
  /** Longest normalized needle considered (guards noisy OCR noise). */
  readonly maxSpanChars: number;
}

const DEFAULT_OPTIONS: LayoutEvidenceOptions = Object.freeze({
  maxSpanChars: 120,
});

/** A provider that composes with the OCR-only grounding path. */
export type LayoutEvidenceProvider = (
  field: FieldSchema,
  fv: FieldValue
) => readonly FieldEvidence[];

/** Shared deterministic selector (stateless, reused safely). */
const DEFAULT_SELECTOR: LayoutAwareSelector = new LayoutAwareSelector();

/** Readers are keyed by the frozen OCR so stages share one build per doc. */
const READER_CACHE = new WeakMap<import("@/lib/pipeline/types").OcrDocument, LayoutAwareReader>();

/**
 * Get (or lazily build) the layout-aware reader for an OCR document. The
 * WeakMap cache means a single extraction builds the layout once no matter how
 * many stages ask; the build itself is deterministic, so caching changes
 * nothing but runtime.
 */
export function layoutReaderFor(ocr: import("@/lib/pipeline/types").OcrDocument): LayoutAwareReader {
  let reader = READER_CACHE.get(ocr);
  if (reader === undefined) {
    reader = new LayoutAwareReader(ocr);
    READER_CACHE.set(ocr, reader);
  }
  return reader;
}

/**
 * Deterministic confidence combination: the mean of the MEASURED component
 * means of the frozen M2 `ConfidenceProfile`. Components the profile never
 * measured (NA, presence `measured=false`) are excluded, so an OCR-only line
 * scores its OCR confidence directly instead of being diluted by five zeros.
 * A profile without a presence mask falls back to the mean of all six (the
 * pre-M13 behavior). Reuses the M2 model as-is — no new confidence model.
 */
export function combineConfidence(profile: ConfidenceProfile): number {
  const measured = profile.measured;
  if (measured === undefined) {
    const parts = [
      profile.ocr.mean,
      profile.geometric.mean,
      profile.structural.mean,
      profile.boundary.mean,
      profile.typological.mean,
      profile.order.mean,
    ];
    return clamp(parts.reduce((s, n) => s + n, 0) / parts.length);
  }
  let sum = 0;
  let count = 0;
  for (const key of COMPONENT_KEYS) {
    if (measured[key]) {
      sum += profile[key].mean;
      count += 1;
    }
  }
  return clamp(count === 0 ? 0 : sum / count);
}

/**
 * Build layout-aware evidence for a field by walking the priority ladder.
 * Returns the winning scope plus its evidence (empty when nothing matched).
 */
export function buildLayoutAwareEvidence(
  reader: LayoutAwareReader,
  field: FieldSchema,
  searchValues: readonly string[],
  selector: LayoutAwareSelector = DEFAULT_SELECTOR,
  options: Partial<LayoutEvidenceOptions> = {}
): { evidence: readonly LayoutFieldEvidence[]; scope: EvidenceScope | null } {
  const opts: LayoutEvidenceOptions = { ...DEFAULT_OPTIONS, ...options };
  if (!reader.isLayoutAvailable) {
    return { evidence: Object.freeze([]), scope: null };
  }
  const needles = dedupeNeedles(searchValues);
  if (needles.length === 0) {
    return { evidence: Object.freeze([]), scope: null };
  }
  const plan = selector.planFor(field);
  const rankByScope = new Map<EvidenceScope, number>();
  plan.scopeOrder.forEach((scope, rank) => rankByScope.set(scope, rank));

  // Anchors stay the region-scope lines so the ladder expands outward from the
  // field's explicit region, never from an arbitrary position in the document.
  let regionAnchorLines: readonly LayoutLineView[] = Object.freeze([]);
  for (const scope of plan.scopeOrder) {
    const candidates =
      scope === "region"
        ? reader.linesInRegionTypes(plan.regionTypes)
        : scope === "neighbors"
          ? reader.readingNeighborLines(regionAnchorLines)
          : scope === "block"
            ? reader.linesInBlocks(reader.blockIdsOf(regionAnchorLines))
            : scope === "page"
              ? reader.linesOnPage(reader.pageIndicesOf(regionAnchorLines))
              : reader.allLineViews();
    if (scope === "region") regionAnchorLines = candidates;

    const matched = collectMatches(reader, candidates, needles, opts);
    if (matched.length > 0) {
      const rank = rankByScope.get(scope) ?? 0;
      return {
        evidence: Object.freeze(
          matched.map((entry) => Object.freeze({ ...entry, layoutRank: rank, scope }))
        ),
        scope,
      };
    }
  }
  return { evidence: Object.freeze([]), scope: null };
}

/**
 * Build the layout-guided prompt text for a field: every evidence line,
 * verbatim and in reading order, nothing skipped. Returns `usedLayout: false`
 * when layout is unavailable or empty so callers can keep the OCR-only input.
 */
export function collectEvidenceText(
  reader: LayoutAwareReader,
  field: FieldSchema,
  selector: LayoutAwareSelector = DEFAULT_SELECTOR,
  options: Partial<LayoutEvidenceOptions> = {}
): { text: string | undefined; evidence: readonly LayoutFieldEvidence[]; usedLayout: boolean } {
  if (!reader.isLayoutAvailable) {
    return { text: undefined, evidence: Object.freeze([]), usedLayout: false };
  }
  const fieldValues = field.enum ?? [];
  const searchValues = [field.key, ...fieldValues];
  const { evidence } = buildLayoutAwareEvidence(reader, field, searchValues, selector, options);
  if (evidence.length === 0) {
    return { text: undefined, evidence, usedLayout: true };
  }
  const parts: string[] = [];
  const seenLines = new Set<number>();
  for (const entry of evidence) {
    const lineIndex = entry.lineIndex;
    if (lineIndex === undefined || seenLines.has(lineIndex)) continue;
    seenLines.add(lineIndex);
    const lineText = entry.context ?? entry.quote;
    if (lineText !== undefined && lineText.trim().length > 0) parts.push(lineText);
  }
  return { text: parts.join("\n"), evidence, usedLayout: true };
}

/**
 * Build the evidence provider the grounding stage plugs into `groundExtraction`.
 * It returns layout evidence when layout is available, else an empty array so
 * the OCR-only path runs unchanged.
 */
export function createLayoutEvidenceProvider(
  reader: LayoutAwareReader,
  selector: LayoutAwareSelector = DEFAULT_SELECTOR,
  options: Partial<LayoutEvidenceOptions> = {}
): LayoutEvidenceProvider {
  return (field: FieldSchema, fv: FieldValue): readonly FieldEvidence[] => {
    if (!reader.isLayoutAvailable) return [];
    const primary = valueNeedles(field, fv);
    let result = buildLayoutAwareEvidence(reader, field, primary, selector, options).evidence;
    if (result.length > 0) return result;
    const derived = derivedVariants(field, fv.value);
    if (derived.length > 0) {
      result = buildLayoutAwareEvidence(reader, field, derived, selector, options).evidence;
    }
    return result;
  };
}

// ─── Matching ───────────────────────────────────────────────────────────────

/** All lines in the scope that contain any needle, in reading order. */
function collectMatches(
  reader: LayoutAwareReader,
  candidates: readonly LayoutLineView[],
  needles: readonly string[],
  options: LayoutEvidenceOptions
): readonly LayoutFieldEvidence[] {
  const out: LayoutFieldEvidence[] = [];
  // One OCR line is one atomic evidence unit: the layout may split a single
  // source line across several blocks, so duplicate line indexes collapse.
  const seenLines = new Set<number>();
  for (const view of candidates) {
    const lineIndex = view.node.sourceRefs[0]?.lineIndex ?? -1;
    if (lineIndex >= 0) {
      if (seenLines.has(lineIndex)) continue;
      seenLines.add(lineIndex);
    }
    const match = matchLine(reader, view, needles, options);
    if (match === null) continue;
    out.push(makeLayoutEvidence(reader, view, match.norm, "value-match"));
  }
  return out;
}

/** The winning normalized needle for a line, or null. */
function matchLine(
  reader: LayoutAwareReader,
  view: LayoutLineView,
  needles: readonly string[],
  options: LayoutEvidenceOptions
): { norm: string } | null {
  const raw = reader.lineText(view.node.id);
  const normLine = normalizeText(raw);
  if (normLine.length === 0) return null;
  for (const needle of needles) {
    const norm = normalizeText(needle);
    if (norm.length === 0 || norm.length > options.maxSpanChars) continue;
    if (normLine.includes(norm)) return { norm };
  }
  const tokens = new Set(normLine.split(/\s+/).filter(Boolean));
  for (const needle of needles) {
    const norm = normalizeText(needle);
    if (norm.length === 0 || norm.length > options.maxSpanChars) continue;
    if (tokens.has(norm)) return { norm };
  }
  return null;
}

/**
 * Build a `FieldEvidence` record from a layout line: the exact word span in
 * the source OCR (word indices + bbox via the shared geometry), verbatim
 * context, and the combined layout confidence.
 */
function makeLayoutEvidence(
  reader: LayoutAwareReader,
  view: LayoutLineView,
  normNeedle: string,
  role: FieldEvidence["role"]
): LayoutFieldEvidence {
  const lineIndex = view.node.sourceRefs[0]?.lineIndex ?? -1;
  const ocrLine: OcrLine | undefined = lineIndex >= 0 ? reader.ocr.lines[lineIndex] : undefined;
  const context = ocrLine?.text ?? reader.lineText(view.node.id);

  const span = ocrLine === undefined ? null : findWordSpan(ocrLine, normNeedle);
  const quote =
    span !== null && ocrLine !== undefined
      ? ocrLine.words.slice(span.start, span.end + 1).map((w) => w.text).join(" ")
      : context;
  const wordIndices = span === null ? undefined : range(span.start, span.end + 1);
  const bbox = span !== null && ocrLine !== undefined ? spanBox(ocrLine, span.start, span.end) : undefined;

  const entry = reader.evidenceFor(view.node.id);
  const confidence =
    entry !== undefined
      ? combineConfidence(entry.confidenceProfile)
      : ocrLine === undefined
        ? 1
        : meanWordConfidence(ocrLine) ?? 1;

  return {
    quote,
    lineIndex: lineIndex >= 0 ? lineIndex : undefined,
    wordIndices,
    bbox,
    role,
    // Provenance stays in the shared OCR vocabulary so downstream consumers
    // treat layout evidence exactly like OCR evidence; the layout ladder is
    // recorded separately in `layoutRank` / `scope`.
    source: "ocr",
    confidence,
    context,
    layoutRank: 0,
    scope: "document",
  };
}

/** Minimal contiguous word span whose joined text contains the needle. */
function findWordSpan(line: OcrLine, normNeedle: string): { start: number; end: number } | null {
  const words = line.words;
  if (words.length === 0 || normNeedle.length === 0) return null;
  const normWords = words.map((w) => normalizeText(w.text));
  let best: { start: number; end: number } | null = null;
  for (let start = 0; start < normWords.length; start++) {
    let acc = normWords[start];
    if (acc && acc.includes(normNeedle)) {
      if (!best || start + 1 - start < best.end - best.start + 1) best = { start, end: start };
      continue;
    }
    for (let end = start + 1; end < normWords.length; end++) {
      acc = `${acc} ${normWords[end]}`;
      if (acc.includes(normNeedle)) {
        if (!best || end - start < best.end - best.start) best = { start, end };
        break;
      }
      if (acc.length > normNeedle.length * 2) break;
    }
  }
  return best;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function dedupeNeedles(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const norm = normalizeText(value);
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return Object.freeze(out);
}

function meanWordConfidence(line: OcrLine): number | undefined {
  const wordConfs = line.words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  if (wordConfs.length > 0) return mean(wordConfs);
  return typeof line.confidence === "number" ? line.confidence : undefined;
}

function mean(values: readonly number[]): number {
  return values.reduce((s, n) => s + n, 0) / values.length;
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
