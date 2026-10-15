# FlexiData AI — PROJECT_MAP

> Living architecture map. Last full revision: reflects the M1–M24 codebase
> (document-intelligence pipeline, OCR + layout engines, agents/RAG, Vision
> OCR, gated PaddleOCR rescue sidecar). If code and this file disagree, the
> code wins — update this file.

## 1. TECH_STACK

```
Runtime:      Next.js 16.2.10 (App Router, deployed on Vercel)
Language:     TypeScript 5.9.3
React:        19.2.4
Auth:         Supabase Auth (@supabase/ssr ^0.12 + @supabase/supabase-js ^2.110)
Database:     Supabase PostgreSQL + pgvector (HNSW)
Storage:      Supabase Storage (bucket: "files")
Styling:      Tailwind CSS 4.x (+ @tailwindcss/typography)
AI Providers: RDP (opt-in) → Groq → Cerebras → Mistral → Gemini → ProAPI → OpenRouter → HuggingFace
Streaming:    SSE (Server-Sent Events) via /api/chat/stream
Embeddings:   @xenova/transformers ^2.17 (local, Xenova/all-MiniLM-L6-v2, 384 dims)
OCR:          Gemini Vision (primary) + Tesseract.js-core (main-thread fallback)
              + gated PaddleOCR rescue (separate Python sidecar, opt-in)
Layout:       Custom deterministic layout engine (segmentation → reading order → confidence)
File Parsing: unpdf, pdf-parse, pdf-lib, pdf-merger-js, mammoth, xlsx, bmp-js,
              @napi-rs/canvas, tesseract.js-core
Documents:    docx (Word export), xlsx (SheetJS), PDF (pdf-lib + @pdf-lib/fontkit
              + bundled Amiri fonts for Arabic — see §4 "Export formats")
Markdown:     react-markdown ^10 + remark-gfm ^4 (+ react-syntax-highlighter / highlight.js)
Icons:        lucide-react
```

## 2. SYSTEM_FLOW

```
User → Browser → Next.js (Vercel)
                    │
                    ├── Middleware (src/middleware.ts)
                    │     • Local JWT-exp check (no network) → redirect unauthenticated
                    │       users away from /dashboard, /chat, /agents, /settings
                    │     • Redirects logged-in users away from /login, /signup
                    │     • Sets security headers (X-Frame-Options, nosniff, Referrer-Policy)
                    │     • Skips /api/* (API routes enforce auth themselves)
                    │
                    ├── Pages (React Server + Client Components)
                    │     ├── /login, /signup              (public)
                    │     ├── /dashboard                   (protected — stats + activity + agent selector)
                    │     ├── /chat                        (protected — pure chatbot, SSE streaming)
                    │     ├── /agents                      (protected — agent list + create)
                    │     ├── /agents/[id]                 (protected — agent file upload/management)
                    │     ├── /agents/[id]/chat            (protected — agent chat: RAG + file edits + images)
                    │     ├── /documents                   (protected — upload → review → inspect → export)
                    │     └── /settings                    (protected — theme + language)
                    │
                    └── API Routes (serverless)
                          ├── /api/auth/login, /api/auth/debug, /auth/callback
                          ├── /api/health
                          ├── /api/chat/stream, /api/chat/message, /api/chat/[chatId]
                          ├── /api/chat-history, /api/chat-history/[chatId]
                          ├── /api/activity
                          ├── /api/files, /api/files/[id], /api/files/[id]/pages/[page],
                          │     /api/files/convert
                          ├── /api/agents, /api/agents/[id], /api/agents/[id]/files,
                          │     /api/agents/[id]/edit
                          ├── /api/documents/extract
                          ├── /api/image/generate, /api/image/upload
                          ├── /api/audio/transcribe
                          ├── /api/ocr
                          ├── /api/upload, /api/upload/start
                          └── /api/pipeline/*
                                ├── /run                 (dispatch an extraction job)
                                ├── /profiles            (list extraction profiles)
                                └── /extractions         (list)
                                      └── /[id]           (get / patch fields / delete)
                                            ├── /process  (advance one resumable slice; poll target)
                                            ├── /replace  (swap source file + re-run)
                                            └── /export   (json | csv | word | xlsx | pdf)
```

