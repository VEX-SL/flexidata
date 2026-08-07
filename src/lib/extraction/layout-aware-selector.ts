/**
 * Milestone 11 — layout-aware selector.
 *
 * Deterministically maps an extraction field to the evidence-search plan the
 * M10 selection layer should follow. The plan is a priority ladder:
 *
 *     explicit region → reading-order neighbors → same block
 *     → same page → whole document
 *
 * Every field is resolved from its schema key and label category only — the
 * selector never inspects OCR text, never classifies and never infers
 * entities. Identical fields always produce identical plans, and the ladder
 * always ends at the whole document so no evidence is ever skipped.
 *
 * The default mapping is a static, ordered rule table (first match wins, so
 * results are deterministic). A caller may supply extra rules (checked before
 * the defaults) without touching profile schemas.
 */
import type { FieldSchema } from "@/lib/pipeline/types";
import type { RegionType } from "@/lib/layout";
import { REGION_TYPE } from "@/lib/layout";
import { labelGroupForField } from "@/lib/pipeline/extractor/label-lexicon";

/** The levels of the evidence priority ladder, narrowest first. */
export type EvidenceScope =
  | "region"
  | "neighbors"
  | "block"
  | "page"
  | "document";

/** One deterministic field→region-type mapping rule. */
export interface FieldRegionRule {
  /** Matched against the normalized field key (first match wins). */
  readonly match: RegExp;
  /** The region types to search first (in vocabulary order). */
  readonly types: readonly RegionType[];
}

/** The deterministic search plan for one field. */
export interface ScopePlan {
  /** Region types to search as the explicit-region scope. */
  readonly regionTypes: readonly RegionType[];
  /** The ordered ladder; each scope is searched before the next. */
  readonly scopeOrder: readonly EvidenceScope[];
}

/** Default key→region rules, in priority order (first match wins). */
const KEY_RULES: readonly FieldRegionRule[] = [
  // Document identity and party data live in the header band.
  {
    match: /(invoice_number|receipt_number|document_number|transaction|reference|_no$|_number|_date|issue_date|due_date|merchant|seller|vendor|supplier|buyer|customer|client|company|address|tax_id|vat)/,
    types: [REGION_TYPE.HEADER, REGION_TYPE.FORM_FIELD],
  },
  // Line items are itemized in the body / table band.
  {
    match: /(line_items|^items$|line_item|product|item)/,
    types: [REGION_TYPE.BODY, REGION_TYPE.TABLE],
  },
  // Amounts and totals sit in the totals band (footer) and the table.
  {
    match: /(total|subtotal|amount|tax_amount|discount|shipping|grand|balance|due)/,
    types: [REGION_TYPE.FOOTER, REGION_TYPE.TABLE],
  },
  // Payment details live in the footer.
  {
    match: /(payment|iban|bank|account|pay_|pos_|terminal)/,
    types: [REGION_TYPE.FOOTER],
  },
  // Free text lands in the body.
  {
    match: /(notes|terms|remarks|comment|conditions)/,
    types: [REGION_TYPE.BODY],
  },
  // Signatures live in the signature zone.
  {
    match: /(signature|signed|authori[sz]e|stamp)/,
    types: [REGION_TYPE.SIGNATURE_ZONE],
  },
];

/** Default label-category→region fallback when no key rule matched. */
const LABEL_RULES: readonly FieldRegionRule[] = [
  {
    match: /(merchant|buyer|number|date|tax|pos)/,
    types: [REGION_TYPE.HEADER, REGION_TYPE.FORM_FIELD],
  },
  {
    match: /(total|currency)/,
    types: [REGION_TYPE.FOOTER, REGION_TYPE.TABLE],
  },
  {
    match: /(payment)/,
    types: [REGION_TYPE.FOOTER],
  },
  {
    match: /(notes)/,
    types: [REGION_TYPE.BODY],
  },
];

export class LayoutAwareSelector {
  /** Extra rules checked before the defaults (injected, never mutated). */
  readonly extraRules: readonly FieldRegionRule[];

  constructor(extraRules: readonly FieldRegionRule[] = []) {
    this.extraRules = Object.freeze([...extraRules]);
    Object.freeze(this);
  }

  /** The region types to search first for a field (deterministic). */
  regionTypesFor(field: FieldSchema): readonly RegionType[] {
    const key = field.key.toLowerCase();
    for (const rule of this.extraRules) {
      if (rule.match.test(key)) return rule.types;
    }
    for (const rule of KEY_RULES) {
      if (rule.match.test(key)) return rule.types;
    }
    const group = labelGroupForField(field);
    if (group !== null) {
      const normalized = group.toLowerCase();
      for (const rule of LABEL_RULES) {
        if (rule.match.test(normalized)) return rule.types;
      }
    }
    return Object.freeze([]);
  }

  /**
   * The search plan for a field. Fields with an explicit region hint search
   * the full ladder; fields without one fall straight to the whole document
   * (the ladder always terminates at `document`, so nothing is skipped).
   */
  planFor(field: FieldSchema): ScopePlan {
    const regionTypes = this.regionTypesFor(field);
    return Object.freeze({
      regionTypes,
      scopeOrder: regionTypes.length === 0
        ? Object.freeze(["document"] as const)
        : Object.freeze([
            "region",
            "neighbors",
            "block",
            "page",
            "document",
          ] as const),
    });
  }
}
