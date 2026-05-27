#!/usr/bin/env python3
"""Fetch Bilibili video comments and apply rule-based curation.

Standalone script — no LLM calls. Useful when LLM quota is exhausted.

Outputs:
  <work-dir>/comments.raw.json       full raw API response (debugging / re-curate)
  <work-dir>/comments.curated.json   curated subset for compose-bundle

Curation rules (no LLM):
  - author_replies: comments where the video author (up) replied
  - pinned: top/pinned comments
  - high_likes: top main comments by like count (>= --min-likes)
  - with_author_subreply: main comments where the up replied in the sub-thread

Usage:
  python fetch_bilibili_comments.py \\
      --video-id BV12o63B5EFd \\
      --work-dir D:/.../video-poc/BV12o63B5EFd \\
      --cookie-file D:/.../bilibili.cookie.txt \\
      --main-count 30 --sub-count 20

Re-run safe (idempotent overwrite). Respect --delay-ms to avoid 412 throttling.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Bilibili API works directly from China — bypass any HTTP_PROXY/HTTPS_PROXY env
# vars (e.g. Clash) which can throttle long-lived connections or get 412'd.
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_get_json(url: str, headers: dict[str, str], timeout: int = 30) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=headers)
    with _NO_PROXY_OPENER.open(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body)


def fetch_video_info(bvid: str, cookie: str) -> dict[str, Any]:
    """Fetch aid + owner mid via official view API. More reliable than BV->av
    algorithms which differ between old/new BV id formats (2023+)."""
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": "https://www.bilibili.com/",
        "Accept": "application/json, text/plain, */*",
    }
    if cookie:
        headers["Cookie"] = cookie
    url = "https://api.bilibili.com/x/web-interface/view?" + urllib.parse.urlencode({"bvid": bvid})
    data = http_get_json(url, headers)
    if data.get("code") != 0:
        raise RuntimeError(f"view API code={data.get('code')} msg={data.get('message')}")
    d = data.get("data") or {}
    return {
        "aid": d.get("aid"),
        "owner_mid": (d.get("owner") or {}).get("mid"),
        "owner_name": (d.get("owner") or {}).get("name"),
        "reply_count": (d.get("stat") or {}).get("reply"),
    }


def load_cookie_string(cookie_file: Path | None) -> str:
    if not cookie_file or not cookie_file.exists():
        return ""
    text = cookie_file.read_text(encoding="utf-8", errors="ignore").strip()
    if not text:
        return ""
    # If looks like a single-line cookie string (e.g. "name=value; name2=value2"), use as-is
    if "\n" not in text and "=" in text and "\t" not in text:
        return text
    # Netscape cookie format: domain<TAB>flag<TAB>path<TAB>secure<TAB>expires<TAB>name<TAB>value
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
    # Fall back: treat first non-empty line as cookie string
    for line in text.splitlines():
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            return line
    return ""


def fetch_main_comments(
    aid: int,
    sort: int,
    max_count: int,
    cookie: str,
    delay_ms: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Returns (pinned_comments, regular_main_comments)."""
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": f"https://www.bilibili.com/video/av{aid}/",
        "Accept": "application/json, text/plain, */*",
    }
    if cookie:
        headers["Cookie"] = cookie

    pinned: list[dict[str, Any]] = []
    regular: list[dict[str, Any]] = []
    page = 1
    ps = 20

    while len(regular) < max_count:
        params = {"oid": aid, "type": 1, "sort": sort, "pn": page, "ps": ps}
        url = "https://api.bilibili.com/x/v2/reply?" + urllib.parse.urlencode(params)
        try:
            data = http_get_json(url, headers)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            print(f"WARN main fetch page={page} failed: {e}", file=sys.stderr)
            break

        code = data.get("code")
        if code != 0:
            msg = data.get("message") or "no message"
            print(f"WARN main API code={code} msg={msg}", file=sys.stderr)
            break

        d = data.get("data") or {}

        # Pinned comments only show on page 1, in `top`
        if page == 1:
            top = d.get("top") or {}
            for key in ("upper", "admin", "vote"):
                v = top.get(key)
                if v:
                    pinned.append(v)

        replies = d.get("replies") or []
        if not replies:
            break

        regular.extend(replies)

        # Stop if we got fewer than a full page (last page)
        if len(replies) < ps:
            break

        page += 1
        if delay_ms > 0:
            time.sleep(delay_ms / 1000.0)

    return pinned, regular[:max_count]


