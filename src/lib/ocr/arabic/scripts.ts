/**
 * Script classification utilities for the Arabic OCR layer.
 *
 * Generic and language-agnostic: a character either belongs to the Arabic
 * writing system, to Latin, or to neither. No document/vendor-specific rules.
 */

export const ARABIC_RANGE =
  /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\uFB50-\uFDFF\uFE70-\uFEFF]/u;
export const LATIN_RANGE = /[\u0041-\u005a\u0061-\u007a\u00c0-\u024f]/u;
export const ARABIC_DIGIT = /[\u0660-\u0669\u06f0-\u06f9]/;

/** Arabic letter: base letter, hamza carrier or Arabic-Indic letter form. */
export function isArabicLetter(ch: string): boolean {
  if (ch.length === 0) return false;
  if (/[\u0641-\u064a\u0620-\u063f]/.test(ch)) return true;
  return ARABIC_RANGE.test(ch);
}

/** Latin letter (incl. Latin-extended). */
export function isLatinLetter(ch: string): boolean {
  return LATIN_RANGE.test(ch);
}

/** Anything that is not a letter is non-script (digits, symbols, whitespace). */
export function isArabicIndicDigit(ch: string): boolean {
  return ARABIC_DIGIT.test(ch);
}

/** Count Arabic letters in a string. */
export function countArabicLetters(text: string): number {
  let n = 0;
  for (const ch of text) if (isArabicLetter(ch)) n += 1;
  return n;
}

/** Count Latin letters in a string. */
export function countLatinLetters(text: string): number {
  let n = 0;
  for (const ch of text) if (isLatinLetter(ch)) n += 1;
  return n;
}
