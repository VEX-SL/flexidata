/**
 * Milestone 5 adaptive region classification.
 *
 * Assigns a semantic region role (Header/Body/Footer/Sidebar/Table/
 * FormField/Stamp/Annotation/SignatureZone) to each M4 structural region using
 * ONLY the region's geometry features (region-features.ts) and the document's
 * own feature distribution. Two hard rules:
 *
 *   1. No OCR text, labels, keywords, merchant names, regexes or language is
 *      ever inspected — classification evidence is geometry only.
 *   2. No fixed geometry thresholds. Every cutoff is derived from the page's
 *      own region-feature distribution (median/quantiles); a small named
 *      constant is only used when statistics are impossible (an empty page),
 *      and every such fallback is recorded in the output threshold set.
 *
 * Every decision returns its primary type, a confidence profile (reusing the
 * Milestone 2 confidence framework: geometric + typological components),
 * competing candidates with scores, per-feature explanation evidence, and the
 * feature values used — the classifier never guesses silently.
 *
 * Determinism: identical inputs reproduce identical classifications; ties are
 * broken lexicographically by type, and the page's regions are walked in the
 * hierarchy's deterministic order.
 */
import type { LayoutBlock } from "./blocks";
import type { LayoutHierarchy } from "./hierarchy";
import { NODE_LEVEL } from "./node-levels";
import type { RegionType } from "./region-types";
import { REGION_TYPE } from "./region-types";
import { createConfidenceComponents, createConfidenceProfile } from "./confidence";
import type {
  CompositeScorePolicy,
  ConfidenceProfile,
} from "./confidence";
import { median, medianAbsoluteDeviation, quantile } from "./stats";
import type { RegionFeatureSet } from "./region-features";
import { readRegionFeature } from "./region-features";
import type { NumericRegionFeature } from "./region-features";
import { extractPageRegionFeatures } from "./region-features";

/** Epsilon for ratio denominators and float comparisons. */
export const CLASSIFICATION_EPSILON = 1e-9;

/**
 * Fallback floor for the UNKNOWN decision. The adaptive threshold is
 * `max(UNKNOWN_SCORE_FLOOR, median(page top scores) × UNKNOWN_SCALE)`; the
 * floor only applies when the page's own score distribution is degenerate.
 */
export const UNKNOWN_SCORE_FLOOR = 0.35;

/** Scale applied to the page's median top score for the UNKNOWN threshold. */
export const UNKNOWN_SCALE = 0.5;

/** Multiplier applied to a candidate's score when its gate condition fails. */
export const GATE_PENALTY = 0.25;

/** One named statistic with its provenance. */
export interface RegionStatisticSample {
  readonly value: number;
  /** Number of regions the statistic was computed over (0 → fallback). */
  readonly sampleCount: number;
  readonly method:
    | "median"
    | "quantile"
    | "max"
    | "mad"
    | "derived"
    | "fallback";
}

/** The page-level statistics the classifier derived from region features. */
export interface PageRegionStatistics {
  readonly pageIndex: number;
  readonly regionCount: number;
  /** Named statistics keyed by threshold name. */
  readonly stats: Readonly<Record<string, RegionStatisticSample>>;
}

/** The adaptive thresholds a page's classification actually used. */
export interface RegionThresholdSet {
  readonly pageIndex: number;
  readonly regionCount: number;
  readonly statistics: PageRegionStatistics;
  /** Final numeric thresholds compared against (stats values + derived). */
  readonly decisions: Readonly<Record<string, number>>;
  /** Threshold names that fell back to constants because statistics failed. */
  readonly fallbacks: readonly string[];
}

/** One piece of per-feature explanation evidence for a decision. */
export interface DecisionEvidence {
  readonly feature: NumericRegionFeature;
  /** The region's actual feature value (matches the feature set). */
  readonly value: number;
  /** Name of the adaptive threshold compared against. */
  readonly thresholdName: string;
  /** The threshold's numeric value (matches the threshold set). */
  readonly threshold: number;
  readonly relation: "above" | "below";
  /** The region type this evidence supports. */
  readonly supports: RegionType;
  /** Contribution weight of this evidence, in [0, 1]. */
  readonly weight: number;
}

/** A scored competing candidate. */
export interface RegionCandidateScore {
  readonly type: RegionType;
  readonly score: number;
  readonly reasons: readonly string[];
}

/** The immutable classification decision for one region. */
export interface RegionClassification {
  readonly regionId: string;
  readonly pageIndex: number;
  readonly type: RegionType;
  readonly confidence: ConfidenceProfile;
  /** All scored candidates, best first, deterministic. */
  readonly candidates: readonly RegionCandidateScore[];
  readonly topScore: number;
  /** top − runner-up, in [0, 1]; 0 for a tie. */
  readonly margin: number;
  /** Every piece of per-feature evidence across all candidates. */
  readonly explanation: readonly DecisionEvidence[];
  /**
   * The evidence supporting the winning type — the direct case for the
   * decision. Empty when the decision is UNKNOWN (no type won).
   */
  readonly primaryEvidence: readonly DecisionEvidence[];
  /**
   * The evidence supporting the closest competing candidate — the strongest
   * alternative story, so the reader sees how the decision was a close call or
   * a landslide. For an UNKNOWN decision it holds the top candidate's case.
   */
  readonly secondaryEvidence: readonly DecisionEvidence[];
  /** Non-numeric notes (e.g. gate rejections, block orientation). */
  readonly notes: readonly string[];
  readonly features: RegionFeatureSet;
}

