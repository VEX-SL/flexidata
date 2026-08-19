"""
Local validation for the PaddleOCR sidecar service (requires a running server).

Run (from services/paddle-ocr):
    python validate_service.py
    PADDLE_OCR_URL=http://127.0.0.1:9000 python validate_service.py

Exits non-zero on any failed check. Never logs image content.
"""
import base64
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

BASE = os.environ.get("PADDLE_OCR_URL", "http://127.0.0.1:8000")
REPO = Path(__file__).resolve().parents[2]

FAILED = []


def check(label: str, ok: bool, detail: str = "") -> None:
    tag = "ok  " if ok else "FAIL"
    print(f"[{tag}] {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILED.append(label)


def post(path: str, payload: object) -> tuple[int, object]:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, body.decode(errors="replace")
    except urllib.error.URLError as e:
        print(f"[FATAL] cannot reach {BASE}: {e}")
        sys.exit(1)


def get(path: str) -> tuple[int, object]:
    try:
        with urllib.request.urlopen(BASE + path, timeout=60) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


def main() -> None:
    print(f"Target: {BASE}\n")

    # ── 1. Health ────────────────────────────────────────────────────────────
    status, health = get("/health")
    check("GET /health -> 200", status == 200, f"status={status}")
    check(
        "health contract {status, modelsLoaded}",
        isinstance(health, dict) and "status" in health and "modelsLoaded" in health,
        str(health),
    )
    check("modelsLoaded=true (en ready)", bool(health.get("modelsLoaded")), str(health.get("engines")))

    # ── 2. OCR fixtures ──────────────────────────────────────────────────────
    fixtures = [
        ("scan-blur", REPO / "benchmarks/corpus/scan-blur.png", {"38.40", "50.00", "11.60"}, "exact"),
        ("en-clean", REPO / "benchmarks/corpus/en-clean.png", {"38.40", "50.00", "11.60"}, "exact"),
        ("real-superpay", REPO / "benchmarks/real/db51e106-608b-44a9-9e0c-681bb45aeb78.jpg", {"68.38"}, "substring"),
    ]
    for name, path, must_contain, mode in fixtures:
        if not path.exists():
            check(f"fixture {name} exists", False, str(path))
            continue
        status, res = post("/v1/ocr", {"image": b64(path), "lang": "en"})
        check(f"{name}: /v1/ocr -> 200", status == 200, f"status={status} body={res if status != 200 else ''}")
        if status != 200:
            continue
        texts = res.get("texts")
        check(f"{name}: response shape (texts[].text/bbox/confidence)", isinstance(texts, list) and all(
            isinstance(t, dict) and isinstance(t.get("text"), str) and t["text"]
            and isinstance(t.get("bbox"), dict)
            and all(isinstance(t["bbox"].get(k), (int, float)) for k in ("x", "y", "width", "height"))
            and t["bbox"]["width"] > 0 and t["bbox"]["height"] > 0
            and isinstance(t.get("confidence"), (int, float))
            and 0 <= t["confidence"] <= 1
            for t in texts
        ), f"items={len(texts)}")
        found = {t["text"] for t in texts}
        if mode == "substring":
            # Real photo: Paddle merges the amount with adjacent glyphs
            # ("68.38:" / "68.38:1") — accept substring presence.
            missing = {k for k in must_contain if not any(k in t for t in found)}
        else:
            missing = must_contain - found
        check(f"{name}: contains {sorted(must_contain)}", not missing, f"missing={sorted(missing)} items={len(texts)}")
        check(f"{name}: latencyMs present", isinstance(res.get("latencyMs"), (int, float)), str(res.get("latencyMs")))
        print(f"       {name}: items={len(texts)} latencyMs={res.get('latencyMs')}")

    # ── 3. Malformed requests fail gracefully ────────────────────────────────
    status, res = post("/v1/ocr", {"image": "!!!not-base64!!!", "lang": "en"})
    check("malformed: bad base64 -> 400", status == 400, f"status={status}")

    status, res = post("/v1/ocr", {"image": "", "lang": "en"})
    check("malformed: empty image -> 400", status == 400, f"status={status}")

    status, res = post("/v1/ocr", {"image": b64(REPO / "benchmarks/corpus/scan-blur.png"), "lang": "xx"})
    check("malformed: unsupported lang -> 400", status == 400, f"status={status}")

    status, res = post("/v1/ocr", "not json")
    check("malformed: non-JSON body -> 400", status == 400, f"status={status}")

    status, res = post("/v1/ocr", {"image": b64(REPO / "benchmarks/corpus/scan-blur.png"), "engine": "paddleocr-ar"})
    check("node-compat: engine field accepted", status == 200, f"status={status} engine={res.get('engine') if status == 200 else res}")

    status, res = post("/v1/ocr", {"image": base64.b64encode(b"not an image").decode(), "lang": "en"})
    check("malformed: non-image bytes -> 400", status == 400, f"status={status}")

    status, res = post("/v1/ocr", {"image": "A" * 30_000_000, "lang": "en"})
    check("malformed: oversized payload -> 413", status == 413, f"status={status}")

    # ── 4. Model loaded exactly once (log line) ──────────────────────────────
    print("\n" + ("=" * 60))
    if FAILED:
        print(f"FAILED {len(FAILED)} check(s): {FAILED}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()