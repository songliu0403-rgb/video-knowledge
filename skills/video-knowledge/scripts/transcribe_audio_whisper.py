#!/usr/bin/env python3
"""Local Whisper audio transcription helper for video-knowledge ingestion.

Drop-in replacement for transcribe_audio_gemini.py — writes the same set of
files (`transcript.txt`, `transcript.json`, `transcript.srt`,
`transcript-manifest.json`, `transcript-quality.json`) so downstream stages
(compose-bundle, verify-and-fix-reports) work unchanged.

No LLM API. Runs faster-whisper locally on CPU (works on any machine) or
GPU (if torch.cuda available). Free, offline, never expires.

Usage:
    python transcribe_audio_whisper.py \\
        --video-path <PATH>/video.mp4 \\
        --work-dir <PATH> \\
        --asr-dir <PATH>/asr \\
        --model small --language zh

Common knobs:
    --model         tiny | base | small | medium | large-v3   (default: small)
    --device        auto | cpu | cuda                          (default: auto)
    --compute-type  int8 | float16 | float32                   (default: int8)
    --beam-size     1-10                                       (default: 5)
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def label(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def srt_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    millis = int(round((seconds - math.floor(seconds)) * 1000))
    whole = int(math.floor(seconds))
    h = whole // 3600
    m = (whole % 3600) // 60
    s = whole % 60
    return f"{h:02d}:{m:02d}:{s:02d},{millis:03d}"


def ffprobe_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def confidence_from_logprob(avg_logprob: float | None) -> str:
    if avg_logprob is None:
        return "medium"
    if avg_logprob > -0.5:
        return "high"
    if avg_logprob > -1.0:
        return "medium"
    return "low"


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe video audio with local faster-whisper.")
    parser.add_argument("--video-path", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--asr-dir", required=True)
    parser.add_argument("--provider", choices=["whisper"], default="whisper")
    parser.add_argument("--model", default="medium", help="tiny | base | small | medium | large-v3 (medium recommended: better English terms like 'VertexNormalWS')")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--device", default="auto", help="auto | cpu | cuda")
    parser.add_argument("--compute-type", default="int8", help="int8 | float16 | float32")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--vad-filter", dest="vad_filter", action="store_true")
    parser.add_argument("--no-vad-filter", dest="vad_filter", action="store_false")
    parser.set_defaults(vad_filter=True)
    parser.add_argument("--allow-empty-overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")

    # Accept (but ignore) extra args that the capability server passes for the Gemini script.
    # This lets the same spawn-args contract work for both providers without server-side changes.
    for ignored in (
        "--endpoint", "--project", "--location",
        "--chunk-seconds", "--max-chunks",
        "--api-key-env", "--api-key-file",
        "--retry-attempts", "--retry-delay-seconds",
        "--max-output-tokens", "--sleep-seconds",
        "--disable-env-proxy", "--whisper",
    ):
        # store but never use; allow Gemini-style args to flow through harmlessly
        parser.add_argument(ignored, default=None, dest=ignored.lstrip("-").replace("-", "_") + "_unused")
    args, _unknown = parser.parse_known_args()

    # Server may pass --model with a Gemini model name (e.g. gemini-3.1-pro-preview)
    # because the transcribe handler doesn't differentiate. Fall back to default if
    # the model name is not a recognized faster-whisper size.
    valid_whisper_sizes = {
        "tiny", "tiny.en",
        "base", "base.en",
        "small", "small.en",
        "medium", "medium.en",
        "large", "large-v1", "large-v2", "large-v3",
        "large-v3-turbo", "turbo",
        "distil-large-v3", "distil-medium.en", "distil-small.en",
    }
    if args.model not in valid_whisper_sizes:
        print(f"[whisper] WARN: model '{args.model}' not a valid faster-whisper size, falling back to 'medium'", file=sys.stderr, flush=True)
        args.model = "medium"

    source = Path(args.video_path)
    if not source.exists():
        raise SystemExit(f"Video file not found: {source}")

    work_dir = Path(args.work_dir)
    asr_dir = Path(args.asr_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    asr_dir.mkdir(parents=True, exist_ok=True)

    duration = ffprobe_duration(source)

    plan = {
        "provider": "whisper",
        "model": args.model,
        "language": args.language,
        "device": args.device,
        "source_video": str(source),
        "duration_seconds": duration,
    }

    if args.dry_run:
        plan_path = asr_dir / "api-transcription-plan.json"
        write_json(plan_path, {**plan, "dry_run": True})
        print(json.dumps({"dryRun": True, "planPath": str(plan_path)}, ensure_ascii=False))
        return 0

    # Load model
    from faster_whisper import WhisperModel

    device = args.device
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"

    compute_type = args.compute_type
    if device == "cpu" and compute_type == "float16":
        compute_type = "int8"  # CPU 不支持 float16

    print(f"[whisper] loading model={args.model} device={device} compute={compute_type}", file=sys.stderr, flush=True)
    t0 = time.time()
    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    print(f"[whisper]   loaded in {time.time() - t0:.1f}s", file=sys.stderr, flush=True)

    # Transcribe (iterator generator + info)
    print(f"[whisper] transcribing duration={duration:.1f}s vad_filter={args.vad_filter}", file=sys.stderr, flush=True)
    t_tx = time.time()
    segments_iter, info = model.transcribe(
        str(source),
        language=args.language if args.language != "auto" else None,
        beam_size=args.beam_size,
        vad_filter=args.vad_filter,
    )

    segments: list[dict[str, Any]] = []
    for seg in segments_iter:
        segments.append({
            "start_seconds": float(seg.start),
            "end_seconds": float(seg.end),
            "start": label(seg.start),
            "end": label(seg.end),
            "text": (seg.text or "").strip(),
            "confidence": confidence_from_logprob(seg.avg_logprob),
            "avg_logprob": seg.avg_logprob,
            "no_speech_prob": seg.no_speech_prob,
        })
    tx_elapsed = time.time() - t_tx
    realtime_ratio = duration / max(1e-9, tx_elapsed)
    print(f"[whisper]   {len(segments)} segments in {tx_elapsed:.1f}s ({realtime_ratio:.1f}x realtime)", file=sys.stderr, flush=True)

    # Write outputs (compatible with Gemini format)
    transcript_lines = [f"[{s['start']}-{s['end']}] {s['text']}" for s in segments if s['text']]
    (asr_dir / "transcript.txt").write_text(
        "\n".join(transcript_lines) + ("\n" if transcript_lines else ""),
        encoding="utf-8",
    )

    json_payload = {
        **plan,
        "device_actual": device,
        "compute_type": compute_type,
        "info": {
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
        },
        "segments": segments,
    }
    write_json(asr_dir / "transcript.json", json_payload)

    srt_blocks: list[str] = []
    for idx, s in enumerate(segments, start=1):
        if not s["text"]:
            continue
        srt_blocks.append(
            f"{idx}\n{srt_time(s['start_seconds'])} --> {srt_time(s['end_seconds'])}\n{s['text']}\n"
        )
    (asr_dir / "transcript.srt").write_text("\n".join(srt_blocks), encoding="utf-8")

    # Quality (mimic assess_asr_quality from the Gemini helper)
    transcribed_seconds = sum(max(0.0, s["end_seconds"] - s["start_seconds"]) for s in segments)
    coverage_ratio = transcribed_seconds / duration if duration > 0 else 0.0
    # `no_speech`: Whisper VAD filter removed all audio (BGM-only / silent videos
    # legitimately produce 0 segments). Distinguishing this from real failure
    # avoids these clips appearing in "needs fixing" lists.
    if not segments:
        status = "no_speech" if duration >= 30.0 else "failed"
    elif coverage_ratio >= 0.30:
        status = "ok"
    elif coverage_ratio < 0.05:
        status = "failed"
    else:
        status = "partial"

    quality = {
        "status": status,
        "expectedDurationSeconds": round(duration, 2),
        "transcribedSeconds": round(transcribed_seconds, 2),
        "coverageRatio": round(coverage_ratio, 4),
        "chunksTotal": 1,  # Whisper runs as one pass over the whole video
        "chunksFailed": 0,
        "chunksSucceeded": 1,
        "failureReasons": [],
        "provider": "whisper",
        "model": args.model,
        "device": device,
        "elapsedSeconds": round(tx_elapsed, 2),
    }
    write_json(asr_dir / "transcript-quality.json", quality)

    manifest = {
        "provider": "whisper",
        "model": args.model,
        "device": device,
        "compute_type": compute_type,
        "language": args.language,
        "source_video": str(source),
        "duration_seconds": duration,
        "transcribed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "segment_count": len(segments),
        "elapsed_seconds": round(tx_elapsed, 2),
        "realtime_ratio": round(realtime_ratio, 2),
    }
    write_json(asr_dir / "transcript-manifest.json", manifest)

    print(json.dumps({
        "outcome": "transcribed",
        "textPath": str(asr_dir / "transcript.txt"),
        "transcriptTextPath": str(asr_dir / "transcript.txt"),
        "segments": len(segments),
        "quality": quality["status"],
        "coverageRatio": quality["coverageRatio"],
        "qualityPath": str(asr_dir / "transcript-quality.json"),
        "provider": "whisper",
        "model": args.model,
        "device": device,
        "elapsedSeconds": round(tx_elapsed, 2),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
