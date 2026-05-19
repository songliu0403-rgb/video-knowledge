#!/usr/bin/env python3
"""Select representative video keyframes by clustering similar samples.

The selector samples low-resolution grayscale frames with ffmpeg, groups
visually similar consecutive frames, then exports the highest-quality frame in
each cluster. It is meant to create evidence screenshots for later OCR/vision
analysis, not to replace semantic video understanding.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO


@dataclass
class FrameSample:
    index: int
    timestamp: float
    width: int
    height: int
    data: bytes
    score: float
    edge: float
    entropy: float
    exposure: float
    diff_from_prev: float | None = None
    diff_from_anchor: float | None = None
    semantic_score: float = 0.0
    semantic_reasons: list[str] = field(default_factory=list)


@dataclass
class FrameSelection:
    cluster_index: int
    frame: FrameSample
    reasons: list[str]
    forced: bool = False


@dataclass
class SemanticSignal:
    start: float
    end: float
    score: float
    reasons: list[str]
    source: str = "semantic"
    text: str | None = None


def resolve_binary(name: str, override: str | None) -> str:
    if override:
        return override
    found = shutil.which(name)
    if not found:
        raise SystemExit(f"Missing required binary: {name}")
    return found


def run_text(cmd: list[str]) -> str:
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def probe_duration(ffprobe: str, video: Path) -> float | None:
    try:
        out = run_text(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(video),
            ]
        )
        return float(out) if out else None
    except Exception:
        return None


def read_token(stream: BinaryIO) -> bytes | None:
    token = bytearray()
    while True:
        c = stream.read(1)
        if not c:
            return bytes(token) if token else None
        if c == b"#":
            stream.readline()
            continue
        if c in b" \t\r\n":
            if token:
                return bytes(token)
            continue
        token.append(c[0])
        break

    while True:
        c = stream.read(1)
        if not c or c in b" \t\r\n":
            break
        token.append(c[0])
    return bytes(token)


def read_pgm(stream: BinaryIO) -> tuple[int, int, bytes] | None:
    magic = read_token(stream)
    if magic is None:
        return None
    if magic != b"P5":
        raise RuntimeError(f"Unexpected image stream format: {magic!r}")

    width_token = read_token(stream)
    height_token = read_token(stream)
    maxval_token = read_token(stream)
    if width_token is None or height_token is None or maxval_token is None:
        return None

    width = int(width_token)
    height = int(height_token)
    maxval = int(maxval_token)
    if maxval > 255:
        raise RuntimeError("Only 8-bit PGM frames are supported")

    expected = width * height
    data = stream.read(expected)
    if len(data) != expected:
        return None
    return width, height, data


def frame_metrics(data: bytes, width: int, height: int) -> tuple[float, float, float, float]:
    if not data:
        return 0.0, 0.0, 0.0, 0.0

    hist = [0] * 256
    total = 0
    for value in data:
        hist[value] += 1
        total += value

    n = len(data)
    mean = total / (n * 255.0)
    entropy = 0.0
    for count in hist:
        if count:
            p = count / n
            entropy -= p * math.log2(p)
    entropy_norm = min(entropy / 8.0, 1.0)
    exposure = max(0.0, 1.0 - abs(mean - 0.5) * 2.0)

    edge_total = 0
    edge_count = 0
    for y in range(height):
        row = y * width
        for x in range(width - 1):
            edge_total += abs(data[row + x] - data[row + x + 1])
            edge_count += 1
    for y in range(height - 1):
        row = y * width
        next_row = (y + 1) * width
        for x in range(width):
            edge_total += abs(data[row + x] - data[next_row + x])
            edge_count += 1

    edge = edge_total / (edge_count * 255.0) if edge_count else 0.0
    clarity = min(edge * 8.0, 1.0)
    score = 0.55 * clarity + 0.30 * entropy_norm + 0.15 * exposure
    return score, edge, entropy_norm, exposure


def frame_diff(a: FrameSample, b: FrameSample) -> float:
    if a.width != b.width or a.height != b.height or len(a.data) != len(b.data):
        return 1.0
    total = 0
    for av, bv in zip(a.data, b.data):
        total += abs(av - bv)
    return total / (len(a.data) * 255.0)


def iter_samples(ffmpeg: str, video: Path, interval: float, preview_width: int):
    vf = f"fps=1/{interval},scale={preview_width}:-1,format=gray"
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video),
        "-vf",
        vf,
        "-f",
        "image2pipe",
        "-vcodec",
        "pgm",
        "-",
    ]
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None

    index = 0
    try:
        while True:
            pgm = read_pgm(process.stdout)
            if pgm is None:
                break
            width, height, data = pgm
            score, edge, entropy, exposure = frame_metrics(data, width, height)
            yield FrameSample(
                index=index,
                timestamp=index * interval,
                width=width,
                height=height,
                data=data,
                score=score,
                edge=edge,
                entropy=entropy,
                exposure=exposure,
            )
            index += 1
    finally:
        stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
        return_code = process.wait()
        if return_code != 0:
            raise RuntimeError(stderr.strip() or f"ffmpeg exited with {return_code}")


def build_clusters(
    samples: list[FrameSample],
    diff_threshold: float,
    anchor_diff_threshold: float,
) -> list[list[FrameSample]]:
    clusters: list[list[FrameSample]] = []
    current: list[FrameSample] = []
    anchor: FrameSample | None = None
    prev: FrameSample | None = None

    for sample in samples:
        if not current:
            current = [sample]
            anchor = sample
            prev = sample
            continue

        assert anchor is not None and prev is not None
        sample.diff_from_prev = frame_diff(prev, sample)
        sample.diff_from_anchor = frame_diff(anchor, sample)

        same_cluster = (
            sample.diff_from_prev <= diff_threshold
            and sample.diff_from_anchor <= anchor_diff_threshold
        )
        if same_cluster:
            current.append(sample)
        else:
            clusters.append(current)
            current = [sample]
            anchor = sample
        prev = sample

    if current:
        clusters.append(current)
    return clusters


def cluster_index_by_frame(clusters: list[list[FrameSample]]) -> dict[int, int]:
    mapping: dict[int, int] = {}
    for cluster_index, cluster in enumerate(clusters):
        for frame in cluster:
            mapping[frame.index] = cluster_index
    return mapping


def add_selection(
    selections: dict[int, FrameSelection],
    frame: FrameSample,
    cluster_index: int,
    reason: str,
    forced: bool = False,
) -> None:
    existing = selections.get(frame.index)
    if existing:
        if reason not in existing.reasons:
            existing.reasons.append(reason)
        existing.forced = existing.forced or forced
        return

    selections[frame.index] = FrameSelection(
        cluster_index=cluster_index,
        frame=frame,
        reasons=[reason],
        forced=forced,
    )


def select_coverage_frames(
    samples: list[FrameSample],
    target_interval_seconds: float,
) -> list[FrameSample]:
    if target_interval_seconds <= 0 or not samples:
        return []

    selected: list[FrameSample] = []
    first = samples[0].timestamp
    last = samples[-1].timestamp
    window_start = math.floor(first / target_interval_seconds) * target_interval_seconds

    while window_start <= last:
        window_end = window_start + target_interval_seconds
        candidates = [
            frame
            for frame in samples
            if window_start <= frame.timestamp < window_end
        ]
        if candidates:
            selected.append(best_sample(candidates))
        window_start = window_end

    return selected


def nearest_sample(samples: list[FrameSample], timestamp: float) -> FrameSample | None:
    if not samples:
        return None
    return min(samples, key=lambda frame: abs(frame.timestamp - timestamp))


def parse_timestamp(value: str) -> float:
    stripped = value.strip()
    if not stripped:
        raise ValueError("empty timestamp")
    if ":" not in stripped:
        return float(stripped)

    parts = [float(part) for part in stripped.split(":")]
    if len(parts) == 2:
        minutes, seconds = parts
        return minutes * 60 + seconds
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return hours * 3600 + minutes * 60 + seconds
    raise ValueError(f"unsupported timestamp: {value}")


TIME_PATTERN = re.compile(r"(?:(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)")


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def parse_time_range(value: Any, fallback: tuple[float, float] | None = None) -> tuple[float, float] | None:
    if value is None:
        return fallback
    if isinstance(value, (int, float)):
        seconds = float(value)
        return seconds, seconds
    if not isinstance(value, str):
        return fallback

    text = value.strip()
    if not text:
        return fallback

    matches = TIME_PATTERN.findall(text)
    if not matches:
        return fallback
    try:
        start = parse_timestamp(matches[0])
        end = parse_timestamp(matches[1]) if len(matches) > 1 else start
    except ValueError:
        return fallback
    if end < start:
        start, end = end, start
    return start, end


def confidence_factor(value: Any) -> float:
    if not isinstance(value, str):
        return 0.85
    return {
        "high": 1.0,
        "medium": 0.8,
        "low": 0.6,
    }.get(value.lower(), 0.85)


def score_for_visible_text(entry: dict[str, Any]) -> float:
    source = str(entry.get("source") or "visible_text").lower()
    base = {
        "error": 0.96,
        "code": 0.94,
        "formula": 0.92,
        "node_name": 0.88,
        "parameter": 0.86,
        "ui_label": 0.78,
        "hard_subtitle": 0.72,
    }.get(source, 0.68)
    return clamp(base * confidence_factor(entry.get("confidence")))


def add_semantic_signal(
    signals: list[SemanticSignal],
    time_value: Any,
    score: float,
    reasons: list[str],
    source: str,
    text: str | None = None,
    fallback: tuple[float, float] | None = None,
) -> None:
    parsed_range = parse_time_range(time_value, fallback)
    if parsed_range is None:
        return
    start, end = parsed_range
    signals.append(
        SemanticSignal(
            start=start,
            end=end,
            score=clamp(score),
            reasons=reasons,
            source=source,
            text=text,
        )
    )


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def load_generic_semantic_entries(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("signals", "frames", "items", "selected", "keyframes"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def load_generic_semantic_manifest(payload: Any) -> list[SemanticSignal]:
    signals: list[SemanticSignal] = []
    for entry in load_generic_semantic_entries(payload):
        score_value = (
            entry.get("semanticScore")
            or entry.get("valueScore")
            or entry.get("importance")
            or entry.get("score")
            or 0.0
        )
        try:
            score = float(score_value)
        except (TypeError, ValueError):
            score = 0.0

        reasons_value = entry.get("reasons") or entry.get("labels") or entry.get("reason")
        if isinstance(reasons_value, list):
            reasons = [str(item) for item in reasons_value if str(item)]
        elif reasons_value:
            reasons = [str(reasons_value)]
        else:
            reasons = ["semantic_manifest"]

        start_value = entry.get("start") or entry.get("startTime")
        end_value = entry.get("end") or entry.get("endTime")
        if start_value is not None and end_value is not None:
            time_value = f"{start_value}-{end_value}"
        else:
            time_value = entry.get("time") or entry.get("timestamp")

        add_semantic_signal(
            signals,
            time_value,
            score,
            reasons,
            str(entry.get("source") or "semantic_manifest"),
            str(entry.get("text")) if entry.get("text") is not None else None,
        )
    return signals


def load_gemini_visual_summary(payload: Any) -> list[SemanticSignal]:
    if not isinstance(payload, dict):
        return []

    signals: list[SemanticSignal] = []
    for result in as_list(payload.get("results")):
        if not isinstance(result, dict):
            continue
        segment_range = parse_time_range(result.get("segment_range") or result.get("clip_range"))
        analysis = result.get("analysis")
        if not isinstance(analysis, dict):
            continue

        for entry in as_list(analysis.get("visible_text")):
            if not isinstance(entry, dict):
                continue
            source = str(entry.get("source") or "visible_text")
            add_semantic_signal(
                signals,
                entry.get("time"),
                score_for_visible_text(entry),
                [f"visible_text:{source}"],
                "gemini_visual",
                str(entry.get("text")) if entry.get("text") is not None else None,
                segment_range,
            )

        for entry in as_list(analysis.get("code_or_formula")):
            if not isinstance(entry, dict):
                continue
            kind = str(entry.get("kind") or "code_or_formula")
            add_semantic_signal(
                signals,
                entry.get("time") or entry.get("evidence"),
                0.94 * confidence_factor(entry.get("confidence")),
                [f"code_or_formula:{kind}"],
                "gemini_visual",
                str(entry.get("text")) if entry.get("text") is not None else None,
                segment_range,
            )

        for entry in as_list(analysis.get("operation_steps")):
            if not isinstance(entry, dict):
                continue
            add_semantic_signal(
                signals,
                entry.get("time"),
                0.86 * confidence_factor(entry.get("confidence")),
                ["operation_step"],
                "gemini_visual",
                str(entry.get("action")) if entry.get("action") is not None else None,
                segment_range,
            )

        for entry in as_list(analysis.get("concepts")):
            if not isinstance(entry, dict):
                continue
            add_semantic_signal(
                signals,
                entry.get("evidence") or entry.get("time"),
                0.82 * confidence_factor(entry.get("confidence")),
                ["concept"],
                "gemini_visual",
                str(entry.get("title")) if entry.get("title") is not None else None,
                segment_range,
            )

        for entry in as_list(analysis.get("gotchas")):
            if not isinstance(entry, dict):
                continue
            add_semantic_signal(
                signals,
                entry.get("evidence") or entry.get("time"),
                0.94 * confidence_factor(entry.get("confidence")),
                ["gotcha"],
                "gemini_visual",
                str(entry.get("title")) if entry.get("title") is not None else None,
                segment_range,
            )

        for entry in as_list(analysis.get("needs_rewatch")):
            if not isinstance(entry, dict):
                continue
            add_semantic_signal(
                signals,
                entry.get("time"),
                0.76,
                ["needs_rewatch"],
                "gemini_visual",
                str(entry.get("reason")) if entry.get("reason") is not None else None,
                segment_range,
            )
    return signals


def load_semantic_manifest(path: Path) -> list[SemanticSignal]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    signals = load_gemini_visual_summary(payload)
    if signals:
        return sorted(signals, key=lambda signal: (signal.start, signal.end, -signal.score))
    return sorted(
        load_generic_semantic_manifest(payload),
        key=lambda signal: (signal.start, signal.end, -signal.score),
    )


def parse_timestamp_list(values: list[str] | None) -> list[float]:
    timestamps: list[float] = []
    for value in values or []:
        for part in value.split(","):
            stripped = part.strip()
            if stripped:
                timestamps.append(parse_timestamp(stripped))
    return timestamps


def semantic_distance(frame: FrameSample, signal: SemanticSignal) -> float:
    if signal.start <= frame.timestamp <= signal.end:
        return 0.0
    return min(abs(frame.timestamp - signal.start), abs(frame.timestamp - signal.end))


def apply_semantic_signals(
    samples: list[FrameSample],
    signals: list[SemanticSignal],
    semantic_window_seconds: float,
) -> list[FrameSample]:
    semantic_frames: list[FrameSample] = []
    if not samples or not signals:
        return semantic_frames

    for signal in signals:
        frame = min(samples, key=lambda sample_item: semantic_distance(sample_item, signal))
        if semantic_distance(frame, signal) > semantic_window_seconds:
            continue

        frame.semantic_score = max(frame.semantic_score, signal.score)
        for reason in [signal.source, *signal.reasons]:
            if reason and reason not in frame.semantic_reasons:
                frame.semantic_reasons.append(reason)
        if frame not in semantic_frames:
            semantic_frames.append(frame)
    return semantic_frames


def combined_score(frame: FrameSample, semantic_weight: float) -> float:
    return frame.score + max(0.0, semantic_weight) * frame.semantic_score


def apply_selection_limit(
    selections: list[FrameSelection],
    max_frames_per_minute: int,
    semantic_weight: float = 0.0,
) -> list[FrameSelection]:
    if max_frames_per_minute <= 0:
        return sorted(selections, key=lambda item: item.frame.timestamp)

    buckets: dict[int, list[FrameSelection]] = {}
    for selection in selections:
        buckets.setdefault(int(selection.frame.timestamp // 60), []).append(selection)

    keep: list[FrameSelection] = []
    for items in buckets.values():
        forced = [item for item in items if item.forced]
        optional = [item for item in items if not item.forced]
        slots = max(0, max_frames_per_minute - len(forced))
        ranked = sorted(
            optional,
            key=lambda item: (
                len(item.reasons),
                item.frame.semantic_score,
                combined_score(item.frame, semantic_weight),
            ),
            reverse=True,
        )
        keep.extend(forced)
        keep.extend(ranked[:slots])

    return sorted(keep, key=lambda item: item.frame.timestamp)


def fill_large_gaps(
    selections: dict[int, FrameSelection],
    samples: list[FrameSample],
    cluster_map: dict[int, int],
    max_gap_seconds: float,
) -> None:
    if max_gap_seconds <= 0 or len(samples) < 2:
        return

    while True:
        ordered = sorted(selections.values(), key=lambda item: item.frame.timestamp)
        added = False

        for previous, current in zip(ordered, ordered[1:]):
            gap = current.frame.timestamp - previous.frame.timestamp
            if gap <= max_gap_seconds:
                continue

            midpoint = previous.frame.timestamp + gap / 2.0
            candidates = [
                frame
                for frame in samples
                if previous.frame.timestamp < frame.timestamp < current.frame.timestamp
                and frame.index not in selections
            ]
            if not candidates:
                continue

            frame = min(candidates, key=lambda item: abs(item.timestamp - midpoint))
            add_selection(
                selections,
                frame,
                cluster_map.get(frame.index, 0),
                "gap_filler",
            )
            added = True
            break

        if not added:
            return


def prune_low_semantic_selections(
    selections: dict[int, FrameSelection],
    semantic_min_score: float | None,
) -> dict[int, FrameSelection]:
    if semantic_min_score is None:
        return selections
    return {
        frame_index: selection
        for frame_index, selection in selections.items()
        if selection.forced or selection.frame.semantic_score >= semantic_min_score
    }


def best_sample(samples: list[FrameSample], semantic_weight: float = 0.0) -> FrameSample:
    return max(samples, key=lambda frame: combined_score(frame, semantic_weight))


def select_frames_for_strategy(
    samples: list[FrameSample],
    clusters: list[list[FrameSample]],
    strategy: str,
    target_interval_seconds: float,
    change_threshold: float | None,
    forced_timestamps: list[float],
    max_frames_per_minute: int,
    semantic_signals: list[SemanticSignal] | None = None,
    semantic_window_seconds: float = 6.0,
    semantic_min_score: float | None = None,
    semantic_weight: float = 0.65,
) -> list[FrameSelection]:
    if strategy not in {"visual", "hybrid"}:
        raise ValueError(f"unsupported keyframe strategy: {strategy}")

    cluster_map = cluster_index_by_frame(clusters)
    selections: dict[int, FrameSelection] = {}
    semantic_frames = apply_semantic_signals(
        samples,
        semantic_signals or [],
        semantic_window_seconds,
    )

    for cluster_index, cluster in enumerate(clusters):
        add_selection(
            selections,
            best_sample(cluster, semantic_weight),
            cluster_index,
            "best_quality_in_visual_cluster",
        )

    if strategy == "hybrid":
        for frame in select_coverage_frames(samples, target_interval_seconds):
            add_selection(
                selections,
                frame,
                cluster_map.get(frame.index, 0),
                "coverage_window",
            )

        if change_threshold is not None:
            for frame in samples:
                if frame.diff_from_prev is not None and frame.diff_from_prev >= change_threshold:
                    add_selection(
                        selections,
                        frame,
                        cluster_map.get(frame.index, 0),
                        "significant_visual_change",
                    )

        for timestamp in forced_timestamps:
            frame = nearest_sample(samples, timestamp)
            if frame is not None:
                add_selection(
                    selections,
                    frame,
                    cluster_map.get(frame.index, 0),
                    "forced_timestamp",
                    forced=True,
                )

        for frame in semantic_frames:
            add_selection(
                selections,
                frame,
                cluster_map.get(frame.index, 0),
                "semantic_signal",
                forced=frame.semantic_score >= 0.9,
            )

        fill_large_gaps(
            selections,
            samples,
            cluster_map,
            target_interval_seconds,
        )

    selections = prune_low_semantic_selections(selections, semantic_min_score)
    return apply_selection_limit(
        list(selections.values()),
        max_frames_per_minute,
        semantic_weight,
    )


def timestamp_name(seconds: float) -> str:
    whole = int(seconds)
    millis = int(round((seconds - whole) * 1000))
    if millis:
        return f"shot-{whole:06d}-{millis:03d}.png"
    return f"shot-{whole:06d}.png"


def extract_frame(ffmpeg: str, video: Path, timestamp: float, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{timestamp:.3f}",
        "-i",
        str(video),
        "-frames:v",
        "1",
        str(output),
    ]
    subprocess.run(cmd, check=True)


def frame_record(frame: FrameSample) -> dict:
    return {
        "index": frame.index,
        "timestamp": round(frame.timestamp, 3),
        "score": round(frame.score, 4),
        "edge": round(frame.edge, 4),
        "entropy": round(frame.entropy, 4),
        "exposure": round(frame.exposure, 4),
        "semanticScore": round(frame.semantic_score, 4),
        "semanticReasons": frame.semantic_reasons,
        "diffFromPrev": None
        if frame.diff_from_prev is None
        else round(frame.diff_from_prev, 4),
        "diffFromAnchor": None
        if frame.diff_from_anchor is None
        else round(frame.diff_from_anchor, 4),
    }


def write_manifest(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Cluster video samples and export best keyframes.")
    parser.add_argument("video", type=Path)
    parser.add_argument("--out", type=Path, default=Path("evidence_screenshots"))
    parser.add_argument("--strategy", choices=["visual", "hybrid"], default="visual")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--diff-threshold", type=float, default=0.18)
    parser.add_argument("--anchor-diff-threshold", type=float)
    parser.add_argument("--target-interval-seconds", type=float, default=30.0)
    parser.add_argument("--change-threshold", type=float)
    parser.add_argument(
        "--force-timestamp",
        action="append",
        help="Force keep the nearest sampled frame to a timestamp. Supports seconds, MM:SS, HH:MM:SS, and comma-separated lists.",
    )
    parser.add_argument("--preview-width", type=int, default=320)
    parser.add_argument("--max-frames-per-minute", type=int, default=0)
    parser.add_argument(
        "--semantic-manifest",
        type=Path,
        help="Optional OCR/LLM semantic manifest. Supports Gemini visual summaries or generic timestamped score lists.",
    )
    parser.add_argument("--semantic-window-seconds", type=float, default=8.0)
    parser.add_argument(
        "--semantic-min-score",
        type=float,
        help="When set, drop non-forced selected frames below this semantic score.",
    )
    parser.add_argument("--semantic-weight", type=float, default=0.65)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    args = parser.parse_args(argv)

    if args.interval <= 0:
        raise SystemExit("--interval must be greater than 0")
    if args.diff_threshold < 0 or args.diff_threshold > 1:
        raise SystemExit("--diff-threshold must be between 0 and 1")
    if args.target_interval_seconds < 0:
        raise SystemExit("--target-interval-seconds must be 0 or greater")
    if args.change_threshold is not None and (args.change_threshold < 0 or args.change_threshold > 1):
        raise SystemExit("--change-threshold must be between 0 and 1")
    if args.semantic_window_seconds < 0:
        raise SystemExit("--semantic-window-seconds must be 0 or greater")
    if args.semantic_min_score is not None and (args.semantic_min_score < 0 or args.semantic_min_score > 1):
        raise SystemExit("--semantic-min-score must be between 0 and 1")
    if args.semantic_weight < 0:
        raise SystemExit("--semantic-weight must be 0 or greater")

    video = args.video.expanduser().resolve()
    if not video.exists():
        raise SystemExit(f"Video does not exist: {video}")

    ffmpeg = resolve_binary("ffmpeg", args.ffmpeg)
    ffprobe = resolve_binary("ffprobe", args.ffprobe)
    anchor_threshold = (
        args.anchor_diff_threshold
        if args.anchor_diff_threshold is not None
        else min(0.45, max(args.diff_threshold, args.diff_threshold * 1.25))
    )

    samples = list(iter_samples(ffmpeg, video, args.interval, args.preview_width))
    clusters = build_clusters(samples, args.diff_threshold, anchor_threshold)
    try:
        forced_timestamps = parse_timestamp_list(args.force_timestamp)
    except ValueError as error:
        raise SystemExit(f"Invalid --force-timestamp: {error}") from error
    semantic_signals: list[SemanticSignal] = []
    semantic_manifest_path = args.semantic_manifest.expanduser().resolve() if args.semantic_manifest else None
    if semantic_manifest_path:
        if not semantic_manifest_path.exists():
            raise SystemExit(f"Semantic manifest does not exist: {semantic_manifest_path}")
        semantic_signals = load_semantic_manifest(semantic_manifest_path)
    selected_frames = select_frames_for_strategy(
        samples=samples,
        clusters=clusters,
        strategy=args.strategy,
        target_interval_seconds=args.target_interval_seconds,
        change_threshold=args.change_threshold,
        forced_timestamps=forced_timestamps,
        max_frames_per_minute=args.max_frames_per_minute,
        semantic_signals=semantic_signals,
        semantic_window_seconds=args.semantic_window_seconds,
        semantic_min_score=args.semantic_min_score,
        semantic_weight=args.semantic_weight,
    )

    out_dir = args.out.expanduser().resolve()
    selected_records = []
    for selection in selected_frames:
        frame = selection.frame
        output_path = out_dir / timestamp_name(frame.timestamp)
        if not args.dry_run:
            extract_frame(ffmpeg, video, frame.timestamp, output_path)
        selected_records.append(
            {
                **frame_record(frame),
                "clusterIndex": selection.cluster_index,
                "path": str(output_path),
                "reason": selection.reasons[0],
                "reasons": selection.reasons,
                "forced": selection.forced,
            }
        )

    selected_keys = {
        (selection.cluster_index, selection.frame.index)
        for selection in selected_frames
    }
    cluster_records = []
    for cluster_index, cluster in enumerate(clusters):
        best = best_sample(cluster, args.semantic_weight)
        cluster_records.append(
            {
                "index": cluster_index,
                "start": round(cluster[0].timestamp, 3),
                "end": round(cluster[-1].timestamp, 3),
                "sampleCount": len(cluster),
                "selectedIndex": best.index,
                "selectedTimestamp": round(best.timestamp, 3),
                "selected": any(key[0] == cluster_index for key in selected_keys),
                "representativeSelected": (cluster_index, best.index) in selected_keys,
                "alternates": [frame_record(frame) for frame in cluster],
            }
        )

    if args.strategy == "visual":
        algorithm = "sample_frames_cluster_similar_consecutive_frames_choose_best_quality"
    elif semantic_manifest_path:
        algorithm = "hybrid_visual_cluster_plus_timeline_coverage_and_semantic_scoring"
    else:
        algorithm = "hybrid_visual_cluster_plus_timeline_coverage_and_forced_timestamps"

    payload = {
        "video": str(video),
        "duration": probe_duration(ffprobe, video),
        "algorithm": algorithm,
        "strategy": args.strategy,
        "intervalSeconds": args.interval,
        "diffThreshold": args.diff_threshold,
        "anchorDiffThreshold": anchor_threshold,
        "targetIntervalSeconds": args.target_interval_seconds,
        "changeThreshold": args.change_threshold,
        "forcedTimestamps": forced_timestamps,
        "semanticManifest": str(semantic_manifest_path) if semantic_manifest_path else None,
        "semanticSignalCount": len(semantic_signals),
        "semanticWindowSeconds": args.semantic_window_seconds,
        "semanticMinScore": args.semantic_min_score,
        "semanticWeight": args.semantic_weight,
        "maxFramesPerMinute": args.max_frames_per_minute,
        "previewWidth": args.preview_width,
        "sampleCount": len(samples),
        "clusterCount": len(clusters),
        "selectedCount": len(selected_records),
        "selected": selected_records,
        "clusters": cluster_records,
        "notes": [
            "diffThreshold groups similar frames; it is not a deletion rule.",
            "The selected frame is the best visual-quality sample unless semantic scores are provided.",
            "The hybrid strategy adds timeline coverage, optional forced timestamps, and optional OCR/LLM semantic scoring through --semantic-manifest.",
            "Semantic scoring is evidence metadata only; OCR or a vision model still runs outside this selector.",
        ],
    }

    if args.manifest:
        write_manifest(args.manifest.expanduser().resolve(), payload)

    print(
        json.dumps(
            {
                "video": str(video),
                "sampleCount": len(samples),
                "clusterCount": len(clusters),
                "selectedCount": len(selected_records),
                "semanticSignalCount": len(semantic_signals),
                "maxFramesPerMinute": args.max_frames_per_minute,
                "out": str(out_dir),
                "manifest": str(args.manifest.expanduser().resolve()) if args.manifest else None,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