def fetch_subreplies(
    aid: int,
    root_rpid: int,
    max_count: int,
    cookie: str,
    delay_ms: int,
) -> list[dict[str, Any]]:
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": f"https://www.bilibili.com/video/av{aid}/",
        "Accept": "application/json, text/plain, */*",
    }
    if cookie:
        headers["Cookie"] = cookie

    out: list[dict[str, Any]] = []
    page = 1
    ps = 10
    while len(out) < max_count:
        params = {"oid": aid, "type": 1, "root": root_rpid, "pn": page, "ps": ps}
        url = "https://api.bilibili.com/x/v2/reply/reply?" + urllib.parse.urlencode(params)
        try:
            data = http_get_json(url, headers)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            print(f"WARN sub fetch root={root_rpid} page={page} failed: {e}", file=sys.stderr)
            break
        if data.get("code") != 0:
            break
        replies = ((data.get("data") or {}).get("replies") or [])
        if not replies:
            break
        out.extend(replies)
        if len(replies) < ps:
            break
        page += 1
        if delay_ms > 0:
            time.sleep(delay_ms / 1000.0)
    return out[:max_count]


# =====================================================================
# Comment value scoring (rule-based, no LLM)
# =====================================================================
# Past curation used `like >= min_likes` only, which surfaced shallow
# "前排/沙发/666/笑哭" comments alongside genuinely useful ones. The new
# scorer combines multiple signals so high-like-but-shallow comments
# rank below low-like-but-substantive ones.

# Pure-shallow shortcuts: any comment matching these is dropped before
# scoring.
_SHALLOW_REPEAT = re.compile(r"^(.)\1{2,}$")
_ONLY_PUNCT_EMOJI = re.compile(r"^[\W\s_]+$", re.UNICODE)

# Shallow-pattern dictionary: each hit subtracts SHALLOW_PENALTY. Use
# whole-substring match (not regex) for cheap and predictable hits.
SHALLOW_PATTERNS: tuple[str, ...] = (
    # 占位/灌水
    "沙发", "前排", "打卡", "占位", "mark", "Mark", "MARK", "路过",
    "顶顶顶", "顶顶", "顶帖", "顶一下", "顶起",
    # 浅赞
    "赞了", "学习了", "收藏了", "已学习", "已收藏", "好东西", "好的", "好棒",
    # 拍马屁
    "楼主好", "楼主牛", "楼主厉害", "大佬好", "大佬牛", "大佬厉害", "大佬tql",
    "牛逼", "牛批", "牛皮", "niubi", "NB", "nb",
    # 情绪宣泄
    "卧槽", "我去", "WC",
    "笑死", "哈哈哈", "hhhh", "hhh",
    # 数字水
    "666", "6666", "66666",
    # 浮夸
    "太牛了", "太厉害了", "厉害了", "前排支持", "前排吃瓜",
    # 蹲守
    "等更新", "蹲一个", "蹲后续", "求更新", "催更",
)

# Tech / domain words that indicate substantive content. Capped at +25.
TECH_KEYWORDS: tuple[str, ...] = (
    # 复现/参考
    "复现", "参考", "提示词", "prompt", "Prompt", "PROMPT",
    "参数", "配置", "设置", "选项",
    # 版本/数据
    "版本", "v1", "v2", "v3", "v4", "v5",
    # 流程
    "教程", "工作流", "流程", "步骤", "节点",
    "代码", "效果", "结果", "案例",
    # 故障
    "问题", "错误", "报错", "修复", "解决", "失败",
    # 尝试
    "尝试", "试了", "试试", "试过", "建议", "推荐",
    # 工具
    "插件", "模型", "脚本", "工具",
    # 比较
    "对比", "区别", "为什么", "怎么", "如何",
    # 解释
    "原理", "解释", "说明", "演示", "讲解",
    # 实证
    "实测", "我做了", "我试", "已经",
)

_NUMBER_WITH_UNIT = re.compile(
    r"\d+\s*(分钟|秒钟|小时|帧|版本|步|遍|轮|次|条|个|节|分|秒|时|天)"
    r"|\d+\.\d+"
)
_AT_QUESTION = re.compile(r"@\S+.*[?？]")

SHALLOW_PENALTY = -25


