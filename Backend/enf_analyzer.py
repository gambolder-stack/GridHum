"""
GridHum - Electric Network Frequency (ENF) analysis core.

Input : mono float samples already resampled to 1000 Hz.
Output: dict matching the GridHum API contract.
"""
from __future__ import annotations

import io
import wave
from dataclasses import dataclass

import numpy as np
from scipy import signal

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
TARGET_FS = 1000                 # Hz, working sample rate
WELCH_NPERSEG = 16384            # ~0.061 Hz bins at 1 kHz
WELCH_NFFT = 16384
BAND_HALF_WIDTH = 0.5            # Hz, search window around each mains frequency
NOISE_INNER = 1.5                # Hz, flanking noise-floor region (inner edge)
NOISE_OUTER = 5.0                # Hz, flanking noise-floor region (outer edge)
MIN_SNR_DB = 8.0                 # floor of the detection threshold (long recordings)
SINGLE_SEGMENT_SNR_DB = 11.0     # threshold with one Welch segment; shrinks as 1/sqrt(K)
MIN_MARGIN_DB = 2.0              # winner must beat runner-up by this much
W_CORROBORATING = 0.25           # weight of the weaker band of a grid's pair
SPECTRUM_RANGE = (45.0, 125.0)   # Hz, returned in the "spectrum" block
STFT_WINDOW_SEC = 5.0
STFT_OVERLAP = 0.5               # 50 % overlap between windows
STFT_NFFT = 32768                # zero-padding for fine peak interpolation
MIN_SAMPLES = 2 * TARGET_FS      # need >= 2 s of audio
EPS = 1e-20

GRIDS = {
    "50Hz": {
        "fundamental": 50.0,
        "harmonic": 100.0,
        "regions": ["Europe", "UK", "Most of Asia", "Africa", "Australia", "Eastern Japan"],
    },
    "60Hz": {
        "fundamental": 60.0,
        "harmonic": 120.0,
        "regions": [
            "North America", "Central America", "Parts of South America",
            "South Korea", "Taiwan", "Philippines", "Western Japan", "Saudi Arabia",
        ],
    },
}


class ENFError(Exception):
    """Raised for client-side problems (bad/short/unreadable audio)."""

    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class BandResult:
    center: float
    peak_freq: float
    peak_db: float
    noise_db: float
    snr_db: float


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _parabolic_offset(y: np.ndarray, k: int) -> float:
    """Sub-bin peak offset (in bins, -0.5..0.5) from a 3-point parabola."""
    if k <= 0 or k >= len(y) - 1:
        return 0.0
    a, b, c = y[k - 1], y[k], y[k + 1]
    den = a - 2.0 * b + c
    if abs(den) < 1e-12:
        return 0.0
    return float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))


def _db(x: float) -> float:
    return float(10.0 * np.log10(x + EPS))


def _measure_band(freqs: np.ndarray, psd: np.ndarray, center: float) -> BandResult:
    """Peak power and SNR (vs. flanking median noise floor) around `center`."""
    band_idx = np.flatnonzero(np.abs(freqs - center) <= BAND_HALF_WIDTH)
    dist = np.abs(freqs - center)
    noise_mask = (dist >= NOISE_INNER) & (dist <= NOISE_OUTER)

    k = int(band_idx[np.argmax(psd[band_idx])])
    peak = float(psd[k])
    floor = float(np.median(psd[noise_mask]))

    df = float(freqs[1] - freqs[0])
    off = _parabolic_offset(np.log(psd + EPS), k)

    return BandResult(
        center=center,
        peak_freq=float(freqs[k] + off * df),
        peak_db=_db(peak),
        noise_db=_db(floor),
        snr_db=_db(peak) - _db(floor),
    )


def _grid_score(fund: BandResult, harm: BandResult) -> float:
    """
    Weighted evidence for a grid. The stronger of the two bands carries full
    weight (phone mics often kill the fundamental, so the harmonic alone must
    be able to win); the weaker band adds corroborating weight.
    """
    a, b = max(fund.snr_db, 0.0), max(harm.snr_db, 0.0)
    return max(a, b) + W_CORROBORATING * min(a, b)


