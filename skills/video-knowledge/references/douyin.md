# Douyin Pipeline

Use this when the user asks about Douyin/抖音 favorites (收藏), likes (喜欢), single-video metadata, or wants to process Douyin videos.

## Two architectural constraints (must internalize)

- **f2 needs Python 3.11.** The Douyin client library `f2` only has wheels for Python 3.11, while the rest of the pipeline runs on Python 3.14. Every Douyin script either is Python 3.11 itself or spawns `python3.11` as a subprocess for the f2 step. Do not try to run `f2`, `fetch_douyin_collections.py`, or `capture_douyin.py` under Python 3.14 — `pip install f2` fails because `pydantic-core` has no prebuilt wheel for 3.14.
- **Chrome 127+ encrypts cookies with App-Bound Encryption.** No `DPAPI` / `AES-GCM` / `rookiepy` / `browser-cookie3` / `IElevator COM` extractor can read Douyin cookies, even when running as Administrator. The user must export cookies via a browser extension. Do not attempt VSS snapshots, decrypt scripts, or any "I'll just elevate and grab the database" path — those all fail on v20 ABE and waste user time.

## Cookie

The cookie header string lives at:

```text
./data/secrets/douyin.cookie.txt
```

Format: `name1=value1; name2=value2; ...` (HTTP Cookie header). The companion file `douyin.cookies-netscape.txt` is auto-generated for yt-dlp from the same source.

### Refresh procedure when calls start failing

1. Tell the user to install the Cookie-Editor extension in Chrome if not already installed: `https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm`
2. Have them open `https://www.douyin.com` (logged in), click the extension icon, hit the Export button at the bottom, and pick **"Header String"**.
3. The cookie is now in their clipboard. They paste it into the chat and you write it to `douyin.cookie.txt` for them.

### Cookie rules

- Never ask the user to read cookies out loud or summarize them. Just have them paste; you write the file.
- Cookies typically last 30–60 days. When f2 starts returning empty bodies or "请求被拦截", re-export.
- Treat `sessionid_ss`, `sid_tt`, `passport_assist_user`, `ttwid` as the must-have fields. If any are missing, the export was incomplete.

## Collections + likes pull

```bash
pnpm fetch:douyin
# or, with per-video stats enrichment (slow ~10s/video):
pnpm fetch:douyin -- --enrich-stats
# refresh just one list (save the ~30 min cost of the other):
pnpm fetch:douyin -- --skip-collection      # only refetch likes
pnpm fetch:douyin -- --skip-likes           # only refetch collection
```

Writes:

```text
<video-root>/_collections/douyin-collection.json   (user's saved videos)
<video-root>/_collections/douyin-likes.json        (user's liked videos)
```

Each row carries `aweme_id`, `title`, `author`, `duration_seconds`, and optional `stats` (digg/comment/share/collect/play). f2 inserts ~30s rate-limit sleeps between pages, so a 1300-item collection takes ~40 min. Without `--enrich-stats`, the `stats` field is `null` and the prescore step will skip stat-based bonuses.

### Likes count discrepancy (Douyin API limit, not a bug)

Three numbers will commonly disagree:

- **App display** (e.g. 243) — what the user sees in their phone
- **`profile.favoriting_count`** from `/aweme/v1/web/user/profile/self/` (e.g. 223) — the API's own stat field, internally inconsistent with the App
- **Actually fetched items** (e.g. 198) — what `fetch_user_like_videos` returns before `has_more=false`

This is **a Douyin platform limit**, not a script or cookie bug. The platform stops paginating before exhausting the full list — videos that are deleted, set private, or dedup-collapsed are not exposed even with a fresh cookie. The `douyin-likes.json` written by the fetcher records `expected_total` (from profile) and `shortfall` so the discrepancy is auditable.

What does NOT help:

- Re-running with a fresh cookie (same result)
- Running as admin / on a different network
- Setting a higher `--max-counts` (the cap isn't the limit)

What might help (not implemented):

- Periodic re-fetches over weeks — newly liked videos appear without losing previously fetched ones (we don't dedup across runs, but a custom merge script could)
- Browser export via Cookie-Editor + parsing the App-rendered HTML (much heavier)

Accept the shortfall as the price of doing business with Douyin.

## Value scoring

```bash
pnpm prescore:douyin
```

Reads both list files, scores each item, and writes:

```text
<video-root>/_collections/douyin-prescored.json
```

Same `score / tier / reasons / penalties` schema as Bilibili prescore. Differences:

- "collection" videos get +5 over "likes"
- image-posts (`duration_seconds=0`) take a -20 penalty
- the tech-keyword whitelist is tuned for AI/Agent/Claude/UE/Niagara/Houdini content
- a "top author" bonus fires for any creator the user has saved or liked ≥3 times across both lists

## Single-video processing

```bash
python3.11 {baseDir}/scripts/process_douyin.py <aweme_id_or_url>
```

The Douyin equivalent of `video_knowledge.py process-full <BV>`. Stages (in order):

1. `capture_douyin.py` (Python 3.11 subprocess) — resolves any `v.douyin.com/...` short link to an aweme_id, downloads the mp4, runs ffprobe, extracts 5 PNG screenshots, and writes `video.mp4`, `source.info.json`, `probe.json`, `local-capture-manifest.json` into `<video-root>/douyin_<aweme_id>/`.
2. Local: upsert a job into `_queues/video-ingest.json` at `status=captured` so the existing transcribe/visual/compose handlers find it.
3. `transcribe-local` — Whisper (`medium` model) by default, governed by connector config.
4. `analyze-visual` — Gemini (currently `gemini-2.5-pro`), with short-video params auto-tuned by ffprobe duration:
   - `<30s`:  `segment_seconds=30, frame_interval=5`
   - `<120s`: `segment_seconds=30, frame_interval=8`
   - `<360s`: `segment_seconds=60, frame_interval=15`
   - else: `75 / 30` (Bilibili defaults)
5. `compose-bundle` → `compose-document` → `verify-and-fix-reports`.

### Useful flags

- `--skip-capture` — assume `<video-root>/douyin_<aweme_id>/video.mp4` already exists; only run downstream stages.
- `--skip-verify` — skip the final verify-and-fix-reports pass (rarely useful).
- `--force` — redo capture even when video.mp4 exists.

## ID rules

- Bilibili: `BV<10-alphanumeric>` (no prefix).
- Douyin: `douyin_<aweme_id>` where `aweme_id` is a 19-digit string. The prefix is part of the canonical `videoId` — never strip it when passing to `check-video`, `get`, `answer-context`, `search`, or capability-server commands.
- A bare aweme_id (no `douyin_` prefix) is acceptable input to `process_douyin.py` but not to anything downstream.

## Rate limits / failure modes

- f2's per-page 30s sleep is intentional, do not parallelize fetches.
- HTTP 200 with empty body from `aweme/detail/` means cookie/signature mismatch — re-export cookie.
- Persistent empty responses despite a fresh cookie usually mean the account is being rate-limited; back off 1–2 hours.
- Some videos return `aweme_deleted=true` or `is_prohibited=true`; skip them silently.
- `duration_seconds=0` indicates an image-post (图文), which has no mp4 to download. `capture_douyin.py` errors out; treat that as "expected unsupported".

For batch runs see `references/batch.md`.
