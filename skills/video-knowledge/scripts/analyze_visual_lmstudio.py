#!/usr/bin/env python3
"""Local LM Studio (Qwen2.5-VL or similar) visual analysis helper.

Drop-in replacement for analyze_visual_gemini.py — writes the same set of
files (`keyframe-steps-*.json/.text.json/.error.txt` and
`keyframe-steps-summary.json`) so downstream stages (compose-bundle,
verify-and-fix-reports) work unchanged.

No external API. Connects to a local LM Studio server exposing the
OpenAI-compatible `/v1/chat/completions` endpoint. Free, offline, no quota
expiry, no OAuth.

Default endpoint:  http://localhost:11434/v1
Default model:     qwen2.5-vl-7b-instruct (override with --model)

Usage:
    python analyze_visual_lmstudio.py \\
        --video-path <PATH>/video.mp4 \\
        --work-dir <PATH>/keyframe_steps \\
        --mode keyframes \\
        --model qwen2.5-vl-7b-instruct
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import subprocess
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_LM_STUDIO_ENDPOINT = (
    os.environ.get("VIDEO_KNOWLEDGE_LM_STUDIO_URL")
    or "http://localhost:11434/v1"
)
DEFAULT_LM_STUDIO_MODEL = (
    os.environ.get("VIDEO_KNOWLEDGE_VISUAL_MODEL")
    or "qwen2.5-vl-7b-instruct"
)


PROMPT_TEMPLATE = """
You are the visual evidence analyzer for a personal video knowledge system.

The source is often a screen recording tutorial. The platform title, audio, or
chat may be misleading. Prefer evidence visible in the frames or clip: hard
subtitles, UI labels, node names, parameters, code, formulas, errors, menus,
and concrete operation steps.

Return STRICT JSON only. Write natural language values in Simplified Chinese.
Do not use Markdown. Do not invent exact code or UI labels that are not clear.

For any field marked with `<choose: a / b / c>`, the output MUST be ONE of
those exact strings — do NOT copy the whole "a / b / c" text into the value.
For example, if the field says `<choose: high / medium / low>`, output
`"high"` (or `"medium"` or `"low"`), NEVER `"high / medium / low"`.

Segment range: {segment_range}

