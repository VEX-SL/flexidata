# FlexiData PaddleOCR sidecar

Standalone Python OCR service backing the FlexiData **gated PaddleOCR rescue**
layer. It is fully separate from the Next.js/Node runtime: Node never loads
PaddleOCR; it only POSTs image crops to this service over HTTP.

Validated engine: **PP-OCRv6_medium (det+rec) on onnxruntime** — the exact
engine proven on the `scan-blur` benchmark (CPU-only). Arabic uses
`arabic_PP-OCRv5_mobile_rec` with the shared `PP-OCRv6_medium_det`.

## Wire contract

`POST /v1/ocr` — request:

```json
{ "image": "<base64 encoded PNG/JPEG>", "lang": "en" }
```

`lang` is `"en"` or `"ar"`. The FlexiData Node client
(`src/lib/ocr/paddle-client.ts`) sends `"engine": "paddleocr-en" | "paddleocr-ar"`
instead — both fields are accepted, and `lang` wins when both are present.

Response (matches the contract tested by the Node client):

```json
{
  "texts": [
    { "text": "38.40",
      "bbox": { "x": 245, "y": 340, "width": 58, "height": 21 },
      "confidence": 0.93 }
  ],
  "latencyMs": 420,
  "engine": "paddleocr-en"
}
```

> **`bbox` is an object `{x, y, width, height}`** — the Node client's `toBBox`
> parses exactly this shape; a JSON array would be silently dropped and the
> rescue would never fire. Do not change this without changing the client.

Errors: malformed input → `400 {"error": "<code>"}`; payload over
`PADDLE_OCR_MAX_PAYLOAD_BYTES` → `413`; engine not loaded → `503`;
inference past `PADDLE_OCR_INFERENCE_TIMEOUT_MS` → `504`; model/runtime
failure → `500`.

## Install

```bash
# Python >= 3.12 (local dev validated on 3.14; CPU-only)
python -m venv .venv
# Windows: .venv\Scripts\activate      Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
```

First startup downloads the ONNX models into the PaddleX cache
(`~/.paddlex/official_models`); subsequent startups are offline.

## Start (single worker)

```bash
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

- Models load **once** at startup (singleton per engine, warmup inference
  included) and are never reloaded per request.
- Do **not** pass `--workers` — the service is designed for one worker.
- Config comes from the environment (see `.env.example`); none of it is
  hardcoded.

## Health

```bash
curl http://127.0.0.1:8000/health
# { "status": "ok", "modelsLoaded": true, "engines": { "en": true, "ar": true } }
```

## Validate locally

With the server running (and the benchmark corpus present at repo root):

```bash
python validate_service.py            # against http://127.0.0.1:8000
PADDLE_OCR_URL=http://127.0.0.1:9000 python validate_service.py
```

Checks: `/health`, OCR on `scan-blur` (must return 38.40 / 50.00 / 11.60),
`real-superpay`, `en-clean`, response shape vs the Node contract, malformed
requests (bad base64 / empty image / bad lang / non-JSON / oversized payload),
and that models are loaded exactly once.

## Security

- No hardcoded secrets, URLs, or credentials; everything from env.
- No image content, base64, or document data is logged or stored.
- CORS is off by default (`PADDLE_OCR_ALLOWED_ORIGINS` empty); when set, only
  those origins are allowed. The Node client is not a browser and needs no CORS.
- Payload size and image dimensions are capped; base64 is strictly validated.

## Models

| Engine | Detector | Recognizer | Backend |
| ------ | -------- | ---------- | ------- |
| en     | PP-OCRv6_medium | PP-OCRv6_medium | onnxruntime (CPU) |
| ar     | PP-OCRv6_medium | arabic_PP-OCRv5_mobile | onnxruntime (CPU) |

## FlexiData wiring (next step, out of scope here)

```bash
PADDLE_OCR_URL=http://127.0.0.1:8000/v1/ocr node ...
```

The existing Node client already speaks this contract; no client changes were
needed for this service.