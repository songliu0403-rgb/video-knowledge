#!/usr/bin/env python3
"""Gemini visual analysis helper for video-knowledge ingestion.

This script is intentionally evidence-first. It analyzes either sampled
keyframes or short clips, writes per-segment model outputs, and produces a
summary JSON for the local `video.ingest.analyze-visual` capability.
"""

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
    os.environ.get("VIDEO_KNOWLEDGE_VISUAL_MODEL")
    or os.environ.get("VIDEO_KNOWLEDGE_GEMINI_MODEL")
    or "gemini-3.1-pro-preview"
)


PROMPT_TEMPLATE = """
You are the visual evidence analyzer for a personal video knowledge system.

The source is often a screen recording tutorial. The platform title, audio, or
chat may be misleading. Prefer evidence visible in the frames or clip: hard
subtitles, UI labels, node names, parameters, code, formulas, errors, menus,
and concrete operation steps.

Return STRICT JSON only. Write natural language values in Simplified Chinese.
Do not use Markdown. Do not invent exact code or UI labels that are not clear.

Segment range: {segment_range}

Schema:
{{
  "segment_range": "{segment_range}",
  "signal_profile": {{
    "has_hard_subtitles": true,
    "has_screen_recording": true,
    "has_code_or_formula": true,
    "primary_signal": "visual | audio | both | unknown",
    "confidence": "high | medium | low"
  }},
  "visible_text": [
    {{
      "time": "MM:SS or MM:SS-MM:SS",
      "text": "important visible text only",
      "source": "hard_subtitle | ui_label | node_name | parameter | code | formula | error | other",
      "meaning": "why this matters",
      "confidence": "high | medium | low",
      "needs_review": false
    }}
  ],
  "ui_entities": [
    {{
      "name": "node, panel, parameter, menu, or variable",
      "type": "node | panel | parameter | menu | button | graph | variable | unknown",
      "role": "what it does in this segment",
      "confidence": "high | medium | low"
    }}
  ],
  "code_or_formula": [
    {{
      "text": "short code/formula/function candidate",
      "kind": "code | formula | expression | function_name | unknown",
      "interpretation": "what it means",
      "confidence": "high | medium | low",
      "needs_exact_review": true
    }}
  ],
  "operation_steps": [
    {{
      "step_no": 1,
      "time": "MM:SS or MM:SS-MM:SS",
      "action": "operation performed by the author",
      "target": "UI/node/parameter/code target",
      "input_or_value": "value if visible",
      "observed_result": "result visible on screen",
      "confidence": "high | medium | low",
      "needs_review": false
    }}
  ],
  "concepts": [
    {{
      "title": "concept name",
      "summary": "what the viewer should learn",
      "evidence": "MM:SS or MM:SS-MM:SS",
      "confidence": "high | medium | low"
    }}
  ],
  "gotchas": [
    {{
      "title": "mistake or warning",
      "symptom": "what goes wrong",
      "cause": "likely cause",
      "fix": "how to fix or check it",
      "evidence": "MM:SS or MM:SS-MM:SS",
      "confidence": "high | medium | low"
    }}
  ],
  "needs_rewatch": [
    {{
      "time": "MM:SS or MM:SS-MM:SS",
      "reason": "why this needs review",
      "priority": "high | medium | low"
    }}
  ],
  "notes": "short audit note"
}}

Array limits: visible_text <= 10, ui_entities <= 8, code_or_formula <= 6,
operation_steps <= 6, concepts <= 4, gotchas <= 3, needs_rewatch <= 3.
""".strip()


def mmss(seconds: int) -> str:
    minutes, secs = divmod(max(0, int(seconds)), 60)
    return f"{minutes:02d}:{secs:02d}"


def stamp(seconds: int) -> str:
    return mmss(seconds).replace(":", "")


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True)


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


def extract_frame(
    source: Path,
    frame_path: Path,
    timestamp: int,
    frame_width: int,
    image_format: str,
    jpeg_quality: int,
) -> None:
    if frame_path.exists() and frame_path.stat().st_size > 0:
        return
    frame_path.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        str(timestamp),
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-vf",
        f"scale={frame_width}:-2",
    ]
    if image_format == "jpeg":
        args.extend(["-q:v", str(jpeg_quality)])
    else:
        args.extend(["-compression_level", "6"])
    args.append(str(frame_path))
    run(
        args
    )


def make_clip(source: Path, clip_path: Path, start: int, duration: int) -> None:
    if clip_path.exists() and clip_path.stat().st_size > 0:
        return
    clip_path.parent.mkdir(parents=True, exist_ok=True)
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
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "27",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            str(clip_path),
        ]
    )


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


def build_segments(duration: float, segment_seconds: int, max_segments: int | None) -> list[tuple[int, int]]:
    count = math.ceil(duration / segment_seconds)
    if max_segments is not None:
        count = min(count, max_segments)
    segments = []
    for index in range(count):
        start = index * segment_seconds
        end = min(int(math.ceil(duration)), start + segment_seconds)
        if end > start:
            segments.append((start, end))
    return segments


