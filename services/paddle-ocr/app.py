"""
FlexiData PaddleOCR sidecar service.

Standalone Python service (FastAPI + Uvicorn, CPU-only, single worker) that
backs the Node.js OCR rescue layer. The Node client (`src/lib/ocr/paddle-client.ts`)
POSTs a region PNG as base64 and expects:

    { "texts": [ { "text": "38.40",
                   "bbox": { "x": ..., "y": ..., "width": ..., "height": ... },
                   "confidence": 0.93 } ],
      "latencyMs": 420 }

NOTE: `bbox` is an OBJECT {x, y, width, height} — this is the exact shape the
Node client's `toBBox` parses (a JSON array would be dropped by the client).

The request accepts either the Node field `engine` ("paddleocr-en" |
"paddleocr-ar") or the generic `lang` ("en" | "ar"); `lang` wins when both are
present.

Models are loaded ONCE at process startup (singleton per engine) and never
reloaded per request. No image content, base64, or document data is ever
logged or stored.
"""
import asyncio
import base64
import binascii
import io
import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from paddleocr import PaddleOCR
from PIL import Image, UnidentifiedImageError

# ─── Configuration (env only; no hardcoded URLs/secrets) ────────────────────

MAX_PAYLOAD_BYTES = int(os.environ.get("PADDLE_OCR_MAX_PAYLOAD_BYTES", "25000000"))
MAX_IMAGE_DIM = int(os.environ.get("PADDLE_OCR_MAX_IMAGE_DIM", "8192"))
INFERENCE_TIMEOUT_MS = int(os.environ.get("PADDLE_OCR_INFERENCE_TIMEOUT_MS", "20000"))
MAX_ITEMS = 500
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("PADDLE_OCR_ALLOWED_ORIGINS", "").split(",")
    if o.strip()
]

