/**
 * Benchmark corpus for the extraction-quality milestone.
 *
 * Renders synthetic receipts (clean / low-contrast / 90°-rotated / slanted /
 * Arabic thermal) with @napi-rs/canvas plus the real production photo, and
 * attaches per-item ground-truth key strings used by the OCR-level and
 * pipeline-level runners to score how much of the receipt the engines recover.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export interface CorpusItem {
  id: string;
  label: string;
  buffer: Buffer;
  kind: "png" | "jpg";
  /** Expected substrings / regexes that should survive OCR (ground truth). */
  groundTruth: string[];
  /** Human-readable expected field descriptions for the report. */
  groundTruthLabels: string[];
}

function renderReceipt(opts: {
  width?: number;
  rotateDeg?: number;
  arabic?: boolean;
  ink?: string;
  bg?: string;
  noise?: number;
  seed?: number;
} = {}): Buffer {
  const { width = 520, rotateDeg = 0, arabic = false, ink = "#1a1a1a", bg = "#f4f1ea", noise = 300, seed = 42 } = opts;
  const lines = arabic
    ? [
        ["", ""],
        ["\u0645\u062A\u062C\u0631 \u0627\u0644\u0631\u062D\u064A\u0645 \u0627\u0644\u062A\u062C\u0627\u0631\u064A", "fs22"],
        ["\u062A\u0627\u0631\u064A\u062E: 2025-01-15", "fs16"],
        ["\u0633\u0644\u0639\u0629: \u0623\u0631\u0632 5\u0643\u062C", "fs16"],
        ["\u0627\u0644\u0645\u0628\u0644\u063A: 45.50 \u0631\u0633", "fs16"],
        ["\u0627\u0644\u0625\u062C\u0645\u0627\u0644\u064A: 45.50 \u0631\u0633", "fs18"],
      ]
    : [
        ["", ""],
        ["AL RABIH SUPERMARKET", "fs22"],
        ["Riyadh, KSA  Tel: 011-555-1212", "fs13"],
        ["Date: 2025-01-15  15:42", "fs13"],
        ["----------------------------", "fs13"],
        ["Sugar 1kg                  6.50", "fs15"],
        ["Milk 1L                    7.00", "fs15"],
        ["Rice 5kg                  24.90", "fs15"],
        ["----------------------------", "fs13"],
        ["TOTAL                     38.40", "fs18"],
        ["Cash                      50.00", "fs15"],
        ["Change                    11.60", "fs15"],
        ["Thank you for shopping", "fs13"],
      ];
  const pt = (s: string) => parseInt(s.slice(2), 10) || 16;
  const lineH = 34;
  const h = lines.length * lineH + 30;
  const canvas = createCanvas(width, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (rotateDeg) {
    const rad = (rotateDeg * Math.PI) / 180;
    const cw = Math.ceil(Math.abs(Math.cos(rad)) * width + Math.abs(Math.sin(rad)) * h);
    const chh = Math.ceil(Math.abs(Math.sin(rad)) * width + Math.abs(Math.cos(rad)) * h);
    canvas.width = cw;
    canvas.height = chh;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, chh);
    ctx.translate(cw / 2, chh / 2);
    ctx.rotate(rad);
  }
  let y = 26;
  for (const [text, fs] of lines) {
    ctx.fillStyle = ink;
    ctx.font = `bold ${pt(fs)}px Arial`;
    ctx.fillText(text, 24, y);
    y += lineH;
  }
  ctx.globalAlpha = 0.04;
  let s = seed >>> 0;
  const rand = () => {
    // xorshift32 — deterministic so corpus images are reproducible.
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  for (let i = 0; i < noise; i++) {
    ctx.fillStyle = rand() > 0.5 ? "#000" : "#fff";
    ctx.fillRect(Math.floor(rand() * canvas.width), Math.floor(rand() * canvas.height), 2, 2);
  }
  ctx.globalAlpha = 1;
  return canvas.toBuffer("image/png");
}

function renderInvoice(): Buffer {
  const lines: Array<[string, string]> = [
    ["", ""],
    ["ACME CONSULTING", "fs22"],
    ["16 Business Park Rd, Riyadh  KSA  VAT 3111234567", "fs13"],
    ["INVOICE  INV-2026-014", "fs20"],
    ["Issue date: 2026-02-14", "fs15"],
    ["Due date:   2026-03-14", "fs15"],
    ["Bill to: KIM & SONS TRADING", "fs15"],
    ["------------------------------", "fs13"],
    ["Web audit retainer            150.00", "fs15"],
    ["------------------------------", "fs13"],
    ["Subtotal                      150.00", "fs15"],
    ["VAT 3.5%                        5.25", "fs15"],
    ["TOTAL DUE                    155.25", "fs18"],
    ["Payment: Bank transfer  SA1234567890", "fs13"],
  ];
  const pt = (s: string) => parseInt(s.slice(2), 10) || 16;
  const width = 560;
  const lineH = 34;
  const h = lines.length * lineH + 30;
  const canvas = createCanvas(width, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 26;
  for (const [text, fs] of lines) {
    ctx.fillStyle = "#141414";
    ctx.font = `bold ${pt(fs)}px Arial`;
    ctx.fillText(text, 24, y);
    y += lineH;
  }
  return canvas.toBuffer("image/png");
}

function renderContract(): Buffer {
  const lines: Array<[string, string]> = [
    ["", ""],
    ["SERVICE AGREEMENT", "fs22"],
    ["Agreement No: CT-2025-881", "fs16"],
    ["Between NOVATEL GLOBAL and KIM & SONS TRADING", "fs15"],
    ["Effective date: 2025-03-01", "fs15"],
    ["Term: 12 months  Expiry: 2026-03-01", "fs15"],
    ["Monthly fee: SAR 1,200", "fs16"],
    ["Total contract value: SAR 14,400", "fs16"],
    ["Payable in advance to NOVATEL GLOBAL", "fs13"],
    ["Signed in Riyadh on 2025-02-20", "fs13"],
  ];
  const pt = (s: string) => parseInt(s.slice(2), 10) || 16;
  const width = 600;
  const lineH = 36;
  const h = lines.length * lineH + 30;
  const canvas = createCanvas(width, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 26;
  for (const [text, fs] of lines) {
    ctx.fillStyle = "#101010";
    ctx.font = `bold ${pt(fs)}px Arial`;
    ctx.fillText(text, 28, y);
    y += lineH;
  }
  return canvas.toBuffer("image/png");
}

/**
 * Gaussian-style blur at native resolution (a realistic "blurry scan").
 * Uses ctx.filter blur when the canvas backend supports it, otherwise falls
 * back to a mild 3× downscale/upscale so the text stays partly legible.
 */
async function blurPng(buffer: Buffer, radius = 1.5): Promise<Buffer> {
  const loaded = await loadImage(buffer);
  const w = loaded.width;
  const h = loaded.height;
  const big = createCanvas(w, h);
  const bctx = big.getContext("2d");
  try {
    bctx.filter = `blur(${radius}px)`;
    bctx.drawImage(loaded, 0, 0, w, h);
    bctx.filter = "none";
  } catch {
    bctx.filter = "none";
    const small = createCanvas(Math.max(2, Math.round(w / 3)), Math.max(2, Math.round(h / 3)));
    const sctx = small.getContext("2d");
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(loaded, 0, 0, small.width, small.height);
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "low";
    bctx.drawImage(small, 0, 0, w, h);
  }
  return big.toBuffer("image/png");
}

const EN_GT = ["AL RABIH", "SUPERMARKET", "38.40", "50.00", "11.60"];
const EN_GT_LABELS = ["merchant", "merchant", "total 38.40", "cash 50.00", "change 11.60"];
const INV_GT = ["ACME CONSULTING", "INV-2026-014", "2026-02-14", "155.25", "150.00", "5.25", "KIM & SONS"];
const INV_GT_LABELS = ["company", "invoice number", "issue date", "total 155.25", "subtotal 150.00", "VAT 5.25", "bill-to KIM & SONS"];
const CON_GT = ["CT-2025-881", "NOVATEL GLOBAL", "KIM & SONS", "2025-03-01", "2026-03-01", "1,200", "14,400"];
const CON_GT_LABELS = ["contract number", "party A", "party B", "effective date", "expiry", "monthly fee", "total value"];

export async function buildCorpus(): Promise<CorpusItem[]> {
  const items: CorpusItem[] = [
    {
      id: "en-clean",
      label: "English receipt (clean)",
      buffer: renderReceipt(),
      kind: "png",
      groundTruth: EN_GT,
      groundTruthLabels: EN_GT_LABELS,
    },
    {
      id: "en-lowcontrast",
      label: "English receipt (low contrast)",
      buffer: renderReceipt({ ink: "#8a8a8a", bg: "#fafafa", noise: 600 }),
      kind: "png",
      groundTruth: EN_GT,
      groundTruthLabels: EN_GT_LABELS,
    },
    {
      id: "en-rot90",
      label: "English receipt (90° rotated)",
      buffer: renderReceipt({ rotateDeg: 90 }),
      kind: "png",
      groundTruth: EN_GT,
      groundTruthLabels: EN_GT_LABELS,
    },
    {
      id: "en-slant2",
      label: "English receipt (2° slanted)",
      buffer: renderReceipt({ rotateDeg: 2 }),
      kind: "png",
      groundTruth: EN_GT,
      groundTruthLabels: EN_GT_LABELS,
    },
    {
      id: "scan-blur",
      label: "English receipt (blurred scan)",
      buffer: await blurPng(renderReceipt(), 1.5),
      kind: "png",
      groundTruth: EN_GT,
      groundTruthLabels: EN_GT_LABELS,
    },
    {
      id: "invoice-clean",
      label: "Service invoice (clean)",
      buffer: renderInvoice(),
      kind: "png",
      groundTruth: INV_GT,
      groundTruthLabels: INV_GT_LABELS,
    },
    {
      id: "contract-1pg",
      label: "Service agreement (1 page)",
      buffer: renderContract(),
      kind: "png",
      groundTruth: CON_GT,
      groundTruthLabels: CON_GT_LABELS,
    },
    {
      id: "ar-thermal",
      label: "Arabic thermal receipt",
      buffer: renderReceipt({ arabic: true }),
      kind: "png",
      groundTruth: ["45.50", "\u0627\u0644\u0645\u0628\u0644\u063A", "\u0627\u0644\u0625\u062C\u0645\u0627\u0644\u064A"],
      groundTruthLabels: ["total 45.50", "المبلغ", "الإجمالي"],
    },
    {
      id: "real-superpay",
      label: "Real SuperPay receipt photo (prod)",
      buffer: readFileSync("benchmarks/real/db51e106-608b-44a9-9e0c-681bb45aeb78.jpg"),
      kind: "jpg",
      groundTruth: ["68.38", "391003452", "2013438351", "SuperPay", "Zahra Aman", "02-07-2026"],
      groundTruthLabels: ["amount 68.38", "account 391003452", "ref 2013438351", "merchant SuperPay", "customer Zahra Aman", "date 02-07-2026"],
    },
  ];

  mkdirSync("benchmarks/corpus", { recursive: true });
  for (const item of items) {
    writeFileSync(`benchmarks/corpus/${item.id}.${item.kind === "jpg" ? "jpg" : "png"}`, item.buffer);
  }
  return items;
}

/** Score a document text against a corpus item's ground truth. */
export function scoreText(text: string, item: CorpusItem): { hits: number; total: number; detail: Array<{ key: string; label: string; found: boolean }> } {
  const norm = text.replace(/\s+/g, " ").toLowerCase();
  const detail = item.groundTruth.map((key, i) => ({
    key,
    label: item.groundTruthLabels[i] ?? key,
    found: norm.includes(key.toLowerCase()) || new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(norm),
  }));
  return { hits: detail.filter((d) => d.found).length, total: detail.length, detail };
}
