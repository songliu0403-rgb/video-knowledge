#!/usr/bin/env python3
"""Fetch the logged-in user's Douyin collections + likes via f2.

Run with Python 3.11 (f2 has no Python 3.14 wheels):

    "python3.11" \
        ./skills/video-knowledge/scripts/fetch_douyin_collections.py

Outputs two JSON files under the same `_collections/` directory used by
the Bilibili side, so downstream tooling has one consistent location:

    <video_root>/_collections/douyin-collection.json   (saved/favorited)
    <video_root>/_collections/douyin-likes.json        (videos you liked)

Each item:
    {
      "aweme_id": "7641173377796902170",
      "title": "...",
      "author": {"uid": "...", "sec_uid": "...", "nickname": "..."},
      "duration_seconds": 245,
      "create_time": 1779000000,
      "stats": {"digg": 1398, "comment": 68, "share": 162, "collect": 438},
      "share_url": "https://v.douyin.com/...",
    }

Cookie comes from
    ./data/secrets/douyin.cookie.txt
(header-string format, as exported by the Cookie-Editor extension).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from f2.apps.douyin.handler import DouyinHandler


DEFAULT_COOKIE_PATH = Path(
    r"./data/secrets/douyin.cookie.txt"
)
DEFAULT_OUT_DIR = Path(
    r"./data/video-poc/_collections"
)


def build_kwargs(cookie: str, max_counts: int, page_counts: int) -> dict:
    return {
        "app_name": "douyin",
        "headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
            ),
            "Referer": "https://www.douyin.com/",
        },
        "cookie": cookie,
        "proxies": {"http://": None, "https://": None},
        "timeout": 30,
        "max_retries": 3,
        "max_connections": 5,
        "max_tasks": 1,
        "max_counts": max_counts,
        "page_counts": page_counts,
    }


def fetch_self_profile(cookie: str) -> dict[str, Any]:
    req = urllib.request.Request(
        "https://www.douyin.com/aweme/v1/web/user/profile/self/?aid=6383",
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 "
                "Safari/537.36"
            ),
            "Referer": "https://www.douyin.com/",
            "Cookie": cookie,
        },
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    user = data.get("user") or {}
    return {
        "nickname": user.get("nickname"),
        "uid": user.get("uid"),
        "sec_uid": user.get("sec_uid"),
        "unique_id": user.get("unique_id"),
        "short_id": user.get("short_id"),
        "favoriting_count": user.get("favoriting_count"),
        "total_favorited": user.get("total_favorited"),
    }


def normalize_item(d: dict[str, Any]) -> dict[str, Any]:
    """Convert one f2 batch row into our canonical schema.

    f2's list rows are stats-free; only video_duration / desc / author
    fields are populated. Use --enrich-stats to call fetch_one_video on
    each aweme_id and backfill the stats dict.
    """
    create_time_raw = d.get("create_time")
    if isinstance(create_time_raw, str):
        # f2 returns "YYYY-MM-DD HH-MM-SS"
        try:
            create_time = int(
                datetime.strptime(create_time_raw, "%Y-%m-%d %H-%M-%S")
                .replace(tzinfo=timezone.utc)
                .timestamp()
            )
        except ValueError:
            create_time = None
    elif isinstance(create_time_raw, (int, float)):
        create_time = int(create_time_raw)
    else:
        create_time = None

    desc = d.get("desc_raw") or d.get("desc") or ""
    if isinstance(desc, list):
        desc = " ".join(str(x) for x in desc)

    duration_ms = d.get("video_duration") or 0
    duration_s = round(duration_ms / 1000) if duration_ms else 0

    return {
        "aweme_id": str(d.get("aweme_id") or ""),
        "title": desc,
        "author": {
            "uid": d.get("uid"),
            "sec_uid": d.get("sec_user_id"),
            "nickname": d.get("nickname_raw") or d.get("nickname"),
        },
        "duration_seconds": duration_s,
        "create_time": create_time,
        "create_time_raw": create_time_raw,
        "stats": None,  # backfilled by enrich step when requested
        "cover_url": d.get("cover"),
    }


async def enrich_with_stats(
    handler: DouyinHandler,
    items: list[dict[str, Any]],
    label: str,
) -> None:
    """Call fetch_one_video per aweme_id and fill in the stats dict."""
    total = len(items)
    print(f"    enriching {label}: {total} items via fetch_one_video ...")
    for idx, item in enumerate(items, 1):
        aid = item["aweme_id"]
        if not aid:
            continue
        try:
            v = await handler.fetch_one_video(aid)
        except Exception as e:
            item["stats"] = {"error": f"{type(e).__name__}: {str(e)[:60]}"}
            continue
        item["stats"] = {
            "digg": getattr(v, "digg_count", None) or 0,
            "comment": getattr(v, "comment_count", None) or 0,
            "share": getattr(v, "share_count", None) or 0,
            "collect": getattr(v, "collect_count", None) or 0,
            "play": getattr(v, "play_count", None),
        }
        if idx % 25 == 0:
            print(f"      enriched {idx}/{total}")


def _iter_batch(batch: Any) -> list[dict[str, Any]]:
    """f2 filter batches are column-major (e.g. batch.aweme_id is a list of
    all ids on that page). `_to_list` returns row-major dicts, one per
    aweme."""
    rows = getattr(batch, "_to_list", lambda: None)()
    if not rows:
        return []
    return [r for r in rows if isinstance(r, dict)]


async def fetch_collection(handler: DouyinHandler, max_total: int) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    async for batch in handler.fetch_user_collection_videos(
        max_counts=max_total, page_counts=20
    ):
        for d in _iter_batch(batch):
            aid = str(d.get("aweme_id") or "")
            if not aid or aid in seen:
                continue
            seen.add(aid)
            items.append(normalize_item(d))
            if max_total and len(items) >= max_total:
                return items
    return items


async def fetch_likes(
    handler: DouyinHandler, sec_uid: str, max_total: int
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    async for batch in handler.fetch_user_like_videos(
        sec_user_id=sec_uid, max_counts=max_total, page_counts=20
    ):
        for d in _iter_batch(batch):
            aid = str(d.get("aweme_id") or "")
            if not aid or aid in seen:
                continue
            seen.add(aid)
            items.append(normalize_item(d))
            if max_total and len(items) >= max_total:
                return items
    return items


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


async def amain(args: argparse.Namespace) -> int:
    cookie_path = Path(args.cookie_file)
    if not cookie_path.exists():
        print(f"ERROR: cookie file missing: {cookie_path}", file=sys.stderr)
        return 1
    cookie = cookie_path.read_text(encoding="utf-8").strip()

    out_dir = Path(args.out_dir)

    print("[1/3] Fetching self profile ...")
    self_info = fetch_self_profile(cookie)
    print(f"    nickname={self_info['nickname']!r} sec_uid={self_info['sec_uid']}")
    print(f"    favoriting_count={self_info['favoriting_count']}")

    kwargs = build_kwargs(cookie, args.max_counts, args.page_counts)
    handler = DouyinHandler(kwargs)

    started = time.time()

    print(f"\n[2/3] Fetching saved/favorited collection (cap {args.max_counts}) ...")
    collection = await fetch_collection(handler, args.max_counts)
    print(f"    fetched {len(collection)} collection items in {time.time()-started:.1f}s")
    if args.enrich_stats and collection:
        await enrich_with_stats(handler, collection, "collection")

    coll_path = out_dir / "douyin-collection.json"
    write_json(
        coll_path,
        {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "platform": "douyin",
            "kind": "collection",
            "self": self_info,
            "total": len(collection),
            "videos": collection,
        },
    )
    print(f"    wrote {coll_path}")

    t1 = time.time()
    print(f"\n[3/3] Fetching liked videos (cap {args.max_counts}) ...")
    if not self_info.get("sec_uid"):
        print("    ERROR: no sec_uid; cannot fetch likes", file=sys.stderr)
        return 2
    likes = await fetch_likes(handler, self_info["sec_uid"], args.max_counts)
    print(f"    fetched {len(likes)} liked items in {time.time()-t1:.1f}s")
    if args.enrich_stats and likes:
        await enrich_with_stats(handler, likes, "likes")

    likes_path = out_dir / "douyin-likes.json"
    write_json(
        likes_path,
        {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "platform": "douyin",
            "kind": "likes",
            "self": self_info,
            "total": len(likes),
            "videos": likes,
        },
    )
    print(f"    wrote {likes_path}")

    print(f"\nDone. Elapsed: {time.time()-started:.1f}s. "
          f"collection={len(collection)} likes={len(likes)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cookie-file", default=str(DEFAULT_COOKIE_PATH))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument(
        "--max-counts",
        type=int,
        default=2000,
        help="Cap items per list (collection / likes). Defaults to 2000.",
    )
    parser.add_argument("--page-counts", type=int, default=20)
    parser.add_argument(
        "--enrich-stats",
        action="store_true",
        help="After listing, call fetch_one_video on each aweme to fill in "
        "stats (likes/comments/shares/collects). Adds ~3-5s per video.",
    )
    args = parser.parse_args()
    return asyncio.run(amain(args))


if __name__ == "__main__":
    sys.exit(main())