def make_client(args: argparse.Namespace):
    from google import genai
    from google.genai import types

    api_key = os.environ.get(args.api_key_env) or os.environ.get("API_KEY")
    if not api_key and args.api_key_file:
        api_key_path = Path(args.api_key_file)
        if not api_key_path.exists():
            raise ValueError(f"API key file not found: {api_key_path}")
        api_key = api_key_path.read_text(encoding="utf-8-sig").strip()

    if args.endpoint == "vertex-express":
        if not api_key:
            raise ValueError(f"{args.api_key_env}, API_KEY, or --api-key-file is required for vertex-express")
        return genai.Client(vertexai=True, api_key=api_key), types
    if args.endpoint == "developer":
        if not api_key:
            raise ValueError(f"{args.api_key_env}, API_KEY, or --api-key-file is required for developer")
        return genai.Client(api_key=api_key), types
    if not args.project:
        raise ValueError("GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT is required for vertex-standard")
    return (
        genai.Client(
            vertexai=True,
            project=args.project,
            location=args.location,
            http_options=types.HttpOptions(api_version="v1"),
        ),
        types,
    )


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


def generate_with_retries(
    client: Any,
    model: str,
    contents: list[Any],
    config: Any,
    attempts: int,
    base_delay: float,
) -> Any:
    attempts = max(1, int(attempts or 1))
    base_delay = float(base_delay or 0.0)
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return client.models.generate_content(model=model, contents=contents, config=config)
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