def _logistic(x: float) -> float:
    return float(1.0 / (1.0 + np.exp(-x)))


def _strength(snr: float) -> str:
    return "Strong" if snr >= 12 else "Moderate" if snr >= 8 else "Weak"


def extract_enf_drift(x: np.ndarray, fs: int, center_hz: float, order: int) -> list[dict]:
    """
    STFT (5 s windows, 50 % overlap) around the winning band; per-window peak
    is refined by parabolic interpolation and divided by the harmonic order
    so the curve is always expressed as the mains fundamental (~50/60 Hz).
    """
    nper = int(min(STFT_WINDOW_SEC * fs, len(x)))
    nover = int(nper * STFT_OVERLAP)
    f, t, Z = signal.stft(
        x, fs=fs, window="hann", nperseg=nper, noverlap=nover,
        nfft=max(STFT_NFFT, nper), detrend="constant",
        boundary=None, padded=False,
    )
    logmag = np.log(np.abs(Z) + 1e-12)
    df = float(f[1] - f[0])
    band_idx = np.flatnonzero(np.abs(f - center_hz) <= BAND_HALF_WIDTH)

    out = []
    for j in range(logmag.shape[1]):
        col = logmag[:, j]
        k = int(band_idx[np.argmax(col[band_idx])])
        freq = (f[k] + _parabolic_offset(col, k) * df) / order
        out.append({"timestamp_sec": round(float(t[j]), 2), "frequency_hz": round(float(freq), 3)})
    return out


# --------------------------------------------------------------------------- #
# Main entry point
# --------------------------------------------------------------------------- #
def analyze_signal(samples: np.ndarray, fs: int = TARGET_FS, filename: str = "audio") -> dict:
    x = np.asarray(samples, dtype=np.float64)
    if x.size < MIN_SAMPLES:
        raise ENFError("Audio is too short: at least 2 seconds are required.")
    x = np.nan_to_num(x - np.mean(x))

    nperseg = min(WELCH_NPERSEG, x.size)
    freqs, psd = signal.welch(
        x, fs=fs, window="hann", nperseg=nperseg, noverlap=nperseg // 2,
        nfft=WELCH_NFFT, detrend="constant", scaling="density",
    )

    bands = {
        g: (_measure_band(freqs, psd, cfg["fundamental"]), _measure_band(freqs, psd, cfg["harmonic"]))
        for g, cfg in GRIDS.items()
    }
    scores = {g: _grid_score(*b) for g, b in bands.items()}
    best_snr = {g: max(b[0].snr_db, b[1].snr_db) for g, b in bands.items()}

    # Welch noise statistics tighten with more averaged segments, so the
    # detection threshold relaxes for longer clips (keeps false alarms low).
    n_seg = 1 + (x.size - nperseg) // max(1, nperseg // 2)
    min_snr = max(MIN_SNR_DB, SINGLE_SEGMENT_SNR_DB / np.sqrt(n_seg))

    winner = max(scores, key=scores.get)
    loser = "60Hz" if winner == "50Hz" else "50Hz"
    margin = scores[winner] - scores[loser]

    if best_snr[winner] < min_snr:
        grid, confidence = "INCONCLUSIVE", 0.0
        evidence = (
            f"No mains peak above {min_snr:.1f} dB SNR "
            f"(best 50 Hz-grid band: {best_snr['50Hz']:+.1f} dB, "
            f"60 Hz-grid band: {best_snr['60Hz']:+.1f} dB)"
        )
    elif margin < MIN_MARGIN_DB:
        grid, confidence = "INCONCLUSIVE", 0.0
        evidence = (
            f"50 Hz and 60 Hz evidence too close to separate "
            f"(margin {margin:.1f} dB < {MIN_MARGIN_DB:.0f} dB)"
        )
    else:
        grid = winner
        presence = _logistic((best_snr[winner] - min_snr) / 3.0 + 1.0)
        discrimination = 1.0 - 0.5 * np.exp(-margin / 6.0)
        confidence = float(min(99.0, 100.0 * presence * discrimination))
        fund, harm = bands[winner]
        if harm.snr_db >= fund.snr_db:
            band, label, order = harm, "2nd harmonic", 2
        else:
            band, label, order = fund, "fundamental", 1
        evidence = (
            f"{_strength(band.snr_db)} {band.peak_freq:.2f} Hz {label} peak "
            f"(+{band.snr_db:.1f} dB SNR)"
        )

    drift: list[dict] = []
    if grid != "INCONCLUSIVE":
        fund, harm = bands[grid]
        band = harm if harm.snr_db >= fund.snr_db else fund
        order = 2 if band is harm else 1
        drift = extract_enf_drift(x, fs, band.center, order)

    sel = (freqs >= SPECTRUM_RANGE[0]) & (freqs <= SPECTRUM_RANGE[1])
    return {
        "filename": filename,
        "duration_seconds": round(x.size / fs, 1),
        "verdict": {
            "detected_grid": grid,
            "confidence_percent": round(confidence, 1),
            "primary_evidence": evidence,
            "regions": GRIDS[grid]["regions"] if grid in GRIDS else [],
        },
        "spectrum": {
            "frequencies": [round(float(v), 3) for v in freqs[sel]],
            "magnitudes_db": [round(_db(v), 2) for v in psd[sel]],
            "peak_50hz_db": round(bands["50Hz"][0].peak_db, 1),
            "peak_60hz_db": round(bands["60Hz"][0].peak_db, 1),
            "peak_100hz_db": round(bands["50Hz"][1].peak_db, 1),
            "peak_120hz_db": round(bands["60Hz"][1].peak_db, 1),
        },
        "enf_drift": drift,
    }