/** The full classification outcome of a document. */
export interface RegionClassificationOutcome {
  readonly classifications: readonly RegionClassification[];
  readonly thresholdSets: readonly RegionThresholdSet[];
}

export interface ClassifyRegionsOptions {
  /** Composite confidence policy for the decision confidence profiles. */
  readonly confidencePolicy?: CompositeScorePolicy;
}

/** Classify every region of every page of the hierarchy. */
export function classifyRegions(
  hierarchy: LayoutHierarchy,
  blocks: readonly LayoutBlock[] = [],
  options: ClassifyRegionsOptions = {}
): RegionClassificationOutcome {
  const policy = options.confidencePolicy;
  const pages = hierarchy.nodesAtLevel(NODE_LEVEL.PAGE);

  const classifications: RegionClassification[] = [];
  const thresholdSets: RegionThresholdSet[] = [];

  for (const page of pages) {
    const featureSets = extractPageRegionFeatures(hierarchy, page, blocks);
    const statistics = computePageStatistics(page.metadata.index ?? 0, featureSets);
    const pageResult = classifyPage(featureSets, statistics, policy);
    thresholdSets.push(buildThresholdSet(pageResult.statistics));
    for (const classification of pageResult.classifications) {
      classifications.push(classification);
    }
  }

  return Object.freeze({
    classifications: Object.freeze(classifications),
    thresholdSets: Object.freeze(thresholdSets),
  });
}

// ─── Per-page classification ─────────────────────────────────────────────────

interface PageClassificationResult {
  readonly classifications: readonly RegionClassification[];
  /** The page statistics including the derived medianTopScore. */
  readonly statistics: PageRegionStatistics;
}

function classifyPage(
  featureSets: readonly RegionFeatureSet[],
  statistics: PageRegionStatistics,
  policy?: CompositeScorePolicy
): PageClassificationResult {
  const scored: ScoredRegion[] = featureSets.map((features) => {
    const result = scoreCandidates(features, statistics);
    return {
      features,
      candidates: result.candidates,
      explanation: result.explanation,
    };
  });

  const topScores = scored.map((s) => s.candidates[0].score);
  const medianTop = median(topScores);
  const unknownThreshold = Math.max(
    UNKNOWN_SCORE_FLOOR,
    medianTop * UNKNOWN_SCALE
  );

  const withTopStat: PageRegionStatistics = freeze({
    ...statistics,
    stats: freeze({
      ...statistics.stats,
      medianTopScore: freeze({
        value: medianTop,
        sampleCount: featureSets.length,
        method: featureSets.length > 0 ? "median" : "fallback",
      }),
    }),
  });

  const classifications = Object.freeze(
    scored.map((s) =>
      classifyScoredRegion(s, statistics.pageIndex, unknownThreshold, policy)
    )
  );
  return { classifications, statistics: withTopStat };
}

interface ScoredRegion {
  readonly features: RegionFeatureSet;
  readonly candidates: readonly RegionCandidateScore[];
  /** Evidence for every scored candidate (winner and competitors). */
  readonly explanation: readonly DecisionEvidence[];
}

function classifyScoredRegion(
  scored: ScoredRegion,
  pageIndex: number,
  unknownThreshold: number,
  policy?: CompositeScorePolicy
): RegionClassification {
  const top = scored.candidates[0];
  const second = scored.candidates[1];
  const topScore = top.score;
  const margin = clamp01(topScore - (second?.score ?? 0));
  const isUnknown = topScore < unknownThreshold;
  const type: RegionType = isUnknown ? REGION_TYPE.UNKNOWN : top.type;
  // Typological confidence is the RELATIVE margin: the winning candidate's
  // edge over its runner-up as a fraction of its own score. Ambiguous pages
  // (low top score, close race) collapse toward 0 while a decisive high-score
  // winner approaches 1 — the same raw gap reads differently on a weak vs a
  // strong top score. An UNKNOWN decision carries no typological confidence.
  const typological =
    isUnknown || topScore <= CLASSIFICATION_EPSILON
      ? 0
      : clamp01(margin / topScore);

  const confidence = createConfidenceProfile(
    [
      createConfidenceComponents(
        {
          ocr: 0,
          geometric: topScore,
          structural: 0,
          boundary: 0,
          typological,
          order: 0,
        },
        // Only the geometric and typological signals are genuinely measured
        // here; the zero placeholders above are not readings.
        { geometric: true, typological: true }
      ),
    ],
    policy
  );

  const notes: string[] = [];
  if (isUnknown) {
    notes.push(
      `no candidate is decisive: top score ${topScore.toFixed(3)} is below the adaptive floor ${unknownThreshold.toFixed(3)}`
    );
  }
  for (const candidate of scored.candidates) {
    if (candidate.reasons.length > 0) {
      notes.push(`${candidate.type}: ${candidate.reasons.join("; ")}`);
    }
  }

  const explanation = Object.freeze([...scored.explanation]);
  const winnerType = type;
  const competitorType = isUnknown
    ? top.type
    : (second?.type ?? top.type);
  const primaryEvidence = Object.freeze(
    explanation.filter((ev) => ev.supports === winnerType)
  );
  const secondaryEvidence = Object.freeze(
    explanation.filter((ev) => ev.supports === competitorType)
  );

  return freeze({
    regionId: scored.features.regionId,
    pageIndex,
    type,
    confidence,
    candidates: scored.candidates,
    topScore,
    margin,
    explanation,
    primaryEvidence,
    secondaryEvidence,
    notes: Object.freeze(notes),
    features: scored.features,
  });
}