> **Not built yet** (referenced by older docs but no route/page exists):
> `/pricing`, `/agent/[shareId]` (public shared agent), subscription/credits,
> text-to-speech, browser extension. See §9.

## 3. DIRECTORY STRUCTURE

```
src/
├── app/
│   ├── (auth)/login, signup
│   ├── (dashboard)/dashboard, chat, agents, agents/[id], agents/[id]/chat, documents, settings
│   ├── api/…                    # API routes (see §2)
│   ├── auth/callback/route.ts   # Supabase OAuth code exchange
│   ├── layout.tsx, page.tsx, providers.tsx, globals.css
├── components/
│   ├── app-sidebar.tsx, chat-avatars.tsx, code-block.tsx,
│   ├── file-edit-card.tsx        # AI file-edit diff view (accept/reject/new file)
│   ├── markdown-renderer.tsx
│   └── inspector/                # Document review UI
│       ├── DocumentInspector.tsx, DocumentCanvas.tsx, BboxOverlay.tsx,
│       ├── ExtractionSidebar.tsx, PdfInspector.tsx, bbox-utils.ts
├── lib/
│   ├── ai/                       # Provider chain + prompts + image generation
│   │   ├── manager.ts            # ProviderManager (fallback + streaming + disable-on-permanent)
│   │   ├── prompts.ts            # buildSystemPrompt (general | agent) + file-edit contracts
│   │   ├── image-generation.ts   # Together.ai FLUX → Pollinations fallback
│   │   └── providers/            # base + groq/cerebras/mistral/gemini/proapi/openrouter/huggingface/rdp
│   ├── ocr/                      # OCR engines + preprocessing + Arabic + Paddle rescue
│   │   ├── vision-service.ts     # Gemini Vision OCR (primary) + ReceiptExtraction
│   │   ├── preprocess.ts         # deskew/warp/contrast/threshold (pure, engine-independent)
│   │   ├── recall.ts             # recall-recovery pass + OCR_TIMEOUT_MS
│   │   ├── numeric-verify.ts     # PSM-7 digit-whitelist numeric verification
│   │   ├── paddle-client.ts      # HTTP client to the PaddleOCR sidecar
│   │   ├── paddle-rescue.ts      # gated opt-in rescue (Case A/B/C)
│   │   ├── vision-geometry.ts, image-dims.ts, arabic-numerals.ts
│   │   └── arabic/               # normalize, reconstruct, repair, scripts,
│   │                             #   visual.ts (Arabic shaping + bidi for visual output)
│   ├── layout/                   # Deterministic layout engine (M1–M11)
│   ├── extraction/               # Grounding + Transformer + layout-aware extraction
│   ├── pipeline/                 # Staged, DB-backed Document Intelligence Pipeline
│   │   ├── service.ts            # PipelineService (run/process/get/list/update/replace/delete/export)
│   │   ├── orchestrator.ts       # Pipeline (stage coordinator)
│   │   ├── defaults.ts           # runPipeline / createDefaultPipeline
│   │   ├── stages/               # classify, extract, ground, ocr-passages, clean, recover, validate, confidence
│   │   ├── extractor/            # prompt-builder, ai-client, grounding, verify-or-find, recovery,
│   │   │                         #   normalizer, json-repair, dynamic, dynamic-gate, sanitizers, label-lexicon
│   │   └── profiles/             # invoice, receipt, resume, contract, fallback + registry
│   ├── rag/                      # chunker, embedding, search (pgvector)
│   ├── agent/document-context.ts # Builds agent chat context from
│   ├── supabase/                 # server.ts, client.ts, admin.ts
│   ├── hooks/                    # use-stream-chat.ts, use-documents.ts
│   ├── i18n/                     # index.tsx + locales/{en,fr,ar,zh}.json
│   ├── file-parser.ts            # PDF/DOCX/XLSX/image(OCR)/audio/video → text (+ocr)
│   ├── file-access.ts            # loadOwnedFileBytes (owner-scoped storage read)
│   ├── docgen.ts, download.ts, strip-markdown.ts
│   ├── pipeline/exporter.ts       # json / csv / xlsx (shared column model) + pdf dispatch
│   ├── pipeline/exporter-pdf.ts   # pdf-lib report (Amiri embed, shaping + RTL reorder)
│   ├── tesseract-main.ts         # main-thread Tesseract recognizer (Vercel-safe)
│   ├── pdf-render.ts, pdf-canvas.ts
│   ├── auth.ts, validators.ts, rate-limit.ts, theme-provider.tsx
│   └── types.ts
├── types/index.ts
└── middleware.ts
services/
└── paddle-ocr/                   # Standalone FastAPI OCR sidecar (opt-in rescue)
    ├── app.py, validate_service.py, scripts/soak_test.py
    ├── requirements.txt, Dockerfile, README.md, .env.example
supabase/
├── schema.sql, pipeline.sql, rag_functions.sql
public/fonts/                     # Amiri-Regular/Bold (SIL OFL) — embedded by the PDF exporter
tests/                            # Custom runner (node tests/run.mjs) + harness + ~75 suites
benchmarks/                       # Benchmark runners + recorded results
```