# --------------------------------------------------------------------------- #
# Synthetic sample generator (in-memory WAV)
# --------------------------------------------------------------------------- #
def generate_synthetic_wav(
    grid_type: str, duration: float = 10.0, fs: int = 8000,
    rng: np.random.Generator | None = None,
) -> bytes:
    """
    16-bit mono WAV bytes: pink room noise + wandering mains hum. The 2nd
    harmonic is deliberately stronger than the fundamental, mimicking a
    smartphone mic with a high-pass filter.
    """
    grid_type = grid_type.lower()
    if grid_type not in ("50hz", "60hz"):
        raise ValueError("grid_type must be '50hz' or '60hz'")
    f0 = 50.0 if grid_type == "50hz" else 60.0
    rng = rng or np.random.default_rng()
    n = int(duration * fs)
    t = np.arange(n) / fs

    # Pink noise via 1/sqrt(f) spectral shaping, rumble below 20 Hz removed
    spec = np.fft.rfft(rng.standard_normal(n))
    fr = np.fft.rfftfreq(n, 1.0 / fs)
    spec /= np.sqrt(np.maximum(fr, fr[1]))
    spec[fr < 20.0] = 0.0
    pink = np.fft.irfft(spec, n)
    pink *= 0.05 / pink.std()

    # Mean-reverting random walk (10 Hz control rate), clipped to +/-0.08 Hz
    steps = int(duration * 10) + 2
    walk = np.zeros(steps)
    for i in range(1, steps):
        walk[i] = 0.9 * walk[i - 1] + rng.normal(0.0, 0.012)
    dev = np.clip(np.interp(t, np.linspace(0, duration, steps), walk), -0.08, 0.08)

    phase = 2.0 * np.pi * np.cumsum(f0 + dev) / fs
    hum = (
        0.003 * np.sin(phase + rng.uniform(0, 2 * np.pi))
        + 0.006 * np.sin(2.0 * phase + rng.uniform(0, 2 * np.pi))
    )
    audio = pink + hum + 0.002 * rng.standard_normal(n)
    audio /= max(1.0, np.max(np.abs(audio)) / 0.9)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes((audio * 32767).astype("<i2").tobytes())
    return buf.getvalue()