interface ScoredCandidate extends RegionCandidateScore {
  readonly explanation: readonly DecisionEvidence[];
}

function scoreCandidates(
  features: RegionFeatureSet,
  statistics: PageRegionStatistics
): {
  candidates: readonly RegionCandidateScore[];
  explanation: readonly DecisionEvidence[];
} {
  const stats = statistics.stats;
  const scored: ScoredCandidate[] = [
    scoreHeader(features, stats),
    scoreBody(features, stats),
    scoreFooter(features, stats),
    scoreSidebar(features, stats),
    scoreTable(features, stats),
    scoreFormField(features, stats),
    scoreStamp(features, stats),
    scoreAnnotation(features, stats),
    scoreSignatureZone(features, stats),
  ];
  scored.sort(
    (a, b) => b.score - a.score || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)
  );
  const explanation: DecisionEvidence[] = [];
  for (const s of scored) {
    for (const ev of s.explanation) explanation.push(ev);
  }
  return {
    candidates: Object.freeze(
      scored.map((s) =>
        freeze({
          type: s.type,
          score: s.score,
          reasons: Object.freeze(s.reasons),
        })
      )
    ),
    explanation: Object.freeze(explanation),
  };
}

// ─── Candidate scorers ───────────────────────────────────────────────────────

function scoreHeader(
  features: RegionFeatureSet,
  stats: Readonly<Record<string, RegionStatisticSample>>
): ScoredCandidate {
  const q25CenterY = statValue(stats, "q25CenterY");
  const medianCenterY = statValue(stats, "medianCenterY");
  const madCenterY = statValue(stats, "madCenterY");
  const medianWidth = statValue(stats, "medianWidthRatio");
  const q75Height = statValue(stats, "q75HeightRatio");
  const medianDensity = statValue(stats, "medianDensity");
  const centerY = features.normalizedPosition.centerY;

  const topBonus = clamp01(1 - centerY);
  const absWidth = clamp01(features.widthRatio * 1.5);
  const short = 1 - ratio(features.heightRatio, q75Height);
  const aligned = features.alignmentScore;
  const content = ratio(features.density, medianDensity);
  const score =
    0.3 * topBonus + 0.3 * absWidth + 0.15 * short + 0.1 * aligned +
    0.15 * content;

  // A header must sit at the very top: above the top quartile AND above the
  // page's typical center minus its spread (median − MAD, clamped at 0). The
  // MAD term rejects a second "header" candidate stacked just under the real
  // one — two regions cannot both be the page's top band.
  const gatePass =
    centerY <= q25CenterY &&
    centerY <= Math.max(0, medianCenterY - madCenterY) + CLASSIFICATION_EPSILON &&
    features.widthRatio >= medianWidth * 0.5;

  const explanation = [
    evidence(
      features,
      "normalizedPosition.centerY",
      "q25CenterY",
      q25CenterY,
      "below",
      REGION_TYPE.HEADER,
      0.3
    ),
    evidence(
      features,
      "widthRatio",
      "q75WidthRatio",
      statValue(stats, "q75WidthRatio"),
      "above",
      REGION_TYPE.HEADER,
      0.3
    ),
    evidence(
      features,
      "heightRatio",
      "q75HeightRatio",
      q75Height,
      "below",
      REGION_TYPE.HEADER,
      0.15
    ),
    evidence(
      features,
      "alignmentScore",
      "medianAlignmentScore",
      statValue(stats, "medianAlignmentScore"),
      "above",
      REGION_TYPE.HEADER,
      0.1
    ),
    evidence(
      features,
      "density",
      "medianDensity",
      medianDensity,
      "above",
      REGION_TYPE.HEADER,
      0.15
    ),
  ];

  if (gatePass) return candidate(REGION_TYPE.HEADER, score, explanation, []);
  return candidate(REGION_TYPE.HEADER, score * GATE_PENALTY, explanation, [
    "gate rejected: not at the very top of the page or not wide enough",
  ]);
}