## 4. DOCUMENT-INTELLIGENCE PIPELINE

The core differentiator: a deterministic, resumable, DB-backed extraction
pipeline with a strict "never invent / never relabel" contract.

```
File bytes ──► OCR + parse (Gemini Vision → Tesseract fallback; PDF/DOCX/XLSX/audio/video)
           ──► PipelineService.run()      # dispatch only: validate + idempotent queued row
           ──► PipelineService.process()  # resumable slices, polled by the client
                   │  (stages)
                   ├── classify   → document type (AI + rule-validated, "unknown" fallback)
                   ├── extract    → schema-guided (legacy) or schema-free (dynamic) candidate fields
                   ├── ground     → evidence anchoring + drop ungrounded values
                   ├── ocr-passages (dynamic-only: fold OCR into content fields)
                   ├── clean      → entity/text cleanup (re-grounding safe)
                   ├── recover    → deterministic FIND for missing required fields (legacy only)
                   ├── validate   → declarative profile rules
                   └── confidence → 7-signal weighted score (honest, never boosted)
           ──► persist (fields_json, evidence, bbox, confidence, trace, provider/model)
           ──► review UI (/documents) → correct/edit → export (json | csv | word | xlsx | pdf)
```

**Extraction modes**
- `legacy` (default): the profile schema IS the AI contract (invoice/receipt/resume/contract/fallback).
- `dynamic` (opt-in): schema-free discovery — AI proposes fields; deterministic safety gates +
  universal (verbatim) grounding keep it honest; recovery/validation are neutralised.

**Key invariants:** strict verbatim grounding (no fuzzy matching), no fabrication, no relabeling,
confidence measured not inflated, terminal errors persisted as diagnosable rows (never a 504 loop).

### Export formats (`pipeline/exporter.ts` + `exporter-pdf.ts`)
Five formats, all driven off the committed extraction; JSON/CSV/Word/XLSX/PDF share one
column model (`exportColumns()` / `exportColumnLabel()`) so a CSV row and an XLSX row always
agree.
- `json` — structured, carries evidence + verbatim OCR text.
- `csv` — one flat record (profile `exportConfig.csvColumns`, or produced fields when dynamic).
- `word` — `.docx` report (title → OCR lines verbatim → fields table).
- `xlsx` — three sheets: `Extraction` (flat record, numeric cells stay numeric so Excel can sum),
  `Fields` (الحقل / القيمة / الثقة (٪) detail rows, Arabic headers), `OCR` (verbatim lines).