Schema (output exactly this shape, populate values from the image):
{{
  "segment_range": "{segment_range}",
  "signal_profile": {{
    "has_hard_subtitles": <true_or_false>,
    "has_screen_recording": <true_or_false>,
    "has_code_or_formula": <true_or_false>,
    "primary_signal": "<choose: visual / audio / both / unknown>",
    "confidence": "<choose: high / medium / low>"
  }},
  "visible_text": [
    {{
      "time": "MM:SS or MM:SS-MM:SS",
      "text": "important visible text only",
      "source": "<choose: hard_subtitle / ui_label / node_name / parameter / code / formula / error / other>",
      "meaning": "why this matters",
      "confidence": "<choose: high / medium / low>",
      "needs_review": <true_or_false>
    }}
  ],
  "ui_entities": [
    {{
      "name": "node, panel, parameter, menu, or variable",
      "type": "<choose: node / panel / parameter / menu / button / graph / variable / unknown>",
      "role": "what it does in this segment",
      "confidence": "<choose: high / medium / low>"
    }}
  ],
  "code_or_formula": [
    {{
      "text": "short code/formula/function candidate",
      "kind": "<choose: code / formula / expression / function_name / unknown>",
      "interpretation": "what it means",
      "confidence": "<choose: high / medium / low>",
      "needs_exact_review": <true_or_false>
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
      "confidence": "<choose: high / medium / low>",
      "needs_review": <true_or_false>
    }}
  ],
  "concepts": [
    {{
      "title": "concept name",
      "summary": "what the viewer should learn",
      "evidence": "MM:SS or MM:SS-MM:SS",
      "confidence": "<choose: high / medium / low>"
    }}
  ],
  "gotchas": [
    {{
      "title": "mistake or warning",
      "symptom": "what goes wrong",
      "cause": "likely cause",
      "fix": "how to fix or check it",
      "evidence": "MM:SS or MM:SS-MM:SS",
      "confidence": "<choose: high / medium / low>"
    }}
  ],
  "needs_rewatch": [
    {{
      "time": "MM:SS or MM:SS-MM:SS",
      "reason": "why this needs review",
      "priority": "<choose: high / medium / low>"
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


def run_cmd(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True)


def ffprobe_duration(path: Path) -> float:
    result = run_cmd(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
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
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", str(timestamp), "-i", str(source),
        "-frames:v", "1",
        "-vf", f"scale={frame_width}:-2",
    ]
    if image_format == "jpeg":
        args.extend(["-q:v", str(jpeg_quality)])
    else:
        args.extend(["-compression_level", "6"])
    args.append(str(frame_path))
    run_cmd(args)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_json_text(text: str) -> dict[str, Any]:
    # Models sometimes wrap JSON in ```json ... ``` fences; strip those.
    s = text.strip()
    if s.startswith("```"):
        # find first newline after the fence
        first_newline = s.find("\n")
        if first_newline != -1:
            s = s[first_newline + 1 :]
        if s.endswith("```"):
            s = s[: -3].rstrip()
    try:
        parsed = json.loads(s)
    except json.JSONDecodeError:
        # Some local models repeat the prompt before the JSON. Try to locate
        # the outermost { ... } block and parse that.
        first = s.find("{")
        last = s.rfind("}")
        if 0 <= first < last:
            try:
                parsed = json.loads(s[first : last + 1])
                return parsed if isinstance(parsed, dict) else {"parse_error": True, "raw_text": text}
            except json.JSONDecodeError:
                pass
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


def image_to_data_url(path: Path, mime_type: str) -> str:
    with path.open("rb") as fh:
        data = fh.read()
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def call_lm_studio(
    endpoint: str,
    model: str,
    prompt_text: str,
    frame_paths: list[Path],
    frame_times: list[int],
    mime_type: str,
    max_output_tokens: int,
    temperature: float,
    timeout_seconds: float,
) -> dict[str, Any]:
    """POST a chat-completions request with embedded images. Returns the
    full response dict from the OpenAI-compatible server."""
    content_parts: list[dict[str, Any]] = [{"type": "text", "text": prompt_text}]
    for ts, p in zip(frame_times, frame_paths):
        content_parts.append({"type": "text", "text": f"Frame time: {mmss(ts)}"})
        content_parts.append(
            {
                "type": "image_url",
                "image_url": {"url": image_to_data_url(p, mime_type)},
            }
        )

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content_parts}],
        "temperature": temperature,
        "max_tokens": max_output_tokens,
        "stream": False,
    }

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint.rstrip("/") + "/chat/completions",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw)


_BACKOFF_MULTIPLIERS = (1, 3, 9, 24, 60)


def retry_delay_for_attempt(attempt: int, base: float) -> float:
    if base <= 0:
        return 0.0
    idx = min(max(0, attempt - 1), len(_BACKOFF_MULTIPLIERS) - 1)
    return base * _BACKOFF_MULTIPLIERS[idx]


def is_non_retryable_http_error(exc: urllib.error.HTTPError) -> bool:
    code = exc.code
    # 400/404 won't recover by waiting; 408/429/5xx might.
    if code in (408, 429):
        return False
    if 400 <= code < 500:
        return True
    return False


def generate_with_retries(
    endpoint: str,
    model: str,
    prompt_text: str,
    frame_paths: list[Path],
    frame_times: list[int],
    mime_type: str,
    max_output_tokens: int,
    temperature: float,
    attempts: int,
    base_delay: float,
    timeout_seconds: float,
) -> dict[str, Any]:
    attempts = max(1, int(attempts or 1))
    base_delay = float(base_delay or 0.0)
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return call_lm_studio(
                endpoint, model, prompt_text, frame_paths, frame_times,
                mime_type, max_output_tokens, temperature, timeout_seconds,
            )
        except urllib.error.HTTPError as exc:
            last_error = exc
            if is_non_retryable_http_error(exc):
                break
        except Exception as exc:
            last_error = exc
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
        failure_reasons.append({"range": str(r.get("segment_range") or ""), "tail": tail_text})

    return {
        "status": status,
        "segmentsTotal": total,
        "segmentsFailed": failed,
        "segmentsSucceeded": succeeded,
        "usableEntries": usable,
        "failureReasons": failure_reasons[:10],
    }


def analyze_keyframes(
    source: Path,
    work_dir: Path,
    args: argparse.Namespace,
    segments: list[tuple[int, int]],
) -> list[dict[str, Any]]:
    frames_dir = work_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    extension = "jpg" if args.frame_image_format == "jpeg" else "png"
    mime_type = "image/jpeg" if args.frame_image_format == "jpeg" else "image/png"

    for index, (start, end) in enumerate(segments):
        segment_range = f"{mmss(start)}-{mmss(end)}"
        frame_times = list(range(start, end, args.frame_interval))
        if not frame_times or frame_times[-1] != end - 1:
            frame_times.append(max(start, end - 1))

        frame_paths: list[Path] = []
        for timestamp in frame_times:
            frame_path = frames_dir / f"frame-{stamp(timestamp)}.{extension}"
            extract_frame(
                source, frame_path, timestamp,
                args.frame_width, args.frame_image_format, args.jpeg_quality,
            )
            frame_paths.append(frame_path)

        response_path = work_dir / f"keyframe-steps-{stamp(start)}-{stamp(end)}.json"
        text_path = work_dir / f"keyframe-steps-{stamp(start)}-{stamp(end)}.text.json"
        error_path = work_dir / f"keyframe-steps-{stamp(start)}-{stamp(end)}.error.txt"

        prompt_text = PROMPT_TEMPLATE.format(segment_range=segment_range)

        try:
            response = generate_with_retries(
                args.endpoint_url, args.model, prompt_text,
                frame_paths, frame_times, mime_type,
                args.max_output_tokens, args.temperature,
                args.retry_attempts, args.retry_delay_seconds,
                args.request_timeout,
            )
            write_json(response_path, response)
            choices = response.get("choices") or []
            text = ""
            if choices:
                msg = choices[0].get("message") or {}
                text = msg.get("content") or ""
            text_path.write_text(text, encoding="utf-8")
            results.append(
                {
                    "index": index,
                    "segment_range": segment_range,
                    "frame_times": [mmss(timestamp) for timestamp in frame_times],
                    "frame_paths": [str(p) for p in frame_paths],
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
                    "frame_paths": [str(p) for p in frame_paths],
                    "error_path": str(error_path),
                    "error": True,
                }
            )
        if args.sleep_seconds:
            time.sleep(args.sleep_seconds)

    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze video keyframes with LM Studio (Qwen2.5-VL).")
    parser.add_argument("--video-path", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--mode", choices=["keyframes"], default="keyframes",
                        help="Only 'keyframes' is supported on the LM Studio path (clip uploads need video model support).")
    parser.add_argument("--endpoint-url", default=DEFAULT_LM_STUDIO_ENDPOINT,
                        help="OpenAI-compatible base URL of the local LM Studio server.")
    parser.add_argument("--model", default=DEFAULT_LM_STUDIO_MODEL,
                        help="Vision model id loaded in LM Studio (e.g. qwen2.5-vl-7b-instruct).")
    parser.add_argument("--segment-seconds", type=int, default=75)
    parser.add_argument("--frame-interval", type=int, default=30)
    parser.add_argument("--frame-image-format", choices=["jpeg", "png"], default="jpeg")
    parser.add_argument("--frame-width", type=int, default=960)
    parser.add_argument("--jpeg-quality", type=int, default=6)
    parser.add_argument("--max-segments", type=int)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--temperature", type=float, default=0.05)
    parser.add_argument("--sleep-seconds", type=float, default=0.0,
                        help="Pause between segments. Local server has no rate limit, 0 is fine.")
    parser.add_argument("--retry-attempts", type=int, default=3)
    parser.add_argument("--retry-delay-seconds", type=float, default=5.0)
    parser.add_argument("--request-timeout", type=float, default=600.0,
                        help="Per-request HTTP timeout in seconds.")
    parser.add_argument("--dry-run", action="store_true")

    # Accept (but ignore) Gemini-only args so the same server spawn-args
    # contract works for both providers without TS-side changes.
    for ignored in (
        "--endpoint", "--project", "--location",
        "--api-key-env", "--api-key-file",
    ):
        parser.add_argument(
            ignored,
            default=None,
            dest=ignored.lstrip("-").replace("-", "_") + "_unused",
        )

    args, _unknown = parser.parse_known_args()

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
                "provider": "lm-studio",
                "source_video": str(source),
                "mode": args.mode,
                "duration_seconds": duration,
                "segment_seconds": args.segment_seconds,
                "frame_interval": args.frame_interval,
                "endpoint_url": args.endpoint_url,
                "model": args.model,
                "segments": [{"start": mmss(start), "end": mmss(end)} for start, end in segments],
            },
        )
        print(json.dumps({"dryRun": True, "planPath": str(plan_path)}, ensure_ascii=False))
        return 0

    if args.mode != "keyframes":
        raise SystemExit(f"mode={args.mode} not supported by LM Studio path; only 'keyframes' allowed.")

    t0 = time.time()
    results = analyze_keyframes(source, work_dir, args, segments)
    elapsed = time.time() - t0
    summary_path = work_dir / "keyframe-steps-summary.json"

    quality = assess_visual_quality(results)
    write_json(
        summary_path,
        {
            "provider": "lm-studio",
            "source_video": str(source),
            "duration_seconds": duration,
            "mode": args.mode,
            "segment_seconds": args.segment_seconds,
            "frame_interval": args.frame_interval,
            "model": args.model,
            "endpoint_url": args.endpoint_url,
            "results": results,
            "quality": quality,
            "elapsed_seconds": round(elapsed, 2),
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
                "provider": "lm-studio",
                "model": args.model,
                "elapsedSeconds": round(elapsed, 2),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
