"""
FlexiData PaddleOCR sidecar — soak test (memory + performance).

Usage:
    python scripts/soak_test.py [--url http://127.0.0.1:8000] [--requests 100]
                                [--fixture <full-page.png>]
                                [--plateau-tol-mb 64]

Finds the Uvicorn/FastAPI PID listening on the service port, then drives 100
sequential requests alternating a synthetic small crop with a full-page
receipt (scan-blur by default) and watches the process RSS:

  * RSS sampled before the run, after every request, printed every 10,
    and after the final request.
  * Average + p95 latency (client-side) and the server-reported latencyMs.
  * Delta RSS between request #20 and request #100.

Verdict:
    PASS  — the RSS plateaus after warmup: linear-regression growth over the
            second half of the run stays within --plateau-tol-mb (default
            64 MB), i.e. no sustained linear growth per request.
    FAIL  — the RSS keeps growing with every request after warmup (leak).

Exit codes: 0 = PASS, 1 = FAIL, 2 = aborted (service errors / no PID).
"""
from __future__ import annotations

import argparse
import base64
import json
import statistics
import struct
import sys
import time
import zlib
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import httpx
import psutil

DEFAULT_URL = "http://127.0.0.1:8000"
DEFAULT_PORT = 8000
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE = REPO_ROOT / "benchmarks" / "corpus" / "scan-blur.png"

MB = 1024 * 1024


# ─── Service PID discovery ───────────────────────────────────────────────────

def find_service_pid(port: int) -> Optional[int]:
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port:
                return conn.pid
    except (psutil.AccessDenied, psutil.Error):
        pass
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            cl = " ".join(proc.info["cmdline"] or [])
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if "uvicorn" in cl and str(port) in cl:
            return proc.info["pid"]
    return None


def rss_mb(pid: int) -> float:
    def _rss(proc: psutil.Process) -> int:
        total = proc.memory_info().rss
        try:
            for child in proc.children(recursive=True):
                total += child.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        return total

    try:
        return _rss(psutil.Process(pid)) / MB
    except psutil.Error as exc:
        raise SystemExit(f"cannot read RSS of pid {pid}: {exc}")


# ─── Payloads ────────────────────────────────────────────────────────────────

