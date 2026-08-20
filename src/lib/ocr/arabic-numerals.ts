/**
 * Universal Arabic numeral normalization.
 *
 * Converts BOTH Eastern Arabic numeral families to ASCII digits:
 *  - Arabic-Indic (used in Arabic script): ٠١٢٣٤٥٦٧٨٩
 *  - Persian/Urdu (extended Arabic-Indic): ۰۱۲۳۴۵۶۷۸۹
 *
 * Arabic invoices and receipts print numbers in these scripts (e.g. ۲۰۰,
 * ٣٦, ۷۲۰۰). Grounding, verification and lexicon matching are written against
 * ASCII digit classes ([0-9], \d, digit-count guards), so every layer must see
 * a standardized surface. This function is the single source of truth for that
 * conversion; it is applied early in the OCR pipeline (the Arabic post-process
 * layer) and again at the grounding boundary, so no consumer ever needs to
 * handle the Eastern families itself. Spatial coordinates (bboxes) are
 * untouched — only glyph text changes.
 */
export function normalizeArabicNumerals(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}