"""
GridHum backend - FastAPI service for ENF (mains hum) forensic analysis.

Run:  uvicorn main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

from enf_analyzer import TARGET_FS, ENFError, analyze_signal, generate_synthetic_wav

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".mp4", ".mov", ".ogg"}
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_DURATION_SEC = 300.0          # 5 minutes
DURATION_TOLERANCE_SEC = 0.5
FFMPEG_TIMEOUT_SEC = 120
CHUNK = 1024 * 1024

app = FastAPI(title="GridHum ENF Analyzer", version="1.0.0")

# "*" already covers localhost:3000; both are listed per the spec.
# Credentials must stay off when a wildcard origin is allowed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Audio extraction (ffmpeg -> mono float32 @ 1000 Hz)
# --------------------------------------------------------------------------- #
def _probe_duration(path: Path) -> float | None:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
    except FileNotFoundError:
        raise ENFError("ffmpeg/ffprobe is not installed on the server.", 500)
    except subprocess.TimeoutExpired:
        raise ENFError("Timed out while probing the file.")
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None  # container doesn't report duration; checked after decode


def extract_mono_1khz(source: Path | bytes) -> np.ndarray:
    """Decode the first audio stream of a file (or in-memory bytes) to mono 1 kHz."""
    is_bytes = isinstance(source, (bytes, bytearray))
    if not is_bytes:
        dur = _probe_duration(source)
        if dur is not None and dur > MAX_DURATION_SEC + DURATION_TOLERANCE_SEC:
            raise ENFError(
                f"Recording is {dur:.0f}s long; the maximum is {MAX_DURATION_SEC / 60:.0f} minutes.", 413
            )

    cmd = ["ffmpeg", "-v", "error"]
    if not is_bytes:
        cmd.append("-nostdin")
    cmd += [
        "-i", "pipe:0" if is_bytes else str(source),
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(TARGET_FS),
        "-t", str(MAX_DURATION_SEC + 5),     # hard cap on decode work
        "-f", "f32le", "pipe:1",
    ]
    try:
        r = subprocess.run(
            cmd, input=bytes(source) if is_bytes else None,
            capture_output=True, timeout=FFMPEG_TIMEOUT_SEC,
        )
    except FileNotFoundError:
        raise ENFError("ffmpeg is not installed on the server.", 500)
    except subprocess.TimeoutExpired:
        raise ENFError("Decoding timed out.")

    if r.returncode != 0 or not r.stdout:
        raise ENFError("Could not decode audio (corrupt file or no audio stream).")

    samples = np.frombuffer(r.stdout, dtype="<f4").astype(np.float64)
    if samples.size / TARGET_FS > MAX_DURATION_SEC + DURATION_TOLERANCE_SEC:
        raise ENFError(f"Recording exceeds the {MAX_DURATION_SEC / 60:.0f}-minute limit.", 413)
    return samples


async def _write_upload(upload: UploadFile, dest: Path) -> None:
    size = 0
    with open(dest, "wb") as out:
        while chunk := await upload.read(CHUNK):
            size += len(chunk)
            if size > MAX_FILE_BYTES:
                raise ENFError(f"File exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MB limit.", 413)
            out.write(chunk)
    if size == 0:
        raise ENFError("Uploaded file is empty.", 400)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)):
    safe_name = Path(file.filename or "upload").name
    ext = Path(safe_name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, f"Unsupported type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}")

    tmp_path: Path | None = None
    try:
        fd, name = tempfile.mkstemp(prefix="gridhum_", suffix=ext)
        os.close(fd)
        tmp_path = Path(name)

        await _write_upload(file, tmp_path)
        samples = await run_in_threadpool(extract_mono_1khz, tmp_path)
        return await run_in_threadpool(analyze_signal, samples, TARGET_FS, safe_name)
    except ENFError as e:
        raise HTTPException(e.status_code, str(e))
    finally:
        # Forensic privacy: the upload never outlives the request
        await file.close()
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


@app.get("/api/sample/{grid_type}")
async def sample(grid_type: str):
    g = grid_type.lower()
    if g not in ("50hz", "60hz"):
        raise HTTPException(404, "grid_type must be '50hz' or '60hz'")
    try:
        wav = await run_in_threadpool(generate_synthetic_wav, g)          # in memory
        samples = await run_in_threadpool(extract_mono_1khz, wav)         # same decode path
        return await run_in_threadpool(analyze_signal, samples, TARGET_FS, f"synthetic_{g}.wav")
    except ENFError as e:
        raise HTTPException(e.status_code, str(e))