def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def small_crop_png(width: int = 96, height: int = 48) -> bytes:
    """Synthetic tiny crop (pure stdlib) — forces det+rec to do real work."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            v = 240
            if (x + y) % 17 < 3 or (y % 5 == 0 and x % 3 == 0):
                v = 30
            rows += bytes((v, v, v))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(bytes(rows), 6))
        + _png_chunk(b"IEND", b"")
    )


def encode_payload(png_bytes: bytes) -> dict:
    return {"image": base64.b64encode(png_bytes).decode("ascii"), "lang": "en"}


# ─── Verdict ─────────────────────────────────────────────────────────────────

def lin_growth_mb(rss: Sequence[float]) -> float:
    """Predicted total growth over the window, via least-squares slope."""
    n = len(rss)
    if n < 2:
        return 0.0
    xs = list(range(n))
    mx = (n - 1) / 2.0
    my = sum(rss) / n
    cov = sum((x - mx) * (v - my) for x, v in zip(xs, rss))
    var = sum((x - mx) ** 2 for x in xs)
    slope = cov / var if var > 0 else 0.0
    return slope * (n - 1)


def p95_ms(latencies: Sequence[float]) -> float:
    if not latencies:
        return 0.0
    ordered = sorted(latencies)
    return ordered[int(0.95 * (len(ordered) - 1))]


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="PaddleOCR sidecar soak test")
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--requests", type=int, default=100)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--plateau-tol-mb", type=float, default=64.0, help="PASS if 2nd-half regression growth <= this (MB)")
    args = parser.parse_args()

    port = int(args.url.rsplit(":", 1)[-1].split("/")[0]) if ":" in args.url else DEFAULT_PORT
    pid = find_service_pid(port)
    if pid is None:
        print(f"FAIL: no uvicorn process found on port {port} ({args.url})", file=sys.stderr)
        return 2

    fixture = args.fixture
    if not fixture.is_file():
        print(f"FAIL: fixture not found: {fixture}", file=sys.stderr)
        return 2
    full_page = fixture.read_bytes()
    small_crop = small_crop_png()
    total = args.requests
    if total < 2:
        print("FAIL: --requests must be >= 2", file=sys.stderr)
        return 2

    print(f"=== FlexiData PaddleOCR soak test ===")
    print(f"service pid : {pid} (uvicorn on {args.url})")
    print(f"fixture     : {fixture} ({len(full_page)} bytes) + synthetic {len(small_crop)}-byte crop")
    print(f"requests    : {total} sequential, alternating small / full-page")
    print(f"plateau tol : {args.plateau_tol_mb} MB (2nd-half regression growth)")

    rss_before = rss_mb(pid)
    print(f"rss before  : {rss_before:8.1f} MB")
    print()

    rss_samples: List[float] = []
    latencies: List[float] = []
    server_ms: List[float] = []
    errors: List[Tuple[int, int]] = []

    with httpx.Client(base_url=args.url, timeout=httpx.Timeout(60.0)) as client:
        for i in range(1, total + 1):
            payload = encode_payload(small_crop if i % 2 == 1 else full_page)
            t0 = time.perf_counter()
            resp = client.post("/v1/ocr", json=payload)
            dt_ms = (time.perf_counter() - t0) * 1000.0
            if resp.status_code != 200:
                errors.append((i, resp.status_code))
                latencies.append(dt_ms)
            else:
                latencies.append(dt_ms)
                server_ms.append(float(resp.json().get("latencyMs", 0)))
            rss_samples.append(rss_mb(pid))
            if i % 10 == 0 or i == total:
                print(f"req {i:4d}   rss {rss_samples[-1]:8.1f} MB   delta-vs-start {rss_samples[-1] - rss_before:+7.1f} MB")

    print()

    if len(errors) > total * 0.1:
        print(f"ABORT: {len(errors)}/{total} requests failed — service not healthy enough to judge memory")
        for idx, code in errors[:10]:
            print(f"  request {idx}: HTTP {code}")
        return 2

    rss_final = rss_samples[-1]
    rss_peak = max(rss_samples)
    rss_at_20 = rss_samples[19]
    rss_at_100 = rss_samples[-1]
    delta_rss = rss_at_100 - rss_at_20

    second_half = rss_samples[len(rss_samples) // 2:]
    growth_2nd = lin_growth_mb(second_half)
    per_req = growth_2nd / max(1, len(second_half) - 1)

    avg_ms = statistics.mean(latencies)
    p95_ms_v = p95_ms(latencies)

    print("=== metrics ===")
    print(f"latency (client)  avg {avg_ms:7.1f} ms   p95 {p95_ms_v:7.1f} ms   min {min(latencies):7.1f} ms   max {max(latencies):7.1f} ms")
    if server_ms:
        print(f"latency (server)  avg {statistics.mean(server_ms):7.1f} ms   p95 {p95_ms(server_ms):7.1f} ms")
    print(f"rss initial       {rss_before:8.1f} MB")
    print(f"rss peak          {rss_peak:8.1f} MB")
    print(f"rss final         {rss_final:8.1f} MB")
    print(f"delta rss         req20 -> req100: {delta_rss:+7.1f} MB  ({rss_at_20:.1f} -> {rss_at_100:.1f})")
    print(f"2nd-half growth   {growth_2nd:+7.1f} MB over {len(second_half)} requests ({per_req:+.2f} MB/req, linear regression)")
    print()

    stable = growth_2nd <= args.plateau_tol_mb
    print("=== verdict ===")
    if stable:
        print(f"PASS — memory plateaus: second-half regression growth {growth_2nd:+.1f} MB <= {args.plateau_tol_mb} MB; no sustained linear growth.")
        return 0
    print(f"FAIL — memory keeps growing after warmup: second-half regression growth {growth_2nd:+.1f} MB > {args.plateau_tol_mb} MB; likely a leak.")
    return 1


if __name__ == "__main__":
    sys.exit(main())