def is_pure_shallow(text: str) -> bool:
    """Definitely-shallow comments dropped before scoring."""
    t = text.strip()
    if len(t) < 4:
        return True
    if _SHALLOW_REPEAT.match(t):
        return True
    if _ONLY_PUNCT_EMOJI.match(t):
        return True
    return False


def score_comment_value(c: dict[str, Any]) -> tuple[int, list[str]]:
    """Return (value_score, reasons[]). Higher = more substantive.

    Returns (0, ['pure_shallow']) for trivially shallow text. Otherwise
    combines: log(like) base, length tiers, picture presence, reply
    discussion count, tech-keyword density, specific-number presence,
    @-question presence, and a SHALLOW_PATTERNS penalty.
    """
    text = (c.get("text") or "").strip()
    if is_pure_shallow(text):
        return (0, ["pure_shallow"])

    like = int(c.get("like") or 0)
    rcount = int(c.get("rcount") or 0)
    has_pics = bool(c.get("pictures"))

    score = 0
    reasons: list[str] = []

    # Compressed like base (so 100 likes don't dwarf substantive content)
    like_boost = int(math.log(like + 1) * 3)
    if like_boost > 0:
        score += like_boost
        reasons.append(f"like={like}(+{like_boost})")

    # Length tiers
    L = len(text)
    if L < 8:
        score -= 30
        reasons.append("len<8(-30)")
    elif L >= 150:
        score += 20
        reasons.append("len>=150(+20)")
    elif L >= 60:
        score += 10
        reasons.append("len>=60(+10)")

    # Pictures: very strong (user attached evidence / reproduction)
    if has_pics:
        score += 30
        reasons.append("has_pictures(+30)")

    # Reply count: drove community discussion
    if rcount >= 10:
        score += 20
        reasons.append(f"rcount={rcount}(+20)")
    elif rcount >= 5:
        score += 15
        reasons.append(f"rcount={rcount}(+15)")

    # Tech-domain keywords
    matched_tech = [w for w in TECH_KEYWORDS if w in text]
    if matched_tech:
        tech_boost = min(25, len(matched_tech) * 5)
        score += tech_boost
        # show only a few in the reason trace to keep it readable
        reasons.append(f"tech:{matched_tech[:3]}(+{tech_boost})")

    # Specific number with unit ("第5分钟" / "1.5 版本")
    if _NUMBER_WITH_UNIT.search(text):
        score += 10
        reasons.append("specific_number(+10)")

    # @-question (community follow-up signal)
    if _AT_QUESTION.search(text):
        score += 10
        reasons.append("at_question(+10)")

    # Shallow-pattern penalty
    matched_shallow = [w for w in SHALLOW_PATTERNS if w in text]
    if matched_shallow:
        score += SHALLOW_PENALTY
        reasons.append(f"shallow:{matched_shallow[:3]}({SHALLOW_PENALTY})")

    return (max(0, score), reasons)


def normalize_comment(c: dict[str, Any], anonymize: bool, video_owner_mid: int | None) -> dict[str, Any]:
    member = c.get("member") or {}
    content = c.get("content") or {}
    mid = member.get("mid")
    try:
        mid_int = int(mid) if mid is not None else None
    except (ValueError, TypeError):
        mid_int = None

    out: dict[str, Any] = {
        "rpid": c.get("rpid"),
        "text": (content.get("message") or "").strip(),
        "like": c.get("like") or 0,
        "ctime": c.get("ctime"),
        "rcount": c.get("rcount") or 0,
        "is_author": video_owner_mid is not None and mid_int == video_owner_mid,
    }

    # B站评论可以带配图（截图、复现效果等）。保留 img_src + 尺寸，让下游
    # compose-document 在「评论区精选」章节嵌入 Markdown 图片引用。
    raw_pictures = content.get("pictures")
    if isinstance(raw_pictures, list) and raw_pictures:
        pics: list[dict[str, Any]] = []
        for p in raw_pictures:
            if not isinstance(p, dict):
                continue
            src = p.get("img_src") or p.get("imgSrc")
            if not src:
                continue
            pics.append({
                "img_src": src,
                "img_width": p.get("img_width") or p.get("imgWidth"),
                "img_height": p.get("img_height") or p.get("imgHeight"),
            })
        if pics:
            out["pictures"] = pics

    if anonymize:
        # Keep mid for cross-comment correlation but drop name/avatar/sign
        out["author_mid"] = mid_int
    else:
        out["author_mid"] = mid_int
        out["author_name"] = member.get("uname")
        out["author_level"] = (member.get("level_info") or {}).get("current_level")
    return out


