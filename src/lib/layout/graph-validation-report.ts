/**
 * Graph validation report — Milestone 8.
 *
 * The shared immutable output types of the validation and repair gates. A
 * `GraphValidationReport` describes the outcome of validating (or repairing) a
 * coherent document model; a `GraphValidationFailure` signals that the four
 * input structures describe different node universes and therefore cannot be
 * validated at all.
 *
 * Everything here is deterministic and deep-frozen. `GraphValidationStatistics`
 * carries pure logical counters only (node/edge counts, repaired counts and a
 * logical contract revision) — no wall-clock timing anywhere.
 */
import type { ValidationResult } from "./validation";
import { validationResult } from "./validation";

/** Logical revision of the validation contract baked into every report. */
export const GRAPH_VALIDATION_REVISION = 1;

/** The repair classes the repair engine supports. */
export type RepairActionKind =
  | "REMOVE_READING_EDGE"
  | "REMOVE_CONTAINMENT_EDGE"
  | "DROP_DUPLICATE_EDGE"
  | "DROP_PARENT";

/** A deterministic description of one repair the engine applied or rejected. */
export interface RepairAction {
  readonly kind: RepairActionKind;
  /** One-line human-readable summary of the action. */
  readonly message: string;
  /** Structured justification for the action. */
  readonly detail: string;
}

/** Pure logical counters of a validation/repair pass. No wall-clock timing. */
export interface GraphValidationStatistics {
  /** Number of nodes in the validated model. */
  readonly nodeCount: number;
  /** Total edges across every graph structure of the model. */
  readonly edgeCount: number;
  /** Reading edges removed by repair (0 for pure validation). */
  readonly repairedEdgeCount: number;
  /** Parent relations dropped by repair (0 for pure validation). */
  readonly repairedParentCount: number;
  /** Logical revision of the validation contract. */
  readonly validationRevision: number;
}

/** The outcome of validating a coherent model. Deep-frozen. */
export interface GraphValidationReport {
  readonly kind: "report";
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly repaired: boolean;
  readonly repairActions: readonly RepairAction[];
  readonly statistics: GraphValidationStatistics;
}

/** The outcome when the model cannot be validated at all. Deep-frozen. */
export interface GraphValidationFailure {
  readonly kind: "failure";
  readonly reason: string;
  readonly details: readonly string[];
}

export type GraphValidationOutcome = GraphValidationReport | GraphValidationFailure;

/** Narrow a validation outcome to the failure case. */
export function isGraphValidationFailure(
  outcome: GraphValidationOutcome
): outcome is GraphValidationFailure {
  return outcome.kind === "failure";
}

export interface CreateGraphValidationStatisticsOptions {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly repairedEdgeCount?: number;
  readonly repairedParentCount?: number;
  readonly validationRevision?: number;
}

/** Build an immutable statistics block. */
export function createGraphValidationStatistics(
  options: CreateGraphValidationStatisticsOptions
): GraphValidationStatistics {
  return Object.freeze({
    nodeCount: options.nodeCount,
    edgeCount: options.edgeCount,
    repairedEdgeCount: options.repairedEdgeCount ?? 0,
    repairedParentCount: options.repairedParentCount ?? 0,
    validationRevision:
      options.validationRevision ?? GRAPH_VALIDATION_REVISION,
  });
}

export interface CreateGraphValidationReportOptions {
  readonly errors: readonly string[];
  readonly warnings?: readonly string[];
  readonly repaired?: boolean;
  readonly repairActions?: readonly RepairAction[];
  readonly statistics: GraphValidationStatistics;
}

/** Build an immutable validation report from deterministic inputs. */
export function createGraphValidationReport(
  options: CreateGraphValidationReportOptions
): GraphValidationReport {
  return Object.freeze({
    kind: "report",
    valid: options.errors.length === 0,
    errors: Object.freeze([...options.errors]),
    warnings: Object.freeze([...(options.warnings ?? [])]),
    repaired: options.repaired ?? false,
    repairActions: Object.freeze([...(options.repairActions ?? [])]),
    statistics: Object.freeze({ ...options.statistics }),
  });
}

/** Build an immutable validation failure. */
export function createGraphValidationFailure(
  reason: string,
  details: readonly string[]
): GraphValidationFailure {
  return Object.freeze({
    kind: "failure",
    reason,
    details: Object.freeze([...details]),
  });
}

/**
 * Determinism guard (invariant 9): two reports produced by the same gate over
 * identical inputs must be byte-for-byte identical, field for field.
 */
export function validateReportDeterminism(
  a: GraphValidationReport,
  b: GraphValidationReport
): ValidationResult {
  const errors: string[] = [];
  if (a.valid !== b.valid) {
    errors.push("valid differs between reports");
  }
  if (!stringArraysEqual(a.errors, b.errors)) {
    errors.push("errors differ between reports");
  }
  if (!stringArraysEqual(a.warnings, b.warnings)) {
    errors.push("warnings differ between reports");
  }
  if (a.repaired !== b.repaired) {
    errors.push("repaired differs between reports");
  }
  if (!repairActionsEqual(a.repairActions, b.repairActions)) {
    errors.push("repairActions differ between reports");
  }
  if (!statisticsEqual(a.statistics, b.statistics)) {
    errors.push("statistics differ between reports");
  }
  return validationResult(errors);
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function repairActionsEqual(
  a: readonly RepairAction[],
  b: readonly RepairAction[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== b[i].kind) return false;
    if (a[i].message !== b[i].message) return false;
    if (a[i].detail !== b[i].detail) return false;
  }
  return true;
}

function statisticsEqual(
  a: GraphValidationStatistics,
  b: GraphValidationStatistics
): boolean {
  return (
    a.nodeCount === b.nodeCount &&
    a.edgeCount === b.edgeCount &&
    a.repairedEdgeCount === b.repairedEdgeCount &&
    a.repairedParentCount === b.repairedParentCount &&
    a.validationRevision === b.validationRevision
  );
}