function scoreBody(
  features: RegionFeatureSet,
  stats: Readonly<Record<string, RegionStatisticSample>>
): ScoredCandidate {
  const medianArea = statValue(stats, "medianAreaRatio");
  const maxArea = statValue(stats, "maxAreaRatio");
  const medianDensity = statValue(stats, "medianDensity");
  const medianCoverage = statValue(stats, "medianPageCoverage");
  const medianAlignment = statValue(stats, "medianAlignmentScore");
  const medianChildren = statValue(stats, "medianChildCount");

  // "Large" is relative to the page's own biggest region — a thin band next to
  // a dominant body is not large just because every other band is also small.
  const large = ratio(features.areaRatio, maxArea);
  const dense = ratio(features.density, medianDensity);
  const covered = ratio(features.pageCoverage, medianCoverage);
  const aligned = features.alignmentScore;
  const score = 0.4 * large + 0.3 * dense + 0.2 * covered + 0.1 * aligned;

  const gatePass =
    features.areaRatio >= medianArea &&
    features.childCount <= Math.max(medianChildren * 2, 2);

  const explanation = [
    evidence(
      features,
      "areaRatio",
      "maxAreaRatio",
      maxArea,
      "below",
      REGION_TYPE.BODY,
      0.4
    ),
    evidence(
      features,
      "density",
      "medianDensity",
      medianDensity,
      "above",
      REGION_TYPE.BODY,
      0.3
    ),
    evidence(
      features,
      "pageCoverage",
      "medianPageCoverage",
      medianCoverage,
      "above",
      REGION_TYPE.BODY,
      0.2
    ),
    evidence(
      features,
      "alignmentScore",
      "medianAlignmentScore",
      medianAlignment,
      "above",
      REGION_TYPE.BODY,
      0.1
    ),
  ];

  if (gatePass) return candidate(REGION_TYPE.BODY, score, explanation, []);
  return candidate(REGION_TYPE.BODY, score * GATE_PENALTY, explanation, [
    "gate rejected: region is not among the larger regions or has too many blocks",
  ]);
}

function scoreFooter(
  features: RegionFeatureSet,
  stats: Readonly<Record<string, RegionStatisticSample>>
): ScoredCandidate {
  const q75CenterY = statValue(stats, "q75CenterY");
  const medianWidth = statValue(stats, "medianWidthRatio");
  const q75Width = statValue(stats, "q75WidthRatio");
  const q75Height = statValue(stats, "q75HeightRatio");
  const medianDensity = statValue(stats, "medianDensity");
  const medianWhitespace = statValue(stats, "medianWhitespace");
  const madWhitespace = statValue(stats, "madWhitespace");
  const centerY = features.normalizedPosition.centerY;

  const bottomBonus = clamp01(centerY);
  const absWidth = clamp01(features.widthRatio * 1.5);
  const short = 1 - ratio(features.heightRatio, q75Height);
  const aligned = features.alignmentScore;
  const content = ratio(features.density, medianDensity);
  const score =
    0.3 * bottomBonus + 0.25 * absWidth + 0.15 * short + 0.1 * aligned +
    0.2 * content;

  // A footer carries content: whitespace must stay within the page's own
  // typical whitespace plus one MAD of spread — a fully blank bottom band is
  // a signature zone, not a footer.
  const gatePass =
    centerY >= q75CenterY &&
    features.widthRatio >= medianWidth * 0.5 &&
    features.whitespaceRatio <= medianWhitespace + madWhitespace;

  const explanation = [
    evidence(
      features,
      "normalizedPosition.centerY",
      "q75CenterY",
      q75CenterY,
      "above",
      REGION_TYPE.FOOTER,
      0.3
    ),
    evidence(
      features,
      "widthRatio",
      "q75WidthRatio",
      q75Width,
      "above",
      REGION_TYPE.FOOTER,
      0.25
    ),
    evidence(
      features,
      "heightRatio",
      "q75HeightRatio",
      q75Height,
      "below",
      REGION_TYPE.FOOTER,
      0.15
    ),
    evidence(
      features,
      "alignmentScore",
      "medianAlignmentScore",
      statValue(stats, "medianAlignmentScore"),
      "above",
      REGION_TYPE.FOOTER,
      0.1
    ),
    evidence(
      features,
      "density",
      "medianDensity",
      medianDensity,
      "above",
      REGION_TYPE.FOOTER,
      0.2
    ),
    evidence(
      features,
      "whitespaceRatio",
      "medianWhitespace",
      medianWhitespace,
      "below",
      REGION_TYPE.FOOTER,
      0.2
    ),
  ];

  if (gatePass) return candidate(REGION_TYPE.FOOTER, score, explanation, []);
  return candidate(REGION_TYPE.FOOTER, score * GATE_PENALTY, explanation, [
    "gate rejected: not in the bottom quartile, not wide enough, or a blank band",
  ]);
}