- `pdf` — same report as Word, laid out right-to-left: Arabic is pre-shaped by
  `ocr/arabic/visual.ts` (presentation forms + lam-alef) and cluster-reordered with LTR runs
  preserved, then embedded through **Amiri** (`public/fonts`, `@pdf-lib/fontkit`) so the glyphs
  come from the font file rather than a Latin-only base font. Loads via dynamic `import()` so
  pdf-lib/fontkit never reach a client bundle.

### OCR stack
1. **Gemini Vision** (`ocr/vision-service.ts`) — primary, includes a receipt `extraction` contract.
2. **Tesseract.js-core** (`tesseract-main.ts`) — main-thread WASM (the worker_thread hangs on Vercel),
   with per-word confidence, preprocessing, Arabic post-processing, numeric verification, recall recovery.
3. **PaddleOCR rescue** (`ocr/paddle-rescue.ts` + `services/paddle-ocr/`) — opt-in, gated, for cases the
   primary engines miss. The Node runtime only POSTs image crops over HTTP; it never loads PaddleOCR.

### Layout engine (`src/lib/layout`)
Deterministic, immutable: segmentation → hierarchy → semantic graph → region classification →
reading order → confidence propagation → validation/repair → LayoutContext. Geometry-only (no OCR
text for structure); adaptive thresholds; every stage validated and cached. Feeds layout-aware
extraction (better prompt text + evidence priority).

## 5. AI PROVIDER CHAIN

```
Request → ProviderManager (src/lib/ai/manager.ts)
            ├── 0. RDP / deepseek (rdp-deepseek)  — OPT-IN, requires BOTH RDP_API_URL + RDP_API_KEY
            ├── 1. Groq        (llama-3.3-70b-versatile)            streaming ✓
            ├── 2. Cerebras    (gpt-oss-120b)                       streaming ✓
            ├── 3. Mistral     (mistral-small-latest)               streaming ✓
            ├── 4. Gemini      (gemini-2.0-flash)
            ├── 5. ProAPI      (GPT-4o; PROAPI_BASE_URL + PROAPI_API_KEY)
            ├── 6. OpenRouter  (meta-llama/llama-3.1-8b-instruct:free) streaming ✓
            └── 7. HuggingFace (mistralai/Mistral-7B-Instruct-v0.2)

All providers: 20s timeout (fetchWithTimeout).
Permanent errors (402/404) disable a provider for the run; 413/401 skip; quota-exhausted skips.
Context truncation: groq/cerebras/huggingface cap at 20k chars.
Streaming: /api/chat/stream (SSE) → streamChatCompletion(), non-streaming fallback if none stream.
Non-streaming: /api/chat/message → chatCompletion().
Image generation: Together.ai (FLUX.1-schnell) → Pollinations fallback.
```

## 6. RAG PIPELINE

```
Upload (agent file) → Parse → Chunk (800 chars, 150 overlap)
                    → Embed (all-MiniLM-L6-v2, 384 dims) → Supabase pgvector (HNSW)

Query → Embed → cosine similarity (search_document_chunks RPC, top-k=8)
      → buildRAGContext (grouped by document) → injected into the agent system prompt
```

## 7. DATABASE SCHEMA (Supabase)

Core (`supabase/schema.sql`):
- `profiles` — user profiles (linked to auth.users)
- `files` — uploaded files (name, url, mime_type, size_bytes, status)
- `chats` / `messages` — chat sessions + messages (agent_id nullable = global chat)
- `agents` — custom AI agents
- `agent_files` — files attached to agents
- `documents` / `document_chunks` — RAG content (pgvector embeddings)
- `agent_shares` — public share tokens (schema present; UI not built)
- `provider_logs` — AI provider usage tracking

Document intelligence (`supabase/pipeline.sql`):
- `extractions` — one row per extraction job: status, source_text, ocr_json,
  fields_json, validation_json, confidence_json, trace_json, error_json,
  provider/model, processing_time_ms, `extraction_mode`, `raw_ai_response` (internal only),
  idempotency_key, pipeline_version.

