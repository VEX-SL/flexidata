/**
 * Region role vocabulary — exactly as defined by the architecture. Milestone 2
 * ships the vocabulary only; region detection/inference is a later milestone.
 */
export const REGION_TYPE = {
  UNKNOWN: "Unknown",
  HEADER: "Header",
  BODY: "Body",
  FOOTER: "Footer",
  SIDEBAR: "Sidebar",
  TABLE: "Table",
  FORM_FIELD: "FormField",
  STAMP: "Stamp",
  ANNOTATION: "Annotation",
  SIGNATURE_ZONE: "SignatureZone",
} as const;

export type RegionType = (typeof REGION_TYPE)[keyof typeof REGION_TYPE];

/** All region types in vocabulary order (deterministic iteration). */
export const REGION_TYPES: readonly RegionType[] = Object.values(REGION_TYPE);

const REGION_TYPE_SET: ReadonlySet<string> = new Set(REGION_TYPES);

/** Runtime guard for region types arriving from untyped sources. */
export function isRegionType(value: unknown): value is RegionType {
  return typeof value === "string" && REGION_TYPE_SET.has(value);
}