function scoreSidebar(
  features: RegionFeatureSet,
  stats: Readonly<Record<string, RegionStatisticSample>>
): ScoredCandidate {
  const medianWidth = statValue(stats, "medianWidthRatio");
  const medianHeight = statValue(stats, "medianHeightRatio");

  const edge = clamp01(2 * Math.abs(features.normalizedPosition.centerX - 0.5));
  const narrow = 1 - ratio(features.widthRatio, medianWidth);
  const tall = ratio(features.heightRatio, medianHeight);
  const score = 0.4 * edge + 0.35 * narrow + 0.25 * tall;

  const gatePass =
    features.widthRatio <= medianWidth && features.heightRatio >= medianHeight;

  const explanation = [
    evidence(
      features,
      "normalizedPosition.centerX",
      "medianWidthRatio",
      medianWidth,
      "above",
      REGION_TYPE.SIDEBAR,
      0.4
    ),
    evidence(
      features,
      "widthRatio",
      "medianWidthRatio",
      medianWidth,
      "below",
      REGION_TYPE.SIDEBAR,
      0.35
    ),
    evidence(
      features,
      "heightRatio",
      "medianHeightRatio",
      medianHeight,
      "above",
      REGION_TYPE.SIDEBAR,
      0.25
    ),
  ];

  if (gatePass) return candidate(REGION_TYPE.SIDEBAR, score, explanation, []);
  return candidate(REGION_TYPE.SIDEBAR, score * GATE_PENALTY, explanation, [
    "gate rejected: region is not a narrow-and-tall column",
  ]);
}

function scoreTable(
  features: RegionFeatureSet,
  stats: Readonly<Record<string, RegionStatisticSample>>
): ScoredCandidate {
  const medianChildren = statValue(stats, "medianChildCount");
  const medianDensity = statValue(stats, "medianDensity");
  const q75Whitespace = statValue(stats, "q75Whitespace");

  const blocks = ratio(features.childCount, Math.max(medianChildren * 2, 2));
  const dense = ratio(features.density, medianDensity * 1.25);
  const aligned = features.alignmentScore;
  const rows = features.gridScore;
  const tight = 1 - ratio(features.whitespaceRatio, q75Whitespace);
  const score =
    0.3 * blocks + 0.25 * dense + 0.2 * aligned + 0.15 * rows + 0.1 * tight;

  const gatePass =
    features.childCount >= 2 && features.density >= medianDensity;

  const explanation = [
    evidence(
      features,
      "childCount",
      "medianChildCount",
      medianChildren,
      "above",
      REGION_TYPE.TABLE,
      0.3
    ),
    evidence(
      features,
      "density",
      "medianDensity",
      medianDensity,
      "above",
      REGION_TYPE.TABLE,
      0.25
    ),
    evidence(
      features,
      "alignmentScore",
      "medianAlignmentScore",
      statValue(stats, "medianAlignmentScore"),
      "above",
      REGION_TYPE.TABLE,
      0.2
    ),
    evidence(
      features,
      "gridScore",
      "medianGridScore",
      statValue(stats, "medianGridScore"),
      "above",
      REGION_TYPE.TABLE,
      0.15
    ),
    evidence(
      features,
      "whitespaceRatio",
      "q75Whitespace",
      q75Whitespace,
      "below",
      REGION_TYPE.TABLE,
      0.1
    ),
  ];

  if (gatePass) return candidate(REGION_TYPE.TABLE, score, explanation, []);
  return candidate(REGION_TYPE.TABLE, score * GATE_PENALTY, explanation, [
    "gate rejected: region has too few blocks or is not dense",
  ]);
}

function scoreFormField(
  features: RegionFeatureSet,
  stats: Readonly<Record<string, RegionStatisticSample>>
): ScoredCandidate {
  const maxWhitespace = statValue(stats, "maxWhitespace");
  const medianHeight = statValue(stats, "medianHeightRatio");
  const medianDensity = statValue(stats, "medianDensity");
  const medianChildren = statValue(stats, "medianChildCount");
  const q75Width = statValue(stats, "q75WidthRatio");

  // A form field is an input row: a mostly-blank, thin band whose sparse
  // content does not fill its width. Blankness is measured against the page's
  // own blankest band (max whitespace), so a blank row on a dense page still
  // reads as blank; the remaining terms reward thinness, sparsity and
  // alignment with siblings.
  const blank = ratio(features.whitespaceRatio, maxWhitespace);
  const short = 1 - ratio(features.heightRatio, medianHeight);
  const sparse = 1 - ratio(features.density, medianDensity);
  const aligned = features.alignmentScore;
  const narrow = 1 - ratio(features.widthRatio, q75Width);
  const score =
    0.55 * blank + 0.15 * short + 0.1 * sparse + 0.1 * aligned +
    0.1 * narrow;

  const gatePass =
    features.whitespaceRatio >= statValue(stats, "medianWhitespace") &&
    features.childCount <= Math.max(medianChildren, 1);

  const explanation = [
    evidence(
      features,
      "whitespaceRatio",
      "maxWhitespace",
      maxWhitespace,
      "above",
      REGION_TYPE.FORM_FIELD,
      0.55
    ),
    evidence(
      features,
      "heightRatio",
      "medianHeightRatio",
      medianHeight,
      "below",
      REGION_TYPE.FORM_FIELD,
      0.15
    ),
    evidence(
      features,
      "density",
      "medianDensity",
      medianDensity,
      "below",
      REGION_TYPE.FORM_FIELD,
      0.1
    ),
    evidence(
      features,
      "alignmentScore",
      "medianAlignmentScore",
      statValue(stats, "medianAlignmentScore"),
      "above",
      REGION_TYPE.FORM_FIELD,
      0.1
    ),
    evidence(
      features,
      "widthRatio",
      "q75WidthRatio",
      q75Width,
      "below",
      REGION_TYPE.FORM_FIELD,
      0.1
    ),
  ];

  if (gatePass) return candidate(REGION_TYPE.FORM_FIELD, score, explanation, []);
  return candidate(REGION_TYPE.FORM_FIELD, score * GATE_PENALTY, explanation, [
    "gate rejected: region is not a blank band",
  ]);
}

