#!/usr/bin/env python3
"""Pre-ingestion scoring for Bilibili favorites.

No LLM. Uses metadata already present in
_collections/bilibili-favorites.json (title / intro / duration / folder /
author) plus, optionally, B-station's view API
(/x/web-interface/view) for stats (view_count / like / coin / favorite /
share / comment). The result is a ranked list at
_collections/videos-prescored.json that downstream batch runners use to
process the highest-value videos first while LLM quota is still available.

Usage:
    python prescore_favorites.py
    python prescore_favorites.py --enrich        # also fetch view API stats
    python prescore_favorites.py --enrich --limit 200
    python prescore_favorites.py --top-n 100 --print

Output schema (_collections/videos-prescored.json):
    {
      "generated_at": "...",
      "total": 1238,
      "videos": [
        {
          "bvid": "BV...",
          "title": "...",
          "folder": "...",
          "score": 73,
          "tier": "high|medium|low|skip",
          "reasons": ["..."],
          "ingestStatus": "done|pending|...",
          "duration": 1234,
          "stats": { "view": ..., "like": ..., "reply": ... }   // only if --enrich
        }, ...
      ]
    }
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_FAV_PATH = Path("./data/video-poc/_collections/bilibili-favorites.json")
DEFAULT_OUTPUT = Path("./data/video-poc/_collections/videos-prescored.json")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# Folder priority tiers
P1_FOLDERS = {"技术美术-材质", "HLSL", "Houdini", "特效教程", "ue", "Niagara/Shader VFX"}
P2_FOLDERS = {
    "AI", "Agent", "Notion/ob", "工具", "AI绘画", "Blender", "SD/贴图",
    "CG美术", "Live2D", "角色设计", "美感", "设计", "色彩", "动作/演出",
}
SKIP_FOLDERS = {"吃的", "鬼屎", "杂项参考", "月神", "酒馆", "呵呵", "默认收藏夹", "eo58"}

TECH_KEYWORDS = [
    "教程", "技术", "原理", "解析", "分析", "实战", "入门", "进阶", "系统",
    "完整", "tutorial", "实现", "讲解", "知识", "节点", "材质", "shader",
    "vfx", "ue", "ue5", "blender", "houdini", "stable diffusion", "HLSL",
    "光照", "渲染", "建模", "动画", "公式", "函数",
]
SHORT_FORM_KEYWORDS = [
    "切片", "剪辑", "混剪", "高光", "名场面", "搞笑", "吃瓜", "搬运", "盘点",
    "整活", "二创", "鬼畜",
]


def http_get_json(url: str, headers: dict[str, str], timeout: int = 15) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=headers)
    with _NO_PROXY.open(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body)


def fetch_view_stats(bvid: str, cookie: str) -> dict[str, Any] | None:
    headers = {
        "User-Agent": UA,
        "Referer": "https://www.bilibili.com/",
        "Accept": "application/json, text/plain, */*",
    }
    if cookie:
        headers["Cookie"] = cookie
    url = "https://api.bilibili.com/x/web-interface/view?" + urllib.parse.urlencode({"bvid": bvid})
    try:
        data = http_get_json(url, headers)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
        return None
    if data.get("code") != 0:
        return None
    d = data.get("data") or {}
    stat = d.get("stat") or {}
    return {
        "view": stat.get("view") or 0,
        "danmaku": stat.get("danmaku") or 0,
        "reply": stat.get("reply") or 0,
        "favorite": stat.get("favorite") or 0,
        "coin": stat.get("coin") or 0,
        "share": stat.get("share") or 0,
        "like": stat.get("like") or 0,
    }


def load_cookie(p: Path | None) -> str:
    if not p or not p.exists():
        return ""
    text = p.read_text(encoding="utf-8", errors="ignore").strip()
    if "\n" not in text and "=" in text and "\t" not in text:
        return text
    parts: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) >= 7 and cols[5] and cols[6]:
            parts.append(f"{cols[5]}={cols[6]}")
    if parts:
        return "; ".join(parts)
    return ""


def score_video(v: dict[str, Any], stats: dict[str, Any] | None = None) -> dict[str, Any]:
    """Score one favorite record (with optional view-API stats)."""
    score = 50
    reasons: list[str] = []
    penalties: list[str] = []

    # ---- duration ----
    duration = int(v.get("duration") or 0)
    if duration < 30:
        score -= 25
        penalties.append(f"极短视频（{duration}秒）")
    elif duration < 90:
        score -= 10
        penalties.append(f"短视频（{duration}秒，可能仅是片段）")
    elif 90 <= duration <= 300:
        score += 4
    elif 300 < duration <= 1800:
        score += 12
        reasons.append("时长充实（5-30 分钟）")
    elif 1800 < duration <= 3600:
        score += 8
    elif duration > 3600:
        score -= 3

    # ---- intro / description ----
    intro = (v.get("intro") or "").strip()
    if intro:
        url_count = len(re.findall(r"https?://", intro))
        if url_count > 0:
            score += min(15, 5 + url_count * 4)
            reasons.append(f"简介含 {url_count} 个链接（资源/网盘候选）")
        elif len(intro) > 100:
            score += 5
            reasons.append("简介较详细")
        elif len(intro) > 30:
            score += 2

    # ---- title keywords ----
    title = (v.get("title") or "").lower()
    matched_tech = sum(1 for k in TECH_KEYWORDS if k.lower() in title)
    matched_short = sum(1 for k in SHORT_FORM_KEYWORDS if k.lower() in title)
    if matched_tech > 0:
        score += min(12, matched_tech * 5)
        reasons.append(f"标题含教程关键词×{matched_tech}")
    if matched_short > 0:
        score -= matched_short * 5
        penalties.append(f"标题暗示娱乐/混剪×{matched_short}")

    # ---- folder priority ----
    folder = v.get("folderTitle") or ""
    if folder in P1_FOLDERS:
        score += 15
        reasons.append(f"P1 技术文件夹（{folder}）")
    elif folder in P2_FOLDERS:
        score += 6
        reasons.append(f"P2 文件夹（{folder}）")
    elif folder in SKIP_FOLDERS:
        score -= 18
        penalties.append(f"P3 杂项文件夹（{folder}）")

    # ---- stats (only if enriched) ----
    if stats:
        view = stats.get("view") or 0
        like = stats.get("like") or 0
        coin = stats.get("coin") or 0
        favorite = stats.get("favorite") or 0
        reply = stats.get("reply") or 0

        # Like ratio
        if view > 100:
            like_ratio = like / view
            if like_ratio >= 0.08:
                score += 10
                reasons.append(f"点赞率高（{like_ratio*100:.1f}%）")
            elif like_ratio >= 0.05:
                score += 6
                reasons.append(f"点赞率较高（{like_ratio*100:.1f}%）")
            elif like_ratio >= 0.02:
                score += 2

        # Coin ratio (硬币是更强的认可信号)
        if view > 100 and coin > 0:
            coin_ratio = coin / view
            if coin_ratio >= 0.03:
                score += 8
                reasons.append(f"硬币率高（{coin_ratio*100:.1f}%）")

        # Comment count (multi-talker signal)
        if reply >= 50:
            score += 6
            reasons.append(f"{reply} 条评论（社区活跃）")
        elif reply >= 10:
            score += 3
        elif reply <= 2:
            score -= 3
            penalties.append("评论极少")

        # Favorite count
        if favorite >= 500:
            score += 5
            reasons.append(f"{favorite} 人收藏")
        elif favorite >= 100:
            score += 2

    score = max(0, min(100, score))

    if score >= 70:
        tier = "high"
    elif score >= 50:
        tier = "medium"
    elif score >= 30:
        tier = "low"
    else:
        tier = "skip"

    return {
        "score": score,
        "tier": tier,
        "reasons": reasons,
        "penalties": penalties,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-ingestion scoring for Bilibili favorites.")
    parser.add_argument("--favorites", type=Path, default=DEFAULT_FAV_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--enrich", action="store_true", help="Fetch view-API stats (slow but more accurate; ~30 min for 1200 videos)")
    parser.add_argument("--cookie-file", default="./data/secrets/bilibili.cookie.txt")
    parser.add_argument("--delay-ms", type=int, default=1500, help="Delay between view-API calls during enrich")
    parser.add_argument("--limit", type=int, default=0, help="Only enrich top-N candidates by lite-score (0=all)")
    parser.add_argument("--skip-done", action="store_true", default=True, help="Skip videos that already have ingestStatus=done")
    parser.add_argument("--include-done", dest="skip_done", action="store_false")
    parser.add_argument("--top-n", type=int, default=0, help="Print top N after scoring")
    parser.add_argument("--print", dest="do_print", action="store_true")
    args = parser.parse_args()

    if not args.favorites.exists():
        print(f"ERROR: favorites file not found: {args.favorites}", file=sys.stderr)
        return 2

    fav = json.loads(args.favorites.read_text(encoding="utf-8"))
    videos = fav.get("videos") or []
    print(f"Loaded {len(videos)} favorite videos")

    # Lite scoring pass
    scored: list[dict[str, Any]] = []
    for v in videos:
        if args.skip_done and (v.get("ingestStatus") == "done" or v.get("processingStatus") == "documented"):
            continue
        sc = score_video(v)
        scored.append({
            "bvid": v.get("bvid"),
            "title": v.get("title"),
            "folder": v.get("folderTitle"),
            "author": v.get("author"),
            "duration": v.get("duration"),
            "ingestStatus": v.get("ingestStatus"),
            "score": sc["score"],
            "tier": sc["tier"],
            "reasons": sc["reasons"],
            "penalties": sc["penalties"],
        })

    scored.sort(key=lambda x: (-x["score"], x.get("duration") or 0))

    # Optional enrich pass (view API)
    if args.enrich:
        cookie = load_cookie(Path(args.cookie_file) if args.cookie_file else None)
        targets = scored if args.limit <= 0 else scored[: args.limit]
        print(f"Enrich {len(targets)} videos via view API (delay {args.delay_ms}ms)...", flush=True)
        for i, item in enumerate(targets, 1):
            if i % 50 == 0:
                print(f"  enriching {i}/{len(targets)}", flush=True)
            stats = fetch_view_stats(item["bvid"], cookie)
            if stats:
                item["stats"] = stats
                # Re-score with stats
                # Need source v for re-score; reconstruct from item fields
                src_v = {
                    "duration": item.get("duration"),
                    "intro": "",  # not available again; lite has handled it
                    "title": item.get("title"),
                    "folderTitle": item.get("folder"),
                }
                # Find original record for intro
                for v in videos:
                    if v.get("bvid") == item["bvid"]:
                        src_v["intro"] = v.get("intro") or ""
                        break
                sc = score_video(src_v, stats)
                item["score"] = sc["score"]
                item["tier"] = sc["tier"]
                item["reasons"] = sc["reasons"]
                item["penalties"] = sc["penalties"]
            time.sleep(args.delay_ms / 1000.0)
        scored.sort(key=lambda x: (-x["score"], x.get("duration") or 0))

    # Write output
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "enriched": args.enrich,
        "total": len(scored),
        "tier_breakdown": {
            t: sum(1 for v in scored if v["tier"] == t) for t in ("high", "medium", "low", "skip")
        },
        "videos": scored,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {args.output}")
    print(f"Tier breakdown: {payload['tier_breakdown']}")

    if args.do_print or args.top_n > 0:
        n = args.top_n if args.top_n > 0 else 20
        print()
        print(f"===== Top {n} candidates =====")
        for v in scored[:n]:
            print(f"  {v['score']:>3} [{v['tier']:<6}] {v['bvid']} ({v.get('folder')}, {v.get('duration')}s) {v['title'][:50]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
