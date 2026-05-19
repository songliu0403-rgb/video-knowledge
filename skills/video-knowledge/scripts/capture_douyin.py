#!/usr/bin/env python3
"""Capture a Douyin video into the same work_dir layout used by BV videos.

Generates:

    <video_root>/douyin_<aweme_id>/
        video.mp4
        probe.json                       (ffprobe -show_streams -show_format)
        source.info.json                 (BV-compatible metadata envelope)
        local-capture-manifest.json      (paths + screenshots index)
        evidence_screenshots/shot-NNN.png (5 evenly spaced PNGs)

The output is shaped so downstream stages (transcribe-local, analyze-visual,
compose-bundle, compose-document) work without any platform-specific code.

Run with Python 3.11 (f2 has no Python 3.14 wheels):

    "python3.11" \
        ./skills/video-knowledge/scripts/capture_douyin.py \
        <aweme_id_or_url> [--max-screenshots 5] [--force]

Cookie comes from
    ./data/secrets/douyin.cookie.txt
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from f2.apps.douyin.handler import DouyinHandler
from f2.apps.douyin.utils import AwemeIdFetcher


DEFAULT_COOKIE_PATH = Path(r"./data/secrets/douyin.cookie.txt")
DEFAULT_VIDEO_ROOT = Path(r"./data/video-poc")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
)


def build_kwargs(cookie: str) -> dict:
    return {
        "app_name": "douyin",
        "headers": {"User-Agent": USER_AGENT, "Referer": "https://www.douyin.com/"},
        "cookie": cookie,
        "proxies": {"http://": None, "https://": None},
        "timeout": 60,
        "max_retries": 3,
        "max_connections": 5,
        "max_tasks": 1,
        "max_counts": 1, "page_counts": 1,
    }


async def resolve_aweme_id(target: str) -> str:
    """Accept aweme_id, full URL, or v.douyin.com short link."""
    if target.isdigit() and 15 <= len(target) <= 25:
        return target
    return await AwemeIdFetcher.get_aweme_id(target)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run_ffprobe(video_path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_format", "-show_streams",
            "-of", "json", str(video_path),
        ],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def pick_video_url(video: Any) -> str | None:
    play = getattr(video, "video_play_addr", None)
    if isinstance(play, list) and play:
        return play[0]
    if isinstance(play, str) and play:
        return play
    return None


def download_to(url: str, dst: Path, cookie: str) -> int:
    dst.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Referer": "https://www.douyin.com/",
            "Cookie": cookie,
        },
    )
    total = 0
    with urllib.request.urlopen(req, timeout=120) as resp, dst.open("wb") as fh:
        while True:
            chunk = resp.read(128 * 1024)
            if not chunk:
                break
            fh.write(chunk)
            total += len(chunk)
    return total


def extract_screenshots(
    video_path: Path,
    out_dir: Path,
    duration_seconds: float,
    count: int = 5,
) -> list[Path]:
    """Pick `count` evenly spaced timestamps and save full-resolution PNGs."""
    out_dir.mkdir(parents=True, exist_ok=True)
    if duration_seconds <= 0:
        return []
    # Skip 5% from start and 5% from end to avoid black frames.
    start = duration_seconds * 0.05
    end = duration_seconds * 0.95
    if count == 1:
        timestamps = [duration_seconds / 2]
    else:
        step = (end - start) / (count - 1)
        timestamps = [start + step * i for i in range(count)]

    written: list[Path] = []
    for i, ts in enumerate(timestamps, 1):
        dst = out_dir / f"shot-{i:06d}.png"
        if dst.exists() and dst.stat().st_size > 0:
            written.append(dst)
            continue
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{ts:.3f}", "-i", str(video_path),
                "-frames:v", "1", "-vf", "scale='min(1920,iw)':-2",
                str(dst),
            ],
            check=True,
        )
        written.append(dst)
    return written


def build_source_info(aweme_id: str, video: Any, work_dir: Path) -> dict[str, Any]:
    duration_seconds = round((getattr(video, "duration", 0) or 0) / 1000)
    create_time_raw = getattr(video, "create_time", None)
    create_iso = None
    if isinstance(create_time_raw, str):
        try:
            create_iso = (
                datetime.strptime(create_time_raw, "%Y-%m-%d %H-%M-%S")
                .replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
            )
        except ValueError:
            pass

    return {
        "id": f"douyin_{aweme_id}",
        "video_id": f"douyin_{aweme_id}",
        "source_url": f"https://www.douyin.com/video/{aweme_id}",
        "webpage_url": f"https://www.douyin.com/video/{aweme_id}",
        "platform_title": getattr(video, "desc", None),
        "platform": "douyin",
        "source_metadata": {
            "aweme_id": aweme_id,
            "author": getattr(video, "nickname", None),
            "authorId": getattr(video, "uid", None),
            "authorSecUid": getattr(video, "sec_uid", None),
            "duration": duration_seconds,
            "publishedAt": create_iso,
            "cover": getattr(video, "video_cover", None),
            "musicTitle": getattr(video, "music_title", None),
            "stats": {
                "digg": getattr(video, "digg_count", None),
                "comment": getattr(video, "comment_count", None),
                "share": getattr(video, "share_count", None),
                "collect": getattr(video, "collect_count", None),
                "play": getattr(video, "play_count", None),
            },
        },
        "ingest": {
            "status": "captured",
            "jobId": f"douyin:{aweme_id}",
            "priority": "normal",
            "queuedAt": now_iso(),
            "preparedAt": now_iso(),
            "capturedAt": now_iso(),
            "queuePath": None,
        },
    }


def build_manifest(
    aweme_id: str,
    work_dir: Path,
    video_path: Path,
    probe_path: Path,
    screenshot_dir: Path,
    screenshots: list[Path],
) -> dict[str, Any]:
    return {
        "videoId": f"douyin_{aweme_id}",
        "sourceUrl": f"https://www.douyin.com/video/{aweme_id}",
        "capturedAt": now_iso(),
        "workDir": str(work_dir),
        "sourceInfoPath": str(work_dir / "source.info.json"),
        "videoPath": str(video_path),
        "probePath": str(probe_path),
        "screenshotDirectory": str(screenshot_dir),
        "screenshots": [{"path": str(p)} for p in screenshots],
    }


async def amain(args: argparse.Namespace) -> int:
    cookie = Path(args.cookie_file).read_text(encoding="utf-8").strip()
    aweme_id = await resolve_aweme_id(args.target)
    work_dir = Path(args.video_root) / f"douyin_{aweme_id}"
    video_path = work_dir / "video.mp4"

    if video_path.exists() and not args.force:
        print(f"already captured at {work_dir} (use --force to redo)")
        return 0

    print(f"[1/5] fetch metadata for aweme_id={aweme_id}")
    handler = DouyinHandler(build_kwargs(cookie))
    video = await handler.fetch_one_video(aweme_id)
    title = getattr(video, "desc", None)
    duration_ms = getattr(video, "duration", 0) or 0
    duration_s = duration_ms / 1000
    print(f"    title    : {title}")
    print(f"    duration : {duration_s:.1f}s")
    print(f"    digg     : {getattr(video, 'digg_count', None)}")

    play_url = pick_video_url(video)
    if not play_url:
        print("    ERROR: no video_play_addr; aborting", file=sys.stderr)
        return 2

    print(f"[2/5] download mp4 -> {video_path}")
    t0 = time.time()
    size = download_to(play_url, video_path, cookie)
    print(f"    {size/1024/1024:.2f} MB in {time.time()-t0:.1f}s")

    print(f"[3/5] ffprobe -> probe.json")
    probe = run_ffprobe(video_path)
    probe_path = work_dir / "probe.json"
    probe_path.write_text(json.dumps(probe, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[4/5] {args.max_screenshots} screenshots -> evidence_screenshots/")
    screenshot_dir = work_dir / "evidence_screenshots"
    screenshots = extract_screenshots(
        video_path, screenshot_dir, duration_s, count=args.max_screenshots
    )
    print(f"    wrote {len(screenshots)} screenshots")

    print(f"[5/5] write source.info.json + local-capture-manifest.json")
    src_info = build_source_info(aweme_id, video, work_dir)
    (work_dir / "source.info.json").write_text(
        json.dumps(src_info, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    manifest = build_manifest(
        aweme_id, work_dir, video_path, probe_path, screenshot_dir, screenshots
    )
    (work_dir / "local-capture-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"\ndone. work_dir={work_dir}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", help="aweme_id, full URL, or v.douyin.com short link")
    parser.add_argument("--cookie-file", default=str(DEFAULT_COOKIE_PATH))
    parser.add_argument("--video-root", default=str(DEFAULT_VIDEO_ROOT))
    parser.add_argument("--max-screenshots", type=int, default=5)
    parser.add_argument("--force", action="store_true", help="redo even if video.mp4 exists")
    args = parser.parse_args()
    return asyncio.run(amain(args))


if __name__ == "__main__":
    sys.exit(main())