LOG_LEVEL = os.environ.get("PADDLE_OCR_LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("paddle-ocr")

ENGINES: Dict[str, Dict[str, str]] = {
    "en": {
        "label": "paddleocr-en",
        "lang": "en",
        "det": "PP-OCRv6_medium_det",
        "rec": "PP-OCRv6_medium_rec",
        "model": "PP-OCRv6_medium (det+rec, onnxruntime)",
    },
    "ar": {
        "label": "paddleocr-ar",
        "lang": "arabic",
        "det": "PP-OCRv6_medium_det",
        "rec": "arabic_PP-OCRv5_mobile_rec",
        "model": "PP-OCRv6_medium_det + arabic_PP-OCRv5_mobile_rec (onnxruntime)",
    },
}

# Singleton model instances, built once at startup.
MODELS: Dict[str, PaddleOCR] = {}
ENGINE_LOADED: Dict[str, bool] = {}
# PaddleOCR sessions are not guaranteed thread-safe; serialize inference.
_INFER_LOCK = threading.Lock()


def _resolve_engine(payload: Dict[str, object]) -> str:
    lang = payload.get("lang")
    if isinstance(lang, str) and lang in ENGINES:
        return lang
    engine = payload.get("engine")
    if isinstance(engine, str) and engine in ("paddleocr-en", "paddleocr-ar"):
        return "ar" if engine == "paddleocr-ar" else "en"
    raise HTTPException(status_code=400, detail="unsupported_lang")


def _load_engine(key: str) -> None:
    spec = ENGINES[key]
    started = time.perf_counter()
    # Explicit model names: `lang` alone cannot select Arabic in PaddleOCR 3.7
    # (the v6 language list is ch/chinese_cht/en/japan/latin only).
    ocr = PaddleOCR(
        text_detection_model_name=spec["det"],
        text_recognition_model_name=spec["rec"],
        engine="onnxruntime",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )
    # Force a tiny warmup inference so the first request is not cold.
    ocr.predict(input=np.zeros((32, 32, 3), dtype=np.uint8))
    MODELS[key] = ocr
    ENGINE_LOADED[key] = True
    logger.info(
        "Loaded engine %s (%s) in %.1fs", key, spec["model"], time.perf_counter() - started
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    for key in ("en", "ar"):
        try:
            _load_engine(key)
        except Exception as exc:  # ar is best-effort; en is required
            ENGINE_LOADED[key] = False
            logger.error("Failed to load engine %s: %s", key, exc)
    if not ENGINE_LOADED.get("en"):
        logger.critical("English engine failed to load — service is not usable")
    yield
    MODELS.clear()


app = FastAPI(title="FlexiData PaddleOCR sidecar", version="1.0.0", lifespan=lifespan)

if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["POST", "GET"],
        allow_headers=["content-type"],
    )


# ─── Endpoints ──────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    en_ok = bool(ENGINE_LOADED.get("en"))
    return {
        "status": "ok" if en_ok else "degraded",
        "modelsLoaded": en_ok,
        "engines": {k: bool(v) for k, v in ENGINE_LOADED.items()},
    }


def _items_from_result(result: List[object]) -> List[dict]:
    out: List[dict] = []
    for page in result:
        data = page.json["res"]
        texts = data.get("rec_texts") or []
        scores = data.get("rec_scores") or []
        polys = data.get("rec_polys")
        for i, raw in enumerate(texts):
            text = (raw or "").strip()
            if not text:
                continue
            conf = 0.0
            if i < len(scores) and scores[i] is not None:
                conf = float(scores[i])
            conf = max(0.0, min(1.0, conf))
            bbox = None
            if polys is not None and i < len(polys) and polys[i] is not None:
                pts = np.asarray(polys[i], dtype=float)
                if pts.size >= 8:
                    xs = pts[:, 0]
                    ys = pts[:, 1]
                    w = float(xs.max() - xs.min())
                    h = float(ys.max() - ys.min())
                    if w > 0 and h > 0:
                        bbox = {
                            "x": round(float(xs.min()), 2),
                            "y": round(float(ys.min()), 2),
                            "width": round(w, 2),
                            "height": round(h, 2),
                        }
            if bbox is None:
                continue  # output safety: drop items without a valid box
            out.append({"text": text, "bbox": bbox, "confidence": round(conf, 4)})
    out.sort(key=lambda it: (it["bbox"]["y"], it["bbox"]["x"]))
    return out[:MAX_ITEMS]


def _run_inference(key: str, image: np.ndarray) -> tuple[List[dict], int]:
    started = time.perf_counter()
    with _INFER_LOCK:
        result = MODELS[key].predict(input=image)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return _items_from_result(result), elapsed_ms


@app.post("/v1/ocr")
async def ocr(request: Request):
    raw = await request.body()
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise HTTPException(status_code=413, detail="payload_too_large")
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="invalid_json")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid_json")

    key = _resolve_engine(payload)

    image_b64 = payload.get("image")
    if not isinstance(image_b64, str) or not image_b64.strip():
        raise HTTPException(status_code=400, detail="image_required")
    try:
        image_bytes = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="invalid_base64")
    if not image_bytes:
        raise HTTPException(status_code=400, detail="empty_image")

    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="invalid_image")
    if img.width > MAX_IMAGE_DIM or img.height > MAX_IMAGE_DIM:
        raise HTTPException(status_code=400, detail="image_too_large")
    array = np.asarray(img.convert("RGB"))

    if not ENGINE_LOADED.get(key):
        raise HTTPException(status_code=503, detail=f"engine_unavailable:{key}")

    loop = asyncio.get_running_loop()
    items, latency_ms = await loop.run_in_executor(None, _run_inference, key, array)
    if latency_ms > INFERENCE_TIMEOUT_MS:
        logger.warning("Inference took %dms (limit %dms) — returning 504", latency_ms, INFERENCE_TIMEOUT_MS)
        raise HTTPException(status_code=504, detail="ocr_timeout")

    logger.info(
        "ocr lang=%s status=200 items=%d latencyMs=%d payloadBytes=%d",
        key, len(items), latency_ms, len(raw),
    )
    return {"texts": items, "latencyMs": latency_ms, "engine": ENGINES[key]["label"]}


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException):
    logger.info("request status=%d detail=%s", exc.status_code, exc.detail)
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})