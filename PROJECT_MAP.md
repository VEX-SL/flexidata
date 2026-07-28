# FlexiData AI — PROJECT_MAP

## TECH_STACK

```
Runtime:      Next.js 16.2.10 (App Router, deployed on Vercel)
Language:     TypeScript 5.9.3
React:        19.2.4
Auth:         Supabase Auth (@supabase/ssr 0.12.0 + @supabase/supabase-js 2.110.4)
Database:     Supabase PostgreSQL + pgvector extension
Storage:      Supabase Storage (or custom upload server)
Styling:      Tailwind CSS 4.x
AI Providers: Groq, Cerebras, Mistral, Gemini, ProAPI, OpenRouter, HuggingFace
Streaming:    SSE (Server-Sent Events) via /api/chat/stream
Embeddings:   @xenova/transformers 2.17.2 (local, Xenova/all-MiniLM-L6-v2, 384 dims)
File Parsing: unpdf, mammoth 1.12.0, xlsx 0.18.5, tesseract.js 5.1.1, @napi-rs/canvas
Code Files:   Supports .js, .py, .css, .html, .ts, .java, .go, .rs, and 20+ more
Markdown:     react-markdown 10.1.0 + remark-gfm 4.0.1
```

## SYSTEM_FLOW

```
User → Browser → Next.js (Vercel)
                    │
                    ├── Middleware (Supabase session refresh + auth guards)
                    │
                    ├── Pages (React Server Components + Client Components)
                    │     ├── /login, /signup (public)
                    │     ├── /dashboard (protected — agent selector + file mgmt + stats)
                    │     ├── /chat (protected — pure chatbot, streaming SSE)
                    │     ├── /agents (protected — agent list + create)
                    │     ├── /agents/[id] (protected — agent file upload page, code files supported)
                    │     ├── /agents/[id]/chat (protected — agent chat with RAG + file editing)
                    │     ├── /settings (protected)
                    │     ├── /agent/[shareId] (public - shared agent)
                    │     └── /pricing (public)
                    │
                    └── API Routes (serverless functions)
                          ├── /api/auth/* → Supabase Auth
                          ├── /api/health → Health check
                          ├── /api/chat/message → AI provider chain (non-streaming fallback)
                          ├── /api/chat/stream → SSE streaming AI response
                          ├── /api/chat-history → Supabase DB (filtered by agentId)
                          ├── /api/files → Supabase Storage + DB (legacy, dashboard uploads)
                          ├── /api/agents → Supabase DB
                          ├── /api/agents/[id]/files → Upload + Parse + RAG
                          ├── /api/agents/[id]/edit → Apply AI-proposed file edits
                          └── /api/agents/[id]/share → Public link generation
```

## ARCHITECTURE

### Directory Structure

```
src/
├── app/                          # Next.js App Router
│   ├── (auth)/                   # Login, Signup
│   ├── (dashboard)/              # Protected pages
│   ├── (public)/                 # Shared agent, Pricing
│   ├── api/                      # API routes
│   ├── globals.css               # Tailwind directives
│   ├── layout.tsx                # Root layout
│   └── page.tsx                  # Landing redirect
├── components/
│   └── file-edit-card.tsx        # File edit diff view with accept/reject
├── lib/
│   ├── supabase/                 # Supabase client helpers
│   │   ├── server.ts             # Server-side client
│   │   ├── client.ts             # Browser client
│   │   └── admin.ts              # Service role client
│   ├── ai/
│   │   ├── providers/            # AI provider adapters
│   │   │   ├── base.ts           # BaseAIProvider (with streaming support)
│   │   │   ├── proapi.ts         # ProAPI (var-meta, GPT-4o)
│   │   │   ├── openrouter.ts     # OpenRouter (27+ free models)
│   │   │   ├── groq.ts           # Groq (fast inference, streaming)
│   │   │   ├── gemini.ts         # Google Gemini
│   │   │   ├── cerebras.ts       # Cerebras (gpt-oss-120b, streaming)
│   │   │   ├── mistral.ts        # Mistral (mistral-small-latest, streaming)
│   │   │   └── huggingface.ts    # HuggingFace
│   │   ├── manager.ts            # ProviderManager (fallback chain + streaming)
│   │   └── prompts.ts            # System prompts (with file editing instructions)
│   ├── hooks/
│   │   └── use-stream-chat.ts    # Client-side SSE stream hook
│   ├── file-parser.ts            # PDF, Word, Excel, image OCR, code files
│   ├── auth.ts                   # requireAuth() helper
│   ├── validators.ts             # Input validation (20+ code mime types)
│   └── rate-limit.ts             # In-memory rate limiting
├── types/
│   └── index.ts                  # Shared TypeScript types
└── middleware.ts                  # Next.js middleware (Supabase session)
```

### AI Provider Chain

```
Request → ProviderManager
           │
           ├── 1. Groq (fastest — llama-3.1-8b-instant, streaming ✓)
           ├── 2. Cerebras (gpt-oss-120b, streaming ✓)
           ├── 3. Mistral (mistral-small-latest, streaming ✓)
           ├── 4. Google Gemini (gemini-2.0-flash)
           ├── 5. ProAPI (var-meta, GPT-4o)
           ├── 6. OpenRouter (meta-llama/llama-3.1-8b-instruct:free, streaming ✓)
           └── 7. HuggingFace (Mistral-7B-Instruct)

All providers have 20s timeout via fetchWithTimeout().
Streaming: /api/chat/stream (SSE) → ProviderManager.streamChatCompletion()
Fallback: /api/chat/message (non-streaming) → ProviderManager.chatCompletion()
```

### Streaming Architecture

```
Client (useStreamChat hook)
  → POST /api/chat/stream
    → ProviderManager.streamChatCompletion()
      → tries providers with streaming support first
      → falls back to non-streaming if all fail
    → SSE events: token, done, error
  → progressive markdown rendering with blinking cursor
  → on "done": save to DB, parse file edits
```

### RAG Pipeline (Phase 2 - Milestone 3)

```
File Upload → Parse → Chunk (500 chars) → Embed (all-MiniLM-L6-v2, 384 dims)
           → Store (Supabase pgvector, HNSW index)

User Query → Embed query → Cosine similarity search → Top 5 chunks
          → Inject into system prompt → Send to AI provider
```

### Database Schema (Supabase SQL)

Tables:
- `profiles` — User profiles (linked to auth.users)
- `files` — Uploaded files with extracted text
- `chats` — Chat sessions
- `messages` — Chat messages
- `agents` — Custom AI agents
- `agent_files` — Files uploaded to agents
- `documents` — Parsed documents for RAG
- `document_chunks` — Chunked text with pgvector embeddings
- `agent_shares` — Public share links for agents
- `provider_logs` — AI provider usage tracking

## MILESTONES

### Milestone 1: Foundation & Cleanup ✅
- Remove Fastify, Prisma, JWT
- Consolidate to Next.js API routes + Supabase Auth
- Tailwind CSS setup
- Base AI provider system
- File parser
- Build passes with zero errors

### Milestone 2: Core Chat & Files ✅
- Chat UI — pure chatbot (no files/RAG)
- Agent-specific chat with RAG context
- File upload to agent via Supabase Storage
- Dashboard: agent selector + per-agent file management + total stats
- Agent CRUD with redirect to upload page on create
- System prompt forces using provided context
- Provider chain: ordered by speed, 20s timeouts
- Streaming text animation (SSE via /api/chat/stream)
- Code file support (.js, .py, .css, .html, .ts, .java, and 20+ more)
- AI file editing with diff view (accept/reject)
- Copy + Regenerate buttons on messages
- AI disclaimer footer
- Drag & drop file upload

### Milestone 3: Agent System & RAG (Week 5-6)
- pgvector embeddings (local, all-MiniLM-L6-v2)
- Chunking + cosine similarity search
- Agent sharing (public links)
- Video/Audio parsing (ffmpeg + Whisper)
- Subscription system (1 free agent, paid = multiple + sharing)

### Milestone 4: Polish & Deploy (Week 7-8)
- Arabic RTL support
- Error handling + loading states
- Rate limiting + security
- Vercel deployment
- Testing

## ORPHANS & PENDING

| Item | Status | Notes |
|------|--------|-------|
| `/api/files` (dashboard uploads) | Deprecated | Replaced by agent file management via `/api/agents/[id]/files` |
| `/api/chat/message` | Fallback | Kept as non-streaming fallback; primary is `/api/chat/stream` |
| DeepSeek provider | Removed | Was paid, not free-tier friendly |
| MCP integration | Deferred Phase 2 | Agent self-knowledge from external tools |
| Browser extension | Deferred Phase 3 | Future feature |
| Subscription system | Pending Milestone 3 | 1 free agent, paid = multiple + sharing |
| Video/Audio parsing | Pending Milestone 3 | ffmpeg + Whisper |
| Light/dark mode toggle | Done | ThemeProvider with localStorage persistence |
| Language toggle | Done | 4 languages (en/fr/ar/zh) with auto-detect |
| Arabic RTL full support | Done | Auth pages forced LTR, rest follows system |
| Rate limiting for shared agents | Pending | Per-IP limits for public agent access |
| PROJECT_MAP.md | Updated | This file |
