#!/usr/bin/env python3
"""One-command pipeline for a single Douyin video.

Equivalent of `video_knowledge.py process-full <BV>` for Bilibili, adapted
for Douyin. Stages:

  1. capture (Python 3.11, f2 + direct HTTP)        — capture_douyin.py
  2. inject ingest-queue job at status="captured"    — local
  3. transcribe-local (Whisper, local)               — server
  4. analyze-visual  (Gemini 2.5 Pro)                — server, short-video
                                                       params auto-tuned
                                                       by ffprobe duration
  5. compose-bundle                                  — server
  6. compose-document                                — server
  7. verify-and-fix-reports                          — local

Usage:
    python process_douyin.py <aweme_id_or_url> \\
        --endpoint developer --model gemini-2.5-pro --language zh

The Python 3.11 capture step is spawned as a subprocess because f2 has no
Python 3.14 wheels yet. Everything after capture runs in the main
interpreter against the capability server.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Reuse the same helpers used by video_knowledge.py so cookie / capability
# server connections stay consistent.
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from video_knowledge import (  # type: ignore  # noqa: E402
    call_tool,
    compose_video_evidence_bundle,
    compose_video_evidence_document,
    response_data,
    transcribe_local_video_ingest,
    analyze_visual_video_ingest,
    verify_and_fix_reports,
    resolve_video_root,
)


PYTHON_311 = r"python3.11"
CAPTURE_SCRIPT = ROOT / "capture_douyin.py"
DEFAULT_VIDEO_ROOT = Path(r"./data/video-poc")
DEFAULT_QUEUE_PATH = DEFAULT_VIDEO_ROOT / "_queues" / "video-ingest.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def resolve_aweme_id(target: str) -> str:
    """If the target is already a 19-ish digit aweme_id, return it; otherwise
    let capture_douyin.py do the URL resolution and read the resulting
    work_dir name back."""
    if target.isdigit() and 15 <= len(target) <= 25:
        return target
    # Spawn python 3.11 with --dry-resolve? Simpler: call f2's AwemeIdFetcher
    # in a tiny subprocess. capture_douyin.py also calls it; reuse.
    code = (
        "import asyncio, sys\n"
        "from f2.apps.douyin.utils import AwemeIdFetcher\n"
        f"print(asyncio.run(AwemeIdFetcher.get_aweme_id({target!r})))\n"
    )
    result = subprocess.run(
        [PYTHON_311, "-c", code],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise SystemExit(f"failed to resolve aweme_id for {target}: {result.stderr[:200]}")
    return result.stdout.strip().splitlines()[-1].strip()


def run_capture(target: str, force: bool) -> str:
    """Spawn the Python 3.11 capture step. Returns aweme_id on success."""
    args = [PYTHON_311, str(CAPTURE_SCRIPT), target]
    if force:
        args.append("--force")
    print(f"[capture] {' '.join(args)}", flush=True)
    result = subprocess.run(args, text=True, timeout=900)
    if result.returncode != 0:
        raise SystemExit(f"capture_douyin.py exited {result.returncode}")
    return resolve_aweme_id(target)


def load_queue(queue_path: Path) -> dict[str, Any]:
    if not queue_path.exists():
        return {"version": 1, "jobs": [], "updatedAt": now_iso()}
    return json.loads(queue_path.read_text(encoding="utf-8"))


def save_queue(queue_path: Path, queue: dict[str, Any]) -> None:
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = queue_path.with_suffix(queue_path.suffix + ".tmp")
    tmp.write_text(json.dumps(queue, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(queue_path)


def upsert_queue_job(queue_path: Path, work_dir: Path, aweme_id: str) -> None:
    """Insert or update a ingest-queue job entry for this aweme_id at
    status='captured' so server-side compose stages can find it."""
    queue = load_queue(queue_path)
    jobs = queue.get("jobs") or []
    video_id = f"douyin_{aweme_id}"
    job_id = f"douyin:{aweme_id}"
    source_url = f"https://www.douyin.com/video/{aweme_id}"

    src_info = json.loads((work_dir / "source.info.json").read_text(encoding="utf-8"))
    manifest = json.loads((work_dir / "local-capture-manifest.json").read_text(encoding="utf-8"))
    src_meta = src_info.get("source_metadata") or {}

    job = {
        "jobId": job_id,
        "status": "captured",
        "platform": "douyin",
        "videoId": video_id,
        "sourceUrl": source_url,
        "title": src_info.get("platform_title"),
        "priority": "normal",
        "queuedAt": now_iso(),
        "updatedAt": now_iso(),
        "sourceMetadata": src_meta,
        "metadataOnly": False,
        "mediaEvidence": True,
        "transcriptEvidence": False,
        "visualEvidence": False,
        "contentEvidence": False,
        "preparedAt": now_iso(),
        "capturedAt": now_iso(),
        "workDir": str(work_dir),
        "sourceInfoPath": str(work_dir / "source.info.json"),
        "videoPath": manifest.get("videoPath"),
        "probePath": manifest.get("probePath"),
        "screenshotDirectory": manifest.get("screenshotDirectory"),
        "manifestPath": str(work_dir / "local-capture-manifest.json"),
    }

    # Upsert: replace if videoId matches, else append.
    found = False
    for idx, existing in enumerate(jobs):
        if existing.get("videoId") == video_id:
            # Preserve fields we don't want to clobber (e.g. transcribedAt
            # from a prior run) by merging on top of existing entry.
            merged = {**existing, **job}
            jobs[idx] = merged
            found = True
            break
    if not found:
        jobs.append(job)

    queue["jobs"] = jobs
    queue["updatedAt"] = now_iso()
    save_queue(queue_path, queue)
    print(f"[queue] upserted job for {video_id} at status=captured", flush=True)


def probe_duration_seconds(video_path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True, text=True, timeout=30, check=True,
    )
    return float(result.stdout.strip())


def short_video_params(duration_s: float) -> tuple[int, int]:
    """Return (segment_seconds, frame_interval) suited to the duration.

    Defaults match BV's behavior on 5-30 minute tutorials. Short clips
    (Douyin's 15-60s sweet spot) use tighter sampling so the model still
    gets multiple keyframes and at least one segment."""
    if duration_s < 30:
        return 30, 5
    if duration_s < 120:
        return 30, 8
    if duration_s < 360:
        return 60, 15
    return 75, 30


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", help="aweme_id, full URL, or v.douyin.com short link")
    parser.add_argument("--base-url", default="http://127.0.0.1:4317")
    parser.add_argument("--endpoint", default="developer")
    parser.add_argument("--model", default="gemini-2.5-pro")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--asr-provider", default="whisper")
    parser.add_argument("--asr-model", default="medium")
    parser.add_argument("--video-root", default=str(DEFAULT_VIDEO_ROOT))
    parser.add_argument("--queue-path", default=str(DEFAULT_QUEUE_PATH))
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--skip-capture", action="store_true",
                        help="Assume work_dir already exists; only run downstream stages.")
    parser.add_argument("--skip-verify", action="store_true",
                        help="Skip verify-and-fix-reports at the end.")
    args = parser.parse_args()

    started = time.time()

    # 1. Resolve aweme_id (decides work_dir name)
    if args.skip_capture:
        aweme_id = resolve_aweme_id(args.target)
    else:
        aweme_id = run_capture(args.target, args.force)

    video_id = f"douyin_{aweme_id}"
    work_dir = Path(args.video_root) / video_id
    video_path = work_dir / "video.mp4"
    if not video_path.exists():
        raise SystemExit(f"video.mp4 not found at {video_path}; capture failed?")

    duration_s = probe_duration_seconds(video_path)
    segment_seconds, frame_interval = short_video_params(duration_s)
    print(f"[plan] duration={duration_s:.1f}s -> segment_seconds={segment_seconds} frame_interval={frame_interval}", flush=True)

    # 2. Inject queue job so server selectLocal*Job() find this
    upsert_queue_job(Path(args.queue_path), work_dir, aweme_id)

    # 3. Transcribe (Whisper via connector config)
    print("[transcribe-local] starting...", flush=True)
    tx_resp = transcribe_local_video_ingest(
        args.base_url,
        target=video_id,
        asr_provider=args.asr_provider,
        model=args.asr_model,
        language=args.language,
    )
    if not tx_resp.get("ok", True):
        print(f"[transcribe-local] FAIL: {json.dumps(tx_resp, ensure_ascii=False)[:300]}", file=sys.stderr)
        return 2
    print(f"[transcribe-local] ok", flush=True)

    # 4. Visual analysis (Gemini, short-video-tuned)
    print("[analyze-visual] starting...", flush=True)
    av_resp = analyze_visual_video_ingest(
        args.base_url,
        target=video_id,
        endpoint=args.endpoint,
        model=args.model,
        segment_seconds=str(segment_seconds),
        frame_interval=str(frame_interval),
    )
    if not av_resp.get("ok", True):
        print(f"[analyze-visual] FAIL: {json.dumps(av_resp, ensure_ascii=False)[:300]}", file=sys.stderr)
        return 3
    print(f"[analyze-visual] ok", flush=True)

    # 5. Compose bundle
    print("[compose-bundle] starting...", flush=True)
    cb_resp = compose_video_evidence_bundle(args.base_url, target=video_id)
    cb_data = response_data(cb_resp)
    if cb_data.get("contentEvidence") is False:
        print(f"[compose-bundle] WARN: contentEvidence=false outcome={cb_data.get('outcome')}", flush=True)
    print(f"[compose-bundle] ok", flush=True)

    # 6. Compose document
    print("[compose-document] starting...", flush=True)
    cd_resp = compose_video_evidence_document(args.base_url, target=video_id)
    cd_data = response_data(cd_resp)
    print(f"[compose-document] outcome={cd_data.get('outcome')}", flush=True)

    # 7. Verify-and-fix
    if not args.skip_verify:
        print("[verify-and-fix-reports] starting...", flush=True)
        verify_and_fix_reports(
            video_root=Path(args.video_root),
            write=True,
            only_videos=[video_id],
        )
        print(f"[verify-and-fix-reports] ok", flush=True)

    print(f"\nDone. {video_id} processed in {time.time()-started:.1f}s.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