function scoreStamp(
  features: RegionFeatureSet,
  stats: Readonly<Record<string, RegionStatisticSample>>
): ScoredCandidate {
  const medianArea = statValue(stats, "medianAreaRatio");

  const compact = 1 - clamp01(Math.abs(features.aspectRatio - 1));
  const small = 1 - ratio(features.areaRatio, medianArea * 2);
  const isolated = features.isolationScore;
  const floating = 1 - features.containmentScore;
  const score =
    0.3 * compact + 0.25 * small + 0.25 * isolated + 0.2 * floating;

  const gatePass = features.areaRatio <= medianArea;

  const explanation = [
    evidence(
      features,
      "aspectRatio",
      "medianAspectRatio",
      statValue(stats, "medianAspectRatio"),
      "above",
      REGION_TYPE.STAMP,
      0.3
    ),
    evidence(
      features,
      "areaRatio",
      "medianAreaRatio",
      medianArea,
      "below",
      REGION_TYPE.STAMP,
      0.25
    ),
    evidence(
      features,
      "isolationScore",
      "medianIsolationScore",
      statValue(stats, "medianIsolationScore"),
      "above",
      REGION_TYPE.STAMP,
      0.25
    ),
    evidence(
      features,
      "containmentScore",
      "medianContainmentScore",
      statValue(stats, "medianContainmentScore"),
      "below",
      REGION_TYPE.STAMP,
      0.2
    ),
  ];

  if (gatePass) return candidate(REGION_TYPE.STAMP, score, explanation, []);
  return candidate(REGION_TYPE.STAMP, score * GATE_PENALTY, explanation, [
    "gate rejected: region is not small",
  ]);
}

function scoreAnnotation(
  features: RegionFeatureSet,
  stats: Readonly<Record<string, RegionStatisticSample>>
): ScoredCandidate {
  const medianArea = statValue(stats, "medianAreaRatio");
  const medianDensity = statValue(stats, "medianDensity");
  const medianWidth = statValue(stats, "medianWidthRatio");
  const q25Width = statValue(stats, "q25WidthRatio");
  const q75CenterOffset = statValue(stats, "q75CenterOffsetX");

  // A margin note is small, narrow and pushed into a margin. Its strongest
  // signal is the off-center placement (centerOffsetX); width is measured
  // against the page's own narrowest quarter.
  const marginX = clamp01(features.centerOffsetX * 2);
  const narrow = 1 - ratio(features.widthRatio, q25Width);
  const small = 1 - ratio(features.areaRatio, medianArea * 2);
  const isolated = features.isolationScore;
  const sparse = 1 - ratio(features.density, medianDensity);
  const margin = 1 - features.containmentScore;
  const score =
    0.25 * marginX + 0.15 * narrow + 0.15 * small + 0.15 * isolated +
    0.15 * sparse + 0.15 * margin;

  const gatePass =
    features.areaRatio <= medianArea &&
    features.widthRatio <= medianWidth &&
    features.centerOffsetX >= q75CenterOffset;

  const explanation = [
    evidence(
      features,
      "centerOffsetX",
      "q75CenterOffsetX",
      q75CenterOffset,
      "above",
      REGION_TYPE.ANNOTATION,
      0.25
    ),
    evidence(
      features,
      "widthRatio",
      "q25WidthRatio",
      q25Width,
      "below",
      REGION_TYPE.ANNOTATION,
      0.15
    ),
    evidence(
      features,
      "areaRatio",
      "medianAreaRatio",
      medianArea,
      "below",
      REGION_TYPE.ANNOTATION,
      0.15
    ),
    evidence(
      features,
      "isolationScore",
      "medianIsolationScore",
      statValue(stats, "medianIsolationScore"),
      "above",
      REGION_TYPE.ANNOTATION,
      0.15
    ),
    evidence(
      features,
      "density",
      "medianDensity",
      medianDensity,
      "below",
      REGION_TYPE.ANNOTATION,
      0.15
    ),
    evidence(
      features,
      "containmentScore",
      "medianContainmentScore",
      statValue(stats, "medianContainmentScore"),
      "below",
      REGION_TYPE.ANNOTATION,
      0.15
    ),
  ];

  if (gatePass) return candidate(REGION_TYPE.ANNOTATION, score, explanation, []);
  return candidate(REGION_TYPE.ANNOTATION, score * GATE_PENALTY, explanation, [
    "gate rejected: region is not a small narrow margin note",
  ]);
}