def is_author_reply(c: dict[str, Any], video_owner_mid: int | None) -> bool:
    if video_owner_mid is None:
        return False
    mid = (c.get("member") or {}).get("mid")
    try:
        return int(mid) == video_owner_mid
    except (ValueError, TypeError):
        return False


def curate_comments(
    pinned_main: list[dict[str, Any]],
    main_comments: list[dict[str, Any]],
    sub_by_root: dict[str, list[dict[str, Any]]],
    video_owner_mid: int | None,
    anonymize: bool,
    value_threshold: int,
) -> dict[str, Any]:
    """Curate comments using a multi-signal value score.

    `high_likes` keeps its name for backwards compatibility with the TS
    composer, but is now populated by `value_score >= value_threshold`,
    not raw like count. Author replies and "with_author_subreply" entries
    are kept regardless of score (the author engaged → inherently valuable).

    Each normalized comment carries `_value_score` and `_value_reasons`
    so downstream tools / debugging can audit why each one was kept.
    """
    norm_main = [normalize_comment(c, anonymize, video_owner_mid) for c in main_comments]
    norm_pinned = [normalize_comment(c, anonymize, video_owner_mid) for c in pinned_main]

    # Attach value scores to every normalized comment up front, including
    # pinned ones (useful for downstream filtering / agent reasoning).
    for n in norm_main + norm_pinned:
        score, reasons = score_comment_value(n)
        n["_value_score"] = score
        n["_value_reasons"] = reasons

    author_replies: list[dict[str, Any]] = []
    high_likes: list[dict[str, Any]] = []
    with_author_subreply: list[dict[str, Any]] = []
    filtered_shallow = 0
    filtered_shallow_examples: list[dict[str, Any]] = []

    for raw_c, n in zip(main_comments, norm_main):
        if n["is_author"]:
            author_replies.append(n)
        elif n["_value_score"] >= value_threshold:
            high_likes.append(n)
        else:
            filtered_shallow += 1
            # Keep a small trace of dropped comments so the user can sanity
            # check the threshold without re-reading the whole raw file.
            if len(filtered_shallow_examples) < 5:
                filtered_shallow_examples.append({
                    "rpid": n.get("rpid"),
                    "like": n.get("like"),
                    "score": n["_value_score"],
                    "reasons": n["_value_reasons"],
                    "text_preview": (n.get("text") or "")[:80],
                })

        # Sub-replies path is independent: any main comment that drew an
        # author response goes here regardless of its own value_score.
        sub_list = sub_by_root.get(str(raw_c.get("rpid"))) or []
        author_subs_raw = [s for s in sub_list if is_author_reply(s, video_owner_mid)]
        if author_subs_raw:
            author_subs = [normalize_comment(s, anonymize, video_owner_mid) for s in author_subs_raw]
            for sub in author_subs:
                sub_score, sub_reasons = score_comment_value(sub)
                sub["_value_score"] = sub_score
                sub["_value_reasons"] = sub_reasons
            with_author_subreply.append({
                "main": n,
                "author_replies": author_subs,
            })

    # Sort surviving comments by value_score desc, like count as tiebreaker
    high_likes.sort(key=lambda x: (-x["_value_score"], -x["like"]))

    return {
        "author_replies": author_replies,
        "pinned": norm_pinned,
        "high_likes": high_likes,
        "with_author_subreply": with_author_subreply,
        "_filtered_shallow_count": filtered_shallow,
        "_filtered_shallow_examples": filtered_shallow_examples,
        "_value_threshold": value_threshold,
    }


