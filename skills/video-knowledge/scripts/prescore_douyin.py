#!/usr/bin/env python3
"""Pre-ingestion scoring for Douyin collection + likes.

Schema-compatible with prescore_favorites.py output so process-by-score
can reuse the same batch runner. Reads:

    <video_root>/_collections/douyin-collection.json   (saved videos)
    <video_root>/_collections/douyin-likes.json        (liked videos)

Writes:

    <video_root>/_collections/douyin-prescored.json

Each entry:
    {
      "aweme_id": "...",
      "video_id": "douyin_<aweme_id>",
      "title": "...",
      "author": "...",
      "duration": 245,
      "source": "collection" | "likes",
      "score": 0-100,
      "tier": "high|medium|low|skip",
      "reasons": ["..."],
      "penalties": ["..."],
      "ingestStatus": "done|pending|...",  // set if work_dir exists
      "stats": {...}  // present iff source JSON had enriched stats
    }

Run with Python 3.14 (no f2 dep here):

    python prescore_douyin.py
    python prescore_douyin.py --top-n 30 --print
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_VIDEO_ROOT = Path(r"./data/video-poc")

# Technical / learning hashtags & keywords. Lowercased.
TECH_KEYWORDS = [
    "ue5", "ue4", "ue", "unreal", "niagara", "shader", "hlsl", "vfx",
    "houdini", "blender", "substance", "材质", "粒子", "特效", "渲染",
    "光照", "建模", "动画", "贴图", "技术美术", "ta",
    "python", "javascript", "typescript", "rust", "go", "c++",
    "算法", "数据结构", "leetcode", "面试", "笔试",
    "ai", "agent", "llm", "大模型", "深度学习", "机器学习", "stable diffusion", "sd",
    "提示词", "prompt", "rag", "langchain", "claude", "gpt",
    "教程", "原理", "实战", "讲解", "解析", "源码", "深度", "进阶",
    "公式", "函数", "节点", "工作流", "插件",
]
# Entertainment / non-tutorial markers. Lowercased.
ENTERTAINMENT_KEYWORDS = [
    "穿搭", "美食", "吃货", "美妆", "鬼畜", "搞笑", "整活", "名场面",
    "切片", "混剪", "搬运", "盘点", "测评开箱", "vlog",
    "舞蹈", "跳舞", "唱歌", "翻唱",
    "瓜", "吃瓜", "实锤", "辟谣",
]


def score_video(
    v: dict[str, Any],
    source: str,                       # "collection" or "likes"
    top_authors: set[str],
) -> dict[str, Any]:
    score = 50
    reasons: list[str] = []
    penalties: list[str] = []

    # 1) Source: explicit save is a stronger signal than a like
    if source == "collection":
        score += 5
        reasons.append("你主动收藏了")
    # likes: keep base

    # 2) Duration
    duration = int(v.get("duration_seconds") or 0)
    if duration == 0:
        score -= 20
        penalties.append("图文/无视频（duration=0）")
    elif duration < 15:
        score -= 20
        penalties.append(f"极短（{duration}s）")
    elif duration < 60:
        score += 2
    elif duration < 180:
        score += 10
        reasons.append(f"中等时长（{duration}s，约 1-3 分钟）")
    elif duration < 600:
        score += 15
        reasons.append(f"教程长度（{duration}s，约 3-10 分钟）")
    elif duration < 1800:
        score += 10
        reasons.append(f"长视频（{duration}s，10-30 分钟）")
    else:
        score += 5
        reasons.append(f"超长视频（{duration}s）")

    # 3) Title keywords
    title = (v.get("title") or "").lower()
    tech_hits = sum(1 for k in TECH_KEYWORDS if k.lower() in title)
    ent_hits = sum(1 for k in ENTERTAINMENT_KEYWORDS if k.lower() in title)
    if tech_hits > 0:
        score += min(15, tech_hits * 4)
        reasons.append(f"标题含技术关键词×{tech_hits}")
    if ent_hits > 0:
        score -= ent_hits * 6
        penalties.append(f"标题暗示娱乐×{ent_hits}")

    # 4) Repeat author bonus (long-term subscription signal)
    author = (v.get("author") or {}).get("nickname") or ""
    if author and author in top_authors:
        score += 5
        reasons.append(f"常关注作者：{author}")

    # 5) Stats (only if enrich was done)
    stats = v.get("stats") or {}
    if isinstance(stats, dict) and stats and "error" not in stats:
        digg = stats.get("digg") or 0
        collect = stats.get("collect") or 0
        comment = stats.get("comment") or 0
        share = stats.get("share") or 0

        if digg >= 10000:
            score += 10
            reasons.append(f"高赞（{digg}）")
        elif digg >= 1000:
            score += 5
            reasons.append(f"较高赞（{digg}）")
        elif digg < 100:
            score -= 5
            penalties.append(f"低赞（{digg}）")

        # Collect ratio is the strongest "this is worth saving" signal
        if digg > 100 and collect > 0:
            collect_ratio = collect / digg
            if collect_ratio >= 0.25:
                score += 10
                reasons.append(f"高收藏率（{collect_ratio*100:.0f}%）")
            elif collect_ratio >= 0.10:
                score += 6
                reasons.append(f"较高收藏率（{collect_ratio*100:.0f}%）")

        if comment >= 50:
            score += 5
            reasons.append(f"{comment} 条评论")
        elif comment <= 2:
            score -= 3
            penalties.append("评论极少")

        if digg > 100 and share > 0:
            share_ratio = share / digg
            if share_ratio >= 0.10:
                score += 5
                reasons.append(f"高分享率（{share_ratio*100:.0f}%）")

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


def get_top_authors(videos: list[dict[str, Any]], min_count: int = 3) -> set[str]:
    counter: Counter[str] = Counter()
    for v in videos:
        author = (v.get("author") or {}).get("nickname")
        if author:
            counter[author] += 1
    return {a for a, c in counter.items() if c >= min_count}


def discover_ingest_status(video_root: Path, video_id: str) -> str | None:
    work_dir = video_root / video_id
    if not work_dir.is_dir():
        return None
    if (work_dir / "video-report.md").exists():
        return "done"
    if (work_dir / "video.mp4").exists():
        return "captured"
    return "pending"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video-root", type=Path, default=DEFAULT_VIDEO_ROOT)
    parser.add_argument(
        "--output", type=Path,
        default=None,
        help="Defaults to <video_root>/_collections/douyin-prescored.json",
    )
    parser.add_argument("--top-n", type=int, default=0, help="Print top N after scoring")
    parser.add_argument("--print", dest="do_print", action="store_true")
    args = parser.parse_args()

    coll_dir = args.video_root / "_collections"
    coll_path = coll_dir / "douyin-collection.json"
    likes_path = coll_dir / "douyin-likes.json"
    output = args.output or (coll_dir / "douyin-prescored.json")

    if not coll_path.exists() and not likes_path.exists():
        print(
            f"ERROR: neither {coll_path} nor {likes_path} exists. "
            "Run fetch_douyin_collections.py first.",
            file=sys.stderr,
        )
        return 2

    coll = json.loads(coll_path.read_text(encoding="utf-8")) if coll_path.exists() else {"videos": []}
    likes = json.loads(likes_path.read_text(encoding="utf-8")) if likes_path.exists() else {"videos": []}

    # Cross-list author frequency: an author you both collect AND like is
    # a stronger long-term subscription signal.
    all_videos = coll.get("videos", []) + likes.get("videos", [])
    top_authors = get_top_authors(all_videos, min_count=3)
    print(f"top authors (≥3 videos across collection+likes): {len(top_authors)}")

    scored: list[dict[str, Any]] = []
    for source, payload in [("collection", coll), ("likes", likes)]:
        for v in payload.get("videos", []):
            aweme_id = str(v.get("aweme_id") or "")
            if not aweme_id:
                continue
            sc = score_video(v, source, top_authors)
            video_id = f"douyin_{aweme_id}"
            scored.append({
                "aweme_id": aweme_id,
                "video_id": video_id,
                "platform": "douyin",
                "source": source,                                 # which list it came from
                "title": v.get("title"),
                "author": (v.get("author") or {}).get("nickname"),
                "duration": v.get("duration_seconds") or 0,
                "score": sc["score"],
                "tier": sc["tier"],
                "reasons": sc["reasons"],
                "penalties": sc["penalties"],
                "ingestStatus": discover_ingest_status(args.video_root, video_id),
                "stats": v.get("stats"),
            })

    # Sort: score desc, duration asc (prefer shorter videos at the same score)
    scored.sort(key=lambda x: (-x["score"], x.get("duration") or 0))

    # Tier breakdown
    breakdown: Counter[str] = Counter(s["tier"] for s in scored)
    enriched = sum(1 for s in scored if isinstance(s.get("stats"), dict) and s["stats"] and "error" not in s["stats"])

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "platform": "douyin",
        "total": len(scored),
        "enriched_count": enriched,
        "tier_breakdown": dict(breakdown),
        "videos": scored,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(output.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(output)

    print(f"Wrote {output}")
    print(f"Total: {len(scored)} (collection {len(coll.get('videos', []))} + likes {len(likes.get('videos', []))})")
    print(f"Enriched (have stats): {enriched}")
    print(f"Tier breakdown: {dict(breakdown)}")

    if args.do_print or args.top_n:
        n = args.top_n or 20
        print(f"\n===== Top {n} =====")
        for s in scored[:n]:
            stats = s.get("stats") or {}
            digg = stats.get("digg") if isinstance(stats, dict) else None
            dur = s.get("duration") or 0
            ing = s.get("ingestStatus") or "-"
            print(f"  {s['score']:>3} [{s['tier']:<6}] ({s['source']:<10}) {s['aweme_id']:<22s} ing={ing:<8} ♡{digg or '-':>6} {dur:>4}s {(s.get('title') or '')[:60]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