function scoreSignatureZone(
  features: RegionFeatureSet,
  stats: Readonly<Record<string, RegionStatisticSample>>
): ScoredCandidate {
  const q75CenterY = statValue(stats, "q75CenterY");
  const medianWidth = statValue(stats, "medianWidthRatio");
  const medianHeight = statValue(stats, "medianHeightRatio");
  const q75Whitespace = statValue(stats, "q75Whitespace");
  const maxWhitespace = statValue(stats, "maxWhitespace");
  const centerY = features.normalizedPosition.centerY;

  const low = clamp01(centerY);
  const wide = ratio(features.widthRatio, medianWidth);
  const short = 1 - ratio(features.heightRatio, medianHeight);
  // Blankness is measured against the page's own blankest band, so a
  // content-carrying footer does not read as a signature zone even when most
  // regions are dense and the typical whitespace reference is zero.
  const blank = ratio(features.whitespaceRatio, maxWhitespace);
  const score = 0.35 * low + 0.25 * wide + 0.2 * short + 0.2 * blank;

  const gatePass =
    centerY >= q75CenterY && features.whitespaceRatio >= q75Whitespace;

  const explanation = [
    evidence(
      features,
      "normalizedPosition.centerY",
      "q75CenterY",
      q75CenterY,
      "above",
      REGION_TYPE.SIGNATURE_ZONE,
      0.35
    ),
    evidence(
      features,
      "widthRatio",
      "medianWidthRatio",
      medianWidth,
      "above",
      REGION_TYPE.SIGNATURE_ZONE,
      0.25
    ),
    evidence(
      features,
      "heightRatio",
      "medianHeightRatio",
      medianHeight,
      "below",
      REGION_TYPE.SIGNATURE_ZONE,
      0.2
    ),
    evidence(
      features,
      "whitespaceRatio",
      "maxWhitespace",
      maxWhitespace,
      "above",
      REGION_TYPE.SIGNATURE_ZONE,
      0.2
    ),
  ];

  if (gatePass) {
    return candidate(REGION_TYPE.SIGNATURE_ZONE, score, explanation, []);
  }
  return candidate(REGION_TYPE.SIGNATURE_ZONE, score * GATE_PENALTY, explanation, [
    "gate rejected: region is not a bottom blank band",
  ]);
}

// ─── Statistics ──────────────────────────────────────────────────────────────