RAG functions (`supabase/rag_functions.sql`): `search_document_chunks` (+ `search_chunks_raw` fallback).

RLS is enabled on user-owned tables; API routes additionally scope every query by `user_id`
(they use the service-role admin client, so ownership filtering is explicit, not implicit).

## 8. MILESTONES (achieved)

- **M1 Foundation & Cleanup** — Next.js API routes + Supabase Auth; base providers; file parser.
- **M2 Core Chat & Files** — pure chatbot + agent chat w/ RAG; dashboard; agent CRUD; SSE streaming;
  file editing with diff view; drag & drop.
- **M3 Agent System & RAG** — local pgvector embeddings; chunking + cosine search.
- **M4 Polish & Deploy** — Arabic RTL; error/loading states; rate limiting; Vercel; i18n (en/fr/ar/zh).
- **M5–M9 Layout engine** — segmentation, hierarchy, semantic graph, region classification,
  reading order, confidence propagation, validation/repair, LayoutContext.
- **M10–M11 Layout-aware extraction** — reader/query/evidence/selection + grounding + transformer.
- **M12 Verify-or-Find** — shared deterministic evidence engine (VERIFY + FIND arms).
- **M13–M17 Grounding hardening** — layout confidence dilution, `*_tax_id` no-invention hole,
  free-text/notes + line_items evidence, FIND label tokenization. All grounded, no fabrication.
- **M18–M19 Reconnaissance** — architecture analysis → choose dynamic (schema-free) discovery mode.
- **M20–M22 Dynamic extraction** — `extractionMode: legacy|dynamic`; schema-free discovery prompt,
  universal verbatim grounding, dynamic safety gate; strictly opt-in; legacy byte-identical.
- **M24 Raw AI observability** — persist the raw provider AI response (internal, RLS-protected,
  never exposed in the public DTO) for cross-provider diagnosis.

Reports live at the repo root: `M12…M24-*.md`, `OCR-REPORT.md`, `BENCHMARK-REPORT.md`,
`SUPERPAY-FORENSIC-REPORT.md`.

## 9. ORPHANS & PENDING

| Item | Status | Notes |
|------|--------|-------|
| `/api/files` (collection) | Active (legacy) | Owner-scoped list; DELETE also cleans the Storage object now. |
| `/api/chat/message` | Fallback | Non-streaming fallback; primary is `/api/chat/stream`. |
| DeepSeek standalone provider | Removed | Dead adapter deleted; DeepSeek still reachable via the opt-in `rdp-deepseek` provider. |
| `/api/ocr` | Active | Vision-LLM OCR proxy (POST image → text/structured extraction). |
| XLSX / PDF export (`/api/pipeline/extractions/[id]/export`) | Active | All five formats implemented: `json` / `csv` / `word` / `xlsx` (flat record + per-field detail + OCR sheets) / `pdf` (Amiri-embedded, Arabic shaped + reordered for RTL). |
| MCP integration | Deferred | Agent self-knowledge from external tools. |
| Browser extension | Deferred (spec only) | See `FlexiData Browser Agent.md`. |
| Subscription / credits system | Not built | No `/pricing`, no billing. |
| Agent sharing UI (`agent_shares`) | Not built | Schema/table exists; no `/agent/[shareId]` page or `/api/agents/[id]/share` route. |
| Text-to-speech | Not built | Speech-to-text (Whisper) exists; TTS does not. |
| Audio/video parsing | Partial | Audio → Whisper transcription (language configurable, default auto-detect); video = metadata only (no ffmpeg). |
| Rate limiting for shared agents | Pending | Per-IP limits once sharing exists. |
| Light/dark toggle | Done | ThemeProvider (light/dark/system) + localStorage. |
| Language toggle | Done | 4 languages (en/fr/ar/zh) with auto-detect; Arabic RTL. |