def assess_visual_quality(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    failed = sum(1 for r in results if r.get("error"))
    succeeded = total - failed
    usable = 0
    for r in results:
        if r.get("error"):
            continue
        analysis = r.get("analysis")
        if isinstance(analysis, dict) and not analysis.get("parse_error"):
            usable += 1
    fail_ratio = failed / total if total > 0 else 0.0

    if total == 0:
        status = "failed"
    elif failed == 0 and usable == total:
        status = "ok"
    elif fail_ratio > 0.7 or usable == 0:
        status = "failed"
    else:
        status = "partial"

    failure_reasons: list[dict[str, str]] = []
    for r in results:
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
        failure_reasons.append({"range": str(r.get("segment_range") or r.get("clip_range") or ""), "tail": tail_text})

    return {
        "status": status,
        "segmentsTotal": total,
        "segmentsFailed": failed,
        "segmentsSucceeded": succeeded,
        "usableEntries": usable,
        "failureReasons": failure_reasons[:10],
    }


def analyze_keyframes(client: Any, types: Any, source: Path, work_dir: Path, args: argparse.Namespace, segments: list[tuple[int, int]]) -> list[dict[str, Any]]:
    frames_dir = work_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    results = []
    extension = "jpg" if args.frame_image_format == "jpeg" else "png"
    mime_type = "image/jpeg" if args.frame_image_format == "jpeg" else "image/png"

    for index, (start, end) in enumerate(segments):
        segment_range = f"{mmss(start)}-{mmss(end)}"
        frame_times = list(range(start, end, args.frame_interval))
        if not frame_times or frame_times[-1] != end - 1:
            frame_times.append(max(start, end - 1))

        contents: list[Any] = [PROMPT_TEMPLATE.format(segment_range=segment_range)]
        frame_paths = []
        for timestamp in frame_times:
            frame_path = frames_dir / f"frame-{stamp(timestamp)}.{extension}"
            extract_frame(source, frame_path, timestamp, args.frame_width, args.frame_image_format, args.jpeg_quality)
            frame_paths.append(str(frame_path))
            contents.append(f"Frame time: {mmss(timestamp)}")
            contents.append(types.Part.from_bytes(data=frame_path.read_bytes(), mime_type=mime_type))

        response_path = work_dir / f"keyframe-steps-{stamp(start)}-{stamp(end)}.json"
        text_path = work_dir / f"keyframe-steps-{stamp(start)}-{stamp(end)}.text.json"
        error_path = work_dir / f"keyframe-steps-{stamp(start)}-{stamp(end)}.error.txt"

        try:
            response = generate_with_retries(
                client,
                args.model,
                contents,
                types.GenerateContentConfig(
                    temperature=0.05,
                    response_mime_type="application/json",
                    max_output_tokens=args.max_output_tokens,
                ),
                args.retry_attempts,
                args.retry_delay_seconds,
            )
            write_json(response_path, response)
            text = response.text or ""
            text_path.write_text(text, encoding="utf-8")
            results.append(
                {
                    "index": index,
                    "segment_range": segment_range,
                    "frame_times": [mmss(timestamp) for timestamp in frame_times],
                    "frame_paths": frame_paths,
                    "response_text_path": str(text_path),
                    "analysis": parse_json_text(text),
                }
            )
        except Exception:
            error_path.write_text(traceback.format_exc(), encoding="utf-8")
            results.append(
                {
                    "index": index,
                    "segment_range": segment_range,
                    "frame_times": [mmss(timestamp) for timestamp in frame_times],
                    "frame_paths": frame_paths,
                    "error_path": str(error_path),
                    "error": True,
                }
            )
        time.sleep(args.sleep_seconds)

    return results


def analyze_clips(client: Any, types: Any, source: Path, work_dir: Path, args: argparse.Namespace, segments: list[tuple[int, int]]) -> list[dict[str, Any]]:
    clips_dir = work_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    results = []

    for index, (start, end) in enumerate(segments):
        segment_range = f"{mmss(start)}-{mmss(end)}"
        clip_path = clips_dir / f"clip-{stamp(start)}-{stamp(end)}.mp4"
        response_path = work_dir / f"hard-subtitle-{stamp(start)}-{stamp(end)}.json"
        text_path = work_dir / f"hard-subtitle-{stamp(start)}-{stamp(end)}.text.json"
        error_path = work_dir / f"hard-subtitle-{stamp(start)}-{stamp(end)}.error.txt"

        make_clip(source, clip_path, start, end - start)
        try:
            response = generate_with_retries(
                client,
                args.model,
                [
                    types.Part.from_bytes(data=clip_path.read_bytes(), mime_type="video/mp4"),
                    PROMPT_TEMPLATE.format(segment_range=segment_range),
                ],
                types.GenerateContentConfig(
                    temperature=0.1,
                    response_mime_type="application/json",
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_MEDIUM,
                    max_output_tokens=args.max_output_tokens,
                ),
                args.retry_attempts,
                args.retry_delay_seconds,
            )
            write_json(response_path, response)
            text = response.text or ""
            text_path.write_text(text, encoding="utf-8")
            results.append(
                {
                    "index": index,
                    "clip_range": segment_range,
                    "clip_path": str(clip_path),
                    "response_text_path": str(text_path),
                    "analysis": parse_json_text(text),
                }
            )
        except Exception:
            error_path.write_text(traceback.format_exc(), encoding="utf-8")
            results.append(
                {
                    "index": index,
                    "clip_range": segment_range,
                    "clip_path": str(clip_path),
                    "error_path": str(error_path),
                    "error": True,
                }
            )
        time.sleep(args.sleep_seconds)

    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze video keyframes or clips with Gemini.")
    parser.add_argument("--video-path", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--mode", choices=["keyframes", "clips"], default="keyframes")
    parser.add_argument("--endpoint", choices=["vertex-standard", "vertex-express", "developer"], default="vertex-standard")
    parser.add_argument("--model", default=DEFAULT_GEMINI_MODEL)
    parser.add_argument("--api-key-env", default="GEMINI_API_KEY")
    parser.add_argument("--api-key-file")
    parser.add_argument("--project", default=os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCLOUD_PROJECT"))
    parser.add_argument("--location", default=os.environ.get("GOOGLE_CLOUD_LOCATION") or "global")
    parser.add_argument("--segment-seconds", type=int, default=75)
    parser.add_argument("--frame-interval", type=int, default=30)
    parser.add_argument("--frame-image-format", choices=["jpeg", "png"], default="jpeg")
    parser.add_argument("--frame-width", type=int, default=960)
    parser.add_argument("--jpeg-quality", type=int, default=6)
    parser.add_argument("--max-segments", type=int)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--sleep-seconds", type=float, default=0.3)
    parser.add_argument("--retry-attempts", type=int, default=5)
    parser.add_argument("--retry-delay-seconds", type=float, default=5.0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = Path(args.video_path)
    if not source.exists():
        raise SystemExit(f"Video file not found: {source}")

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    duration = ffprobe_duration(source)
    segments = build_segments(duration, args.segment_seconds, args.max_segments)

    if args.dry_run:
        plan_path = work_dir / "visual-analysis-plan.json"
        write_json(
            plan_path,
            {
                "dry_run": True,
                "source_video": str(source),
                "mode": args.mode,
                "duration_seconds": duration,
                "segment_seconds": args.segment_seconds,
                "frame_interval": args.frame_interval,
                "segments": [{"start": mmss(start), "end": mmss(end)} for start, end in segments],
            },
        )
        print(json.dumps({"dryRun": True, "planPath": str(plan_path)}, ensure_ascii=False))
        return 0

    client, types = make_client(args)
    if args.mode == "clips":
        results = analyze_clips(client, types, source, work_dir, args, segments)
        summary_path = work_dir / "hard-subtitle-steps-summary.json"
    else:
        results = analyze_keyframes(client, types, source, work_dir, args, segments)
        summary_path = work_dir / "keyframe-steps-summary.json"

    quality = assess_visual_quality(results)
    write_json(
        summary_path,
        {
            "source_video": str(source),
            "duration_seconds": duration,
            "mode": args.mode,
            "segment_seconds": args.segment_seconds,
            "frame_interval": args.frame_interval if args.mode == "keyframes" else None,
            "model": args.model,
            "endpoint": args.endpoint,
            "project": args.project,
            "location": args.location,
            "results": results,
            "quality": quality,
        },
    )
    print(
        json.dumps(
            {
                "summaryPath": str(summary_path),
                "segments": len(segments),
                "quality": quality["status"],
                "segmentsFailed": quality["segmentsFailed"],
                "usableEntries": quality["usableEntries"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