def auto_detect_owner_mid(work_dir: Path) -> int | None:
    si_path = work_dir / "source.info.json"
    if not si_path.exists():
        return None
    try:
        d = json.loads(si_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    src_meta = d.get("source_metadata") or {}
    aid = src_meta.get("authorId")
    if aid is None:
        return None
    try:
        return int(aid)
    except (ValueError, TypeError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Bilibili comments and apply rule-based curation.")
    parser.add_argument("--video-id", required=True, help="BV id, e.g. BV12o63B5EFd")
    parser.add_argument("--work-dir", required=True, help="Per-video work directory")
    parser.add_argument("--video-owner-mid", type=int, default=None, help="Video author mid (auto-detected from source.info.json if omitted)")
    parser.add_argument("--cookie-file", default=os.environ.get("BILIBILI_COOKIE_FILE"), help="Path to Bilibili cookie file (Netscape or 'name=val; ...' format)")
    parser.add_argument("--main-count", type=int, default=30, help="Number of main comments to fetch")
    parser.add_argument("--sub-count", type=int, default=20, help="Max sub-replies per main comment")
    parser.add_argument("--sort", type=int, choices=[0, 1, 2], default=2, help="0=time, 1=likes, 2=hotness")
    parser.add_argument(
        "--min-likes",
        type=int,
        default=5,
        help="(legacy, unused) replaced by --value-threshold",
    )
    parser.add_argument(
        "--value-threshold",
        type=int,
        default=20,
        help="Minimum value_score for a non-author comment to appear in "
        "high_likes. Combines like-count + content signals + shallow "
        "penalty. Default 20; raise to be stricter, lower to be loose.",
    )
    parser.add_argument("--delay-ms", type=int, default=1200, help="Delay between API calls to avoid 412")
    parser.add_argument("--no-anonymize", dest="anonymize", action="store_false", default=True, help="Keep usernames in curated output (default: anonymize)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    cookie_file = Path(args.cookie_file) if args.cookie_file else None
    cookie = load_cookie_string(cookie_file)

    # Resolve aid via official view API (not BV->av algorithm — fails on new BV ids)
    try:
        info = fetch_video_info(args.video_id, cookie)
        aid = info["aid"]
        api_owner_mid = info["owner_mid"]
        api_reply_count = info["reply_count"]
    except Exception as e:
        print(f"ERROR view API failed: {e}", file=sys.stderr)
        return 2

    if aid is None:
        print(f"ERROR view API returned no aid for {args.video_id}", file=sys.stderr)
        return 2

    # Owner mid: explicit > source.info.json > view API
    owner_mid = args.video_owner_mid or auto_detect_owner_mid(work_dir) or api_owner_mid

    plan = {
        "video_id": args.video_id,
        "aid": aid,
        "main_count": args.main_count,
        "sub_count": args.sub_count,
        "sort": args.sort,
        "has_cookie": bool(cookie),
        "video_owner_mid": owner_mid,
        "anonymize": args.anonymize,
        "platform_reply_count": api_reply_count,
    }

    if args.dry_run:
        plan_path = work_dir / "comments-plan.json"
        plan_path.write_text(json.dumps({**plan, "dry_run": True}, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"dryRun": True, "planPath": str(plan_path)}, ensure_ascii=False))
        return 0

    print(f"Fetching av{aid} (BV={args.video_id}) main comments sort={args.sort} count={args.main_count}...", flush=True)
    pinned, main_comments = fetch_main_comments(aid, args.sort, args.main_count, cookie, args.delay_ms)
    print(f"  pinned={len(pinned)}, main={len(main_comments)}", flush=True)

    sub_by_root: dict[str, list[dict[str, Any]]] = {}
    for c in main_comments:
        rcount = c.get("rcount") or 0
        if rcount <= 0:
            continue
        rpid = c.get("rpid")
        subs = fetch_subreplies(aid, rpid, args.sub_count, cookie, args.delay_ms)
        if subs:
            sub_by_root[str(rpid)] = subs

    raw = {
        "video_id": args.video_id,
        "aid": aid,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sort": args.sort,
        "main_count_requested": args.main_count,
        "video_owner_mid": owner_mid,
        "pinned_main": pinned,
        "main_comments": main_comments,
        "sub_comments": sub_by_root,
    }

    raw_path = work_dir / "comments.raw.json"
    raw_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

    curated = curate_comments(
        pinned, main_comments, sub_by_root, owner_mid,
        anonymize=args.anonymize, value_threshold=args.value_threshold,
    )
    curated["video_id"] = args.video_id
    curated["fetched_at"] = raw["fetched_at"]
    curated["video_owner_mid"] = owner_mid
    curated["stats"] = {
        "mainCommentsFetched": len(main_comments),
        "pinnedFetched": len(pinned),
        "subCommentsFetched": sum(len(v) for v in sub_by_root.values()),
        "authorReplies": len(curated["author_replies"]),
        "highLikes": len(curated["high_likes"]),
        "withAuthorSubReply": len(curated["with_author_subreply"]),
    }

    curated_path = work_dir / "comments.curated.json"
    curated_path.write_text(json.dumps(curated, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({
        "rawPath": str(raw_path),
        "curatedPath": str(curated_path),
        "stats": curated["stats"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