function computePageStatistics(
  pageIndex: number,
  featureSets: readonly RegionFeatureSet[]
): PageRegionStatistics {
  const count = featureSets.length;
  const stats: Record<string, RegionStatisticSample> = {};

  const addStat = (
    key: string,
    method: RegionStatisticSample["method"],
    estimator: (values: readonly number[]) => number,
    values: (f: RegionFeatureSet) => number
  ) => {
    stats[key] = sampleFrom(estimator, method, key, count, featureSets, values);
  };
  const addMedian = (key: string, values: (f: RegionFeatureSet) => number) => {
    addStat(key, "median", median, values);
  };
  const addMax = (key: string, values: (f: RegionFeatureSet) => number) => {
    addStat(key, "max", maxValue, values);
  };
  const addMad = (key: string, values: (f: RegionFeatureSet) => number) => {
    addStat(key, "mad", medianAbsoluteDeviation, values);
  };
  const addQuantile = (
    key: string,
    q: number,
    values: (f: RegionFeatureSet) => number
  ) => {
    addStat(key, "quantile", (xs) => quantile(xs, q), values);
  };
  const addIqr = (
    key: string,
    q25Key: string,
    q75Key: string
  ) => {
    const low = stats[q25Key]?.value ?? 0;
    const high = stats[q75Key]?.value ?? 0;
    stats[key] = freeze({
      value: count > 0 ? Math.max(0, high - low) : 0,
      sampleCount: count,
      method: count > 0 ? "derived" : "fallback",
    });
  };

  addMedian("medianCenterY", (f) => f.normalizedPosition.centerY);
  addQuantile("q25CenterY", 0.25, (f) => f.normalizedPosition.centerY);
  addQuantile("q75CenterY", 0.75, (f) => f.normalizedPosition.centerY);
  addMad("madCenterY", (f) => f.normalizedPosition.centerY);
  addIqr("iqrCenterY", "q25CenterY", "q75CenterY");
  addMedian("medianCenterX", (f) => f.normalizedPosition.centerX);
  addMad("madCenterX", (f) => f.normalizedPosition.centerX);
  addQuantile(
    "q75CenterOffsetX",
    0.75,
    (f) => f.centerOffsetX
  );
  addMedian("medianWidthRatio", (f) => f.widthRatio);
  addQuantile("q25WidthRatio", 0.25, (f) => f.widthRatio);
  addQuantile("q75WidthRatio", 0.75, (f) => f.widthRatio);
  addMad("madWidthRatio", (f) => f.widthRatio);
  addIqr("iqrWidthRatio", "q25WidthRatio", "q75WidthRatio");
  addMedian("medianHeightRatio", (f) => f.heightRatio);
  addQuantile("q75HeightRatio", 0.75, (f) => f.heightRatio);
  addMedian("medianAreaRatio", (f) => f.areaRatio);
  addQuantile("q25AreaRatio", 0.25, (f) => f.areaRatio);
  addQuantile("q75AreaRatio", 0.75, (f) => f.areaRatio);
  addMax("maxAreaRatio", (f) => f.areaRatio);
  addMad("madAreaRatio", (f) => f.areaRatio);
  addIqr("iqrAreaRatio", "q25AreaRatio", "q75AreaRatio");
  addMedian("medianAspectRatio", (f) => f.aspectRatio);
  addMedian("medianDensity", (f) => f.density);
  addMedian("medianWhitespace", (f) => f.whitespaceRatio);
  addQuantile("q75Whitespace", 0.75, (f) => f.whitespaceRatio);
  addMax("maxWhitespace", (f) => f.whitespaceRatio);
  addMad("madWhitespace", (f) => f.whitespaceRatio);
  addMedian("medianAlignmentScore", (f) => f.alignmentScore);
  addMedian("medianGridScore", (f) => f.gridScore);
  addMedian("medianNeighborCount", (f) => f.neighborCount);
  addMedian("medianIsolationScore", (f) => f.isolationScore);
  addMedian("medianContainmentScore", (f) => f.containmentScore);
  addMedian("medianPageCoverage", (f) => f.pageCoverage);
  addMedian("medianChildCount", (f) => f.childCount);

  return freeze({
    pageIndex,
    regionCount: count,
    stats: freeze(stats),
  });
}

function sampleFrom(
  estimator: (values: readonly number[]) => number,
  method: RegionStatisticSample["method"],
  key: string,
  count: number,
  featureSets: readonly RegionFeatureSet[],
  values: (f: RegionFeatureSet) => number
): RegionStatisticSample {
  if (count === 0) {
    return freeze({
      value: 0,
      sampleCount: 0,
      method: "fallback",
    });
  }
  return freeze({
    value: estimator(featureSets.map(values)),
    sampleCount: count,
    method,
  });
}

function maxValue(values: readonly number[]): number {
  let best = 0;
  for (const v of values) {
    if (v > best) best = v;
  }
  return best;
}

function buildThresholdSet(
  statistics: PageRegionStatistics
): RegionThresholdSet {
  const statsEntries = Object.entries(statistics.stats);
  const decisions: Record<string, number> = {};
  const fallbacks: string[] = [];
  for (const [name, sample] of statsEntries) {
    decisions[name] = sample.value;
    if (sample.sampleCount === 0) fallbacks.push(name);
  }

  const medianTop = statValue(statistics.stats, "medianTopScore");
  const unknownThreshold = Math.max(
    UNKNOWN_SCORE_FLOOR,
    medianTop * UNKNOWN_SCALE
  );
  const regionCount = statistics.regionCount;
  const withUnknown: PageRegionStatistics = freeze({
    ...statistics,
    stats: freeze({
      ...statistics.stats,
      unknownThreshold: freeze({
        value: unknownThreshold,
        sampleCount: regionCount,
        method: regionCount > 0 ? "derived" : "fallback",
      }),
    }),
  });
  decisions.unknownThreshold = unknownThreshold;
  if (regionCount === 0) fallbacks.push("unknownThreshold");

  return freeze({
    pageIndex: statistics.pageIndex,
    regionCount,
    statistics: withUnknown,
    decisions: freeze(decisions),
    fallbacks: Object.freeze(fallbacks),
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function candidate(
  type: RegionType,
  score: number,
  explanation: readonly DecisionEvidence[],
  reasons: readonly string[]
): ScoredCandidate {
  return {
    type,
    score,
    reasons,
    explanation,
  };
}

function evidence(
  features: RegionFeatureSet,
  feature: NumericRegionFeature,
  thresholdName: string,
  threshold: number,
  relation: "above" | "below",
  supports: RegionType,
  weight: number
): DecisionEvidence {
  return freeze({
    feature,
    value: readRegionFeature(features, feature),
    thresholdName,
    threshold,
    relation,
    supports,
    weight,
  });
}

function statValue(
  stats: Readonly<Record<string, RegionStatisticSample>>,
  key: string
): number {
  return stats[key]?.value ?? 0;
}

function ratio(value: number, denom: number): number {
  return denom > CLASSIFICATION_EPSILON
    ? clamp01(value / denom)
    : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
