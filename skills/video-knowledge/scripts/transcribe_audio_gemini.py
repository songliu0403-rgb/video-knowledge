#!/usr/bin/env python3
"""Gemini audio transcription helper for video-knowledge ingestion."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import time
import traceback
from pathlib import Path
from typing import Any


DEFAULT_GEMINI_MODEL = (
    os.environ.get("VIDEO_KNOWLEDGE_TRANSCRIPTION_MODEL")
    or os.environ.get("VIDEO_KNOWLEDGE_GEMINI_MODEL")
    or "gemini-3.1-pro-preview"
)


PROMPT_TEMPLATE = """
You are an evidence-first ASR transcriber for a personal video knowledge system.

Transcribe the supplied audio chunk into Simplified Chinese when speech is
Chinese; keep technical English terms as-is. The source may be a tutorial,
screen recording, livestream, or casual creator/audience conversation. Do not
summarize. Do not invent speech. If speech is unclear, mark the segment
confidence as low and keep only what can be heard.

Return STRICT JSON only. Do not use Markdown.

Video id: {video_id}
Chunk absolute range: {start_label}-{end_label}
Chunk start seconds: {start_seconds}
Chunk end seconds: {end_seconds}
Language hint: {language}

Schema:
{{
  "language": "zh | en | mixed | unknown",
  "segments": [
    {{
      "start_seconds": 0.0,
      "end_seconds": 0.0,
      "text": "spoken text",
      "confidence": "high | medium | low"
    }}
  ],
  "notes": "short audit note"
}}

