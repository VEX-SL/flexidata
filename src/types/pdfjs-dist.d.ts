/**
 * Ambient declarations for the pdfjs-dist ESM entry points consumed via
 * dynamic import() in the server runtime (`loadPdfJs` in
 * src/lib/file-parser.ts and the first-page renderer in
 * src/app/api/documents/extract/route.ts).
 *
 * pdfjs-dist only ships type declarations for the package root
 * (`types: "types/src/pdf.d.ts"`). The subpaths `pdfjs-dist/build/pdf.mjs`
 * and `pdfjs-dist/legacy/build/pdf.mjs` resolve to real files with no
 * declarations, and `allowJs` does not cover `.mjs`, so TypeScript rejects
 * them with "Could not find a declaration file". Declaring them ambiently
 * keeps every build (and the stripped-module local sandbox) green regardless
 * of whether the physical files are present.
 */
declare module "pdfjs-dist/build/pdf.mjs" {
  const pdfjs: any;
  export = pdfjs;
}

declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  const pdfjsLegacy: any;
  export = pdfjsLegacy;
}