The segment start/end seconds MUST be absolute seconds from the original video,
not seconds relative to this chunk. Keep each segment reasonably short.
""".strip()


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(jsonable(value), ensure_ascii=False, indent=2), encoding="utf-8")


def jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True)
    if hasattr(value, "dict"):
        return value.dict()
    return value


def parse_json_text(text: str) -> dict[str, Any]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"parse_error": True, "raw_text": text}
    return parsed if isinstance(parsed, dict) else {"parse_error": True, "raw_text": text}


def ffprobe_duration(path: Path) -> float:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    return float(result.stdout.strip())


def build_chunks(duration: float, chunk_seconds: int, max_chunks: int | None) -> list[tuple[int, int]]:
    count = math.ceil(duration / chunk_seconds)
    if max_chunks is not None:
        count = min(count, max_chunks)
    chunks: list[tuple[int, int]] = []
    for index in range(count):
        start = index * chunk_seconds
        end = min(int(math.ceil(duration)), start + chunk_seconds)
        if end > start:
            chunks.append((start, end))
    return chunks


def label(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"


def srt_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    millis = int(round((seconds - math.floor(seconds)) * 1000))
    whole = int(math.floor(seconds))
    hours = whole // 3600
    minutes = (whole % 3600) // 60
    secs = whole % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def stamp(seconds: int) -> str:
    return label(seconds).replace(":", "")


def extract_audio_chunk(source: Path, output: Path, start: int, duration: int) -> None:
    if output.exists() and output.stat().st_size > 0:
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            str(start),
            "-t",
            str(duration),
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "48k",
            str(output),
        ]
    )


def make_http_options(types: Any, args: argparse.Namespace) -> Any | None:
    if not args.disable_env_proxy:
        return None
    client_args = {"trust_env": False}
    return types.HttpOptions(client_args=client_args, async_client_args=client_args)


def make_client(args: argparse.Namespace):
    from google import genai
    from google.genai import types

    api_key = os.environ.get(args.api_key_env) or os.environ.get("API_KEY")
    if not api_key and args.api_key_file:
        api_key_path = Path(args.api_key_file)
        if not api_key_path.exists():
            raise ValueError(f"API key file not found: {api_key_path}")
        api_key = api_key_path.read_text(encoding="utf-8-sig").strip()

    http_options = make_http_options(types, args)

    if args.endpoint == "vertex-express":
        if not api_key:
            raise ValueError(f"{args.api_key_env}, API_KEY, or --api-key-file is required for vertex-express")
        return genai.Client(vertexai=True, api_key=api_key, http_options=http_options), types
    if args.endpoint == "developer":
        if not api_key:
            raise ValueError(f"{args.api_key_env}, API_KEY, or --api-key-file is required for developer")
        return genai.Client(api_key=api_key, http_options=http_options), types
    if not args.project:
        raise ValueError("GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT is required for vertex-standard")
    if http_options is None:
        http_options = types.HttpOptions(api_version="v1")
    else:
        http_options.api_version = "v1"
    return (
        genai.Client(
            vertexai=True,
            project=args.project,
            location=args.location,
            http_options=http_options,
        ),
        types,
    )


def clean_segments(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for chunk in chunks:
        analysis = chunk.get("analysis")
        if not isinstance(analysis, dict):
            continue
        raw_segments = analysis.get("segments")
        if not isinstance(raw_segments, list):
            continue
        for raw in raw_segments:
            if not isinstance(raw, dict):
                continue
            text = str(raw.get("text") or "").strip()
            if not text:
                continue
            try:
                start = float(raw.get("start_seconds"))
                end = float(raw.get("end_seconds"))
            except (TypeError, ValueError):
                start = float(chunk["start_seconds"])
                end = float(chunk["end_seconds"])
            if end < start:
                end = start
            segments.append(
                {
                    "start_seconds": start,
                    "end_seconds": end,
                    "start": label(start),
                    "end": label(end),
                    "text": text,
                    "confidence": str(raw.get("confidence") or "unknown"),
                    "chunk_index": chunk.get("index"),
                }
            )
    return segments


def existing_transcript_has_content(asr_dir: Path) -> bool:
    return (asr_dir / "transcript.txt").exists() and (asr_dir / "transcript.txt").stat().st_size > 0


def write_transcript_outputs(asr_dir: Path, payload: dict[str, Any], allow_empty_overwrite: bool = False) -> dict[str, Any]:
    segments = payload["segments"]
    if not segments and existing_transcript_has_content(asr_dir) and not allow_empty_overwrite:
        write_json(asr_dir / "transcript-last-empty-attempt.json", payload)
        return {
            "written": False,
            "preserved_existing": True,
            "reason": "empty_segments_preserved_existing_transcript",
        }

    txt_lines = [f"[{segment['start']}-{segment['end']}] {segment['text']}" for segment in segments]
    asr_dir.mkdir(parents=True, exist_ok=True)
    (asr_dir / "transcript.txt").write_text("\n".join(txt_lines) + ("\n" if txt_lines else ""), encoding="utf-8")
    write_json(asr_dir / "transcript.json", payload)

    srt_blocks = []
    for index, segment in enumerate(segments, start=1):
        srt_blocks.append(
            "\n".join(
                [
                    str(index),
                    f"{srt_time(segment['start_seconds'])} --> {srt_time(segment['end_seconds'])}",
                    segment["text"],
                ]
            )
        )
    (asr_dir / "transcript.srt").write_text("\n\n".join(srt_blocks) + ("\n" if srt_blocks else ""), encoding="utf-8")
    return {"written": True, "preserved_existing": False}


def transcribe_chunk(client: Any, types: Any, audio_path: Path, args: argparse.Namespace, start: int, end: int, video_id: str) -> dict[str, Any]:
    prompt = PROMPT_TEMPLATE.format(
        video_id=video_id,
        start_label=label(start),
        end_label=label(end),
        start_seconds=start,
        end_seconds=end,
        language=args.language or "auto",
    )
    response = client.models.generate_content(
        model=args.model,
        contents=[
            types.Part.from_bytes(data=audio_path.read_bytes(), mime_type="audio/mpeg"),
            prompt,
        ],
        config=types.GenerateContentConfig(
            temperature=0.0,
            response_mime_type="application/json",
            max_output_tokens=args.max_output_tokens,
        ),
    )
    return {
        "raw_response": jsonable(response),
        "text": response.text or "",
        "analysis": parse_json_text(response.text or ""),
    }


_BACKOFF_MULTIPLIERS = (1, 3, 9, 24, 60)


def retry_delay_for_attempt(attempt: int, base: float) -> float:
    if base <= 0:
        return 0.0
    idx = min(max(0, attempt - 1), len(_BACKOFF_MULTIPLIERS) - 1)
    return base * _BACKOFF_MULTIPLIERS[idx]


def is_non_retryable_error(exc: Exception) -> bool:
    try:
        from google.genai.errors import ClientError
    except ImportError:
        return False
    if not isinstance(exc, ClientError):
        return False
    code = getattr(exc, "code", None)
    if code is None:
        code = getattr(exc, "status_code", None)
    if code == 429:
        return False
    if isinstance(code, int) and 400 <= code < 500:
        return True
    return False


def transcribe_chunk_with_retries(
    client: Any,
    types: Any,
    audio_path: Path,
    args: argparse.Namespace,
    start: int,
    end: int,
    video_id: str,
) -> dict[str, Any]:
    attempts = max(1, int(args.retry_attempts or 1))
    base_delay = float(args.retry_delay_seconds or 0.0)
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return transcribe_chunk(client, types, audio_path, args, start, end, video_id)
        except Exception as exc:
            last_error = exc
            if is_non_retryable_error(exc):
                break
            if attempt >= attempts:
                break
            delay = retry_delay_for_attempt(attempt, base_delay)
            if delay:
                time.sleep(delay)
    assert last_error is not None
    raise last_error


def assess_asr_quality(duration: float, chunk_results: list[dict[str, Any]], segments: list[dict[str, Any]]) -> dict[str, Any]:
    chunks_total = len(chunk_results)
    chunks_failed = sum(1 for r in chunk_results if r.get("error"))
    chunks_succeeded = chunks_total - chunks_failed
    transcribed_seconds = sum(max(0.0, float(s.get("end_seconds", 0)) - float(s.get("start_seconds", 0))) for s in segments)
    coverage_ratio = transcribed_seconds / duration if duration > 0 else 0.0

    if chunks_total == 0:
        status = "failed"
    elif chunks_failed == 0 and coverage_ratio >= 0.30:
        status = "ok"
    elif chunks_failed == 0 and not segments and duration >= 30.0:
        # All chunks ran cleanly but produced 0 segments — legitimately no
        # speech (BGM-only / silent video). Distinguish from real failure so
        # these clips don't appear in "needs fixing" lists.
        status = "no_speech"
    elif coverage_ratio < 0.05:
        status = "failed"
    else:
        status = "partial"

    failure_reasons: list[dict[str, str]] = []
    for r in chunk_results:
        if not r.get("error"):
            continue
        err_path = r.get("error_path")
        tail_text = ""
        if err_path:
            try:
                lines = Path(err_path).read_text(encoding="utf-8", errors="ignore").strip().splitlines()
                tail_text = lines[-1][:200] if lines else ""
            except OSError:
                tail_text = ""
        failure_reasons.append({"range": str(r.get("range") or ""), "tail": tail_text})

    return {
        "status": status,
        "expectedDurationSeconds": round(duration, 2),
        "transcribedSeconds": round(transcribed_seconds, 2),
        "coverageRatio": round(coverage_ratio, 4),
        "chunksTotal": chunks_total,
        "chunksFailed": chunks_failed,
        "chunksSucceeded": chunks_succeeded,
        "failureReasons": failure_reasons[:10],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe video audio with Gemini.")
    parser.add_argument("--video-path", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--asr-dir", required=True)
    parser.add_argument("--provider", choices=["gemini"], default="gemini")
    parser.add_argument("--endpoint", choices=["vertex-standard", "vertex-express", "developer"], default="vertex-express")
    parser.add_argument("--model", default=DEFAULT_GEMINI_MODEL)
    parser.add_argument("--api-key-env", default="GEMINI_API_KEY")
    parser.add_argument("--api-key-file")
    parser.add_argument("--project", default=os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCLOUD_PROJECT"))
    parser.add_argument("--location", default=os.environ.get("GOOGLE_CLOUD_LOCATION") or "global")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--chunk-seconds", type=int, default=120)
    parser.add_argument("--max-chunks", type=int)
    parser.add_argument("--max-output-tokens", type=int, default=8192)
    parser.add_argument("--sleep-seconds", type=float, default=0.3)
    parser.add_argument("--retry-attempts", type=int, default=5)
    parser.add_argument("--retry-delay-seconds", type=float, default=5.0)
    parser.add_argument("--disable-env-proxy", action="store_true")
    parser.add_argument("--allow-empty-overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = Path(args.video_path)
    if not source.exists():
        raise SystemExit(f"Video file not found: {source}")

    work_dir = Path(args.work_dir)
    asr_dir = Path(args.asr_dir)
    chunks_dir = asr_dir / "api-audio-chunks"
    work_dir.mkdir(parents=True, exist_ok=True)
    asr_dir.mkdir(parents=True, exist_ok=True)

    duration = ffprobe_duration(source)
    chunks = build_chunks(duration, args.chunk_seconds, args.max_chunks)
    video_id = source.parent.name

    plan = {
        "provider": args.provider,
        "endpoint": args.endpoint,
        "model": args.model,
        "source_video": str(source),
        "duration_seconds": duration,
        "chunk_seconds": args.chunk_seconds,
        "chunks": [
            {"index": index, "start_seconds": start, "end_seconds": end, "range": f"{label(start)}-{label(end)}"}
            for index, (start, end) in enumerate(chunks)
        ],
    }

    if args.dry_run:
        plan_path = asr_dir / "api-transcription-plan.json"
        write_json(plan_path, {**plan, "dry_run": True})
        print(json.dumps({"dryRun": True, "planPath": str(plan_path), "chunks": len(chunks)}, ensure_ascii=False))
        return 0

    client, types = make_client(args)
    chunk_results = []
    for index, (start, end) in enumerate(chunks):
        audio_path = chunks_dir / f"audio-{stamp(start)}-{stamp(end)}.mp3"
        response_path = asr_dir / f"gemini-transcript-{stamp(start)}-{stamp(end)}.json"
        text_path = asr_dir / f"gemini-transcript-{stamp(start)}-{stamp(end)}.text.json"
        error_path = asr_dir / f"gemini-transcript-{stamp(start)}-{stamp(end)}.error.txt"
        extract_audio_chunk(source, audio_path, start, end - start)
        try:
            result = transcribe_chunk_with_retries(client, types, audio_path, args, start, end, video_id)
            write_json(response_path, result["raw_response"])
            text_path.write_text(result["text"], encoding="utf-8")
            chunk_results.append(
                {
                    "index": index,
                    "start_seconds": start,
                    "end_seconds": end,
                    "range": f"{label(start)}-{label(end)}",
                    "audio_path": str(audio_path),
                    "response_path": str(response_path),
                    "response_text_path": str(text_path),
                    "analysis": result["analysis"],
                }
            )
        except Exception:
            error_path.write_text(traceback.format_exc(), encoding="utf-8")
            chunk_results.append(
                {
                    "index": index,
                    "start_seconds": start,
                    "end_seconds": end,
                    "range": f"{label(start)}-{label(end)}",
                    "audio_path": str(audio_path),
                    "error": True,
                    "error_path": str(error_path),
                }
            )
        time.sleep(args.sleep_seconds)

    payload = {
        **plan,
        "chunks": chunk_results,
        "segments": clean_segments(chunk_results),
    }
    quality = assess_asr_quality(duration, chunk_results, payload["segments"])
    quality_path = asr_dir / "transcript-quality.json"
    write_json(quality_path, quality)
    payload["quality"] = quality
    write_status = write_transcript_outputs(asr_dir, payload, allow_empty_overwrite=args.allow_empty_overwrite)
    print(
        json.dumps(
            {
                "textPath": str(asr_dir / "transcript.txt"),
                "segments": len(payload["segments"]),
                "quality": quality["status"],
                "coverageRatio": quality["coverageRatio"],
                "chunksFailed": quality["chunksFailed"],
                "qualityPath": str(quality_path),
                **write_status,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
