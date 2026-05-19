---
name: video-knowledge
description: Use when a user asks about Bilibili/B站 videos, B站收藏夹列表/数量, Bilibili favorites/collections, YouTube, Douyin, local videos, BV IDs, hard subtitles, ASR transcripts, keyframes, screenshots, LLM visual judgment, or wants video reports or timestamped evidence documents with images.
metadata: {"clawdbot":{"emoji":"🎞️","requires":{"bins":["python","ffmpeg"]}},"videoKnowledge":{"emoji":"🎞️","requires":{"bins":["python","ffmpeg"]}}}
---

# Video Knowledge Reports

Use this skill to turn video sources into human-facing video reports plus timestamped evidence documents with screenshots, ASR/OCR, and LLM visual judgment. Knowledge-base writing, curation, dedupe, and llmwiki import are handled by separate projects.

## Quick Start

For B站 account favorite folder names and video counts, do this first and do not use `bilibili-rag-local` or port `8000`:

```bash
python {baseDir}/scripts/video_knowledge.py check-bilibili-cookie
python {baseDir}/scripts/video_knowledge.py list-bilibili-favorite-folders
```

If `check-bilibili-cookie` reports `ok=false`, refresh the local cookie with the dedicated browser-profile flow, then retry the favorite-folder command:

```bash
python {baseDir}/scripts/video_knowledge.py refresh-bilibili-cookie --timeout 180
```

The first refresh may require the user to log into Bilibili once in the opened dedicated Chrome/Edge profile. Future refreshes should be unattended as long as that profile remains logged in.

Prefer the local helper because it verifies the local capability server and returns compact evidence:

```bash
python {baseDir}/scripts/video_knowledge.py answer-context "length 和 float3 是怎么讲的" --video-id BV1EXDMB2EGm
```

If the helper says the local server is unavailable, run:

```bash
python {baseDir}/scripts/video_knowledge.py ensure
```

Then retry the original command.

Before batch processing or any long unattended run, verify the runtime once:

```bash
python {baseDir}/scripts/video_knowledge.py check-environment --scope full --strict
```

If this returns `ok=false`, stop and return the raw JSON. Do not run `pip install`, `conda install`, `wget ffmpeg`, `sudo ln`, or any other ad-hoc dependency repair inside the video-processing run. A complete deployment must provide durable `yt-dlp`, `ffmpeg`, `ffprobe`, Python, API scripts, and configured model credentials before ingestion starts. Transient executables under temp directories such as `/tmp/ffmpeg` are not acceptable for batch runs.

When the user gives only a video URL/BV and wants it processed, run the one-shot intake command. It checks existing artifacts, auto-enqueues fresh targets, runs capture/ASR/visual analysis/document composition, and verifies the final report paths:

```bash
python {baseDir}/scripts/video_knowledge.py process-full "https://www.bilibili.com/video/BV1NcSfBhEYe/"
```

When the user asks to process all missing reports in a Bilibili favorite folder, use the safe one-by-one folder runner instead of manually chaining pipeline steps. It skips verified reports, reruns `processed_invalid_transcript` videos with `--force`, writes progress after each item, and stops on the first blocked item unless `--continue-on-error` is explicitly set:

```bash
python {baseDir}/scripts/video_knowledge.py process-folder-missing-reports "技术美术-材质" --one-by-one --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh --progress-file ./data/video-poc/_batch/技术美术-材质.progress.json
```

Only call lower-level commands when debugging a blocked step or intentionally re-running one stage.

### Two platforms, one batch runner

This skill supports **Bilibili and Douyin** sources side by side. Use `process-by-score` instead of looping `process-full` for cross-platform batches:

```bash
pnpm prescore                            # Bilibili scoring
pnpm prescore:douyin                     # Douyin scoring (reads collection + likes)
pnpm process-by-score:dry                # preview top + worst-case spend, Bilibili
pnpm process-by-score:douyin:dry         # preview Douyin
```

See the **Douyin Collections & Pipeline** and **Batch Processing** sections below for full details.

### Hard rule on batch runs

The agent must **never** start a real batch run without a user-supplied `BudgetUsd`. If the user says "跑批 / process all / run top N" without specifying a budget, do a dry-run first and ask for the budget. Real LLM spend is on a paid AI Studio account.

## Conversation Q&A (recommended use)

The processed bundle attaches a `video_value` block (score 0–100, tier high/medium/low, recommendation text, reasons, penalties) and a `signal_profile` (primary_signal: visual/audio/both, has_hard_subtitles, etc.). The answer-context endpoint surfaces both. Use them to answer the two most common user requests without re-deriving from raw evidence:

**"BV1xx 怎么样？/ 这视频值不值得看？"**

```bash
python {baseDir}/scripts/video_knowledge.py answer-context "BV1EXDMB2EGm 这个视频怎么样？" --video-id BV1EXDMB2EGm
```

Lead with `videoValue.recommendation` + `tier` + `reasons[]`. Mention `signalProfile.primary_signal` so the user knows whether it's a watch-the-video kind of video or a read-the-transcript kind. Then point to the top chapter timestamps. Never paraphrase value judgments — quote `videoValue.recommendation` verbatim.

**"推荐学 X 的视频"**

```bash
python {baseDir}/scripts/video_knowledge.py answer-context "我想学雪地材质" --query "雪地材质"
```

Search results are already sorted by `videoValue.score` descending. The response's `alternates` array (up to 5) carries `score / tier / recommendation` for each candidate. List 2–3 picks; for each give:

- `videoId` + `title` + `sourceUrl`
- The `videoValue.recommendation` line as the why-watch reason
- One concrete evidence anchor (timestamp range from `matches`) — no anchor → no claim

**Hard rules**

- Any specific assertion ("第 12 分钟讲了 X", "里面用了 Dot 节点") must cite either `matches[].evidenceRanges` or `operationNotes[].time`. Without an anchor, do not say it.
- If `videoValue` is absent, the bundle predates the value-scoring step. Say "this video was processed before the value-scoring pass, recommendation unavailable" rather than inventing one.
- Treat `safeToQuoteExactCode=false` as a hard rule: paraphrase code/OCR snippets; never paste them.

## Workflow

1. Extract a video id from the user request when possible.
   - Bilibili: use the `BV...` id from the URL.
   - YouTube/Douyin: keep the original URL as `sourceUrl` until an internal id exists.
2. Query existing processed evidence documents first.
   - Use `answer-context` for normal user questions.
   - Use `search` when exploring which videos match a query.
   - Use `get` when a specific `videoId` is known.
   - Use `check-video` when the user asks whether a report exists, whether ASR exists, or what screenshot/keyframe strategy was used.
   - For ASR questions, trust the structured `check-video.data.transcript.path` and `lineCount` fields. Do not infer transcript existence or line count from `video-evidence.md` prose.
   - For screenshot strategy questions, trust `check-video.data.keyframeSelection` and its keyframe manifest path. If a field is missing, read the returned keyframe manifest instead of substituting a different field.
   - If `check-video.data.keyframeSelection.answerFields` is present, copy those fields directly for questions asking `selectedCount`, `semantic-min-score`, `max-frames-per-minute`, `semantic-window-seconds`, or `keyframe manifest path`.
   - Do not calculate `max-frames-per-minute` from selected frame count and video duration. It means the configured selection cap, not the resulting average density.
   - Do not switch to older experimental manifests such as `semantic-tight-080-m3.manifest.json` unless that exact path is returned by the current `check-video` response.
3. For Bilibili favorites, sync the collection index before deciding what needs ingestion.
   - First run `check-bilibili-cookie`. If it returns `ok=false`, run `refresh-bilibili-cookie --timeout 180`, then retry the original favorites command.
   - `refresh-bilibili-cookie` is the only approved cookie refresh path. It uses a dedicated browser profile plus Chrome DevTools Protocol and writes the configured local cookie file.
   - Do not read, copy, or decrypt Chrome's Default-profile cookie database. Do not run DPAPI/AESGCM cookie experiments, generic browser cookie scrapers, or repeated ad-hoc PowerShell launch loops.
   - If the user only asks for favorite folder names and counts, use `list-bilibili-favorite-folders`; do not use the video list index to infer folder counts.
   - Use `sync-bilibili-favorites` to fetch folders and video URLs.
   - Processing identity is the BV id (`bilibili:BV...`), not the folder name. Favorite folders are mutable current membership only.
   - A processed video remains processed after a folder rename or move. If it is no longer in the current favorites snapshot, it appears in `list-bilibili-orphans` instead of becoming `pending`.
   - Use `list-bilibili-orphans` to review local artifacts that are not in the latest favorites snapshot. Do not delete or reprocess them unless the user explicitly asks.
   - Treat synced titles as metadata only, not content truth.
   - If the user asks for "a random/unprocessed/pending favorite video" without giving a BV id, call `list-bilibili-favorites --status pending --limit 20`, choose a concrete pending item, then `enqueue-video` it. Only ask the user for a BV id if the pending list is unavailable or empty.
4. If no item is found, do not guess from the platform title.
   - Tell the user the video has not been ingested yet.
   - If the user gave a concrete URL/BV and wants content/report/summary, run `process-full` directly. It will auto-enqueue a fresh URL/BV and resume partial jobs when possible.
   - When the user asks to continue or run the whole pipeline, prefer `process-full` over narrating individual steps.
   - Never claim that `process-next`, `capture-local`, `transcribe-local`, `analyze-visual`, `compose-bundle`, or `compose-document` completed unless the corresponding tool result is present.
   - A full pipeline is complete only when `process-full.data.outcome=processed` and `process-full.data.finalCheck.ok=true`, or a later `check-video` returns `ok=true`.
5. When answering or preparing a handoff, include evidence:
   - topic or operation note
   - timestamp range
   - transcript path or transcript snippets
   - screenshot paths when available
   - safety note when exact OCR/code quoting is unsafe
6. Do not claim this skill imported anything into a knowledge base. Its final handoff artifacts are `video-report.md`, `video-evidence.md`, `video-document-manifest.json`, and `document-assets/`.
7. For any request that asks for "报告文件/证据文件/截图目录", treat the returned artifact paths as a strict contract:
   - first run `check-video` for the exact BV/URL;
   - if `check-video.ok=true`, copy only the paths returned in `data.paths`;
   - if `check-video.ok=false`, run `process-full` for that exact URL/BV, then use `process-full.data.finalCheck.paths` or a later `check-video` response;
   - if any required step is unavailable or fails, stop and report the blocked step plus missing artifacts; do not produce a "report file" from memory, transcript-only notes, platform metadata, or a manually invented path.
8. For check-only questions, prefer compact structured answers:
   - processed status: `ok`, `status`, and the four artifact paths;
   - transcript status: `data.transcript.exists`, `path`, `lineCount`;
   - screenshot strategy: prefer `data.keyframeSelection.answerFields`; otherwise use `selectedCount`, `semanticMinScore`, `maxFramesPerMinute`, `semanticWindowSeconds`, and `manifestPath`.

## Commands

```bash
# List local video knowledge capabilities
python {baseDir}/scripts/video_knowledge.py tools

# Check local runtime prerequisites before unattended ingestion
python {baseDir}/scripts/video_knowledge.py check-environment --scope full --strict
python {baseDir}/scripts/video_knowledge.py check-environment --scope capture --strict
python {baseDir}/scripts/video_knowledge.py check-environment --scope transcribe --provider gemini --strict
python {baseDir}/scripts/video_knowledge.py check-environment --scope visual --strict

# Search processed video knowledge
python {baseDir}/scripts/video_knowledge.py search "float length" --video-id BV1EXDMB2EGm

# Get a full evidence bundle
python {baseDir}/scripts/video_knowledge.py get BV1EXDMB2EGm

# Check whether a video has processed evidence and verified report paths
# Also returns structured transcript status and keyframe strategy metadata when available.
python {baseDir}/scripts/video_knowledge.py check-video BV1EXDMB2EGm

# Return an agent-ready answer context
python {baseDir}/scripts/video_knowledge.py answer-context "这个视频里 length 和 float3 是怎么讲的？" --video-id BV1EXDMB2EGm

# Validate or refresh the local Bilibili cookie file without exposing secret values
python {baseDir}/scripts/video_knowledge.py check-bilibili-cookie
python {baseDir}/scripts/video_knowledge.py refresh-bilibili-cookie --timeout 180
python {baseDir}/scripts/video_knowledge.py refresh-bilibili-cookie --dry-run

# Backward-compatible alias for refresh-bilibili-cookie
python {baseDir}/scripts/video_knowledge.py login-bilibili --timeout 180

# Sync Bilibili favorites metadata and video URLs into the local collection index
python {baseDir}/scripts/video_knowledge.py sync-bilibili-favorites --limit 5000 --delay-ms 1200
python {baseDir}/scripts/video_knowledge.py sync-bilibili-favorites --limit 5000 --delay-ms 1500 --force-refresh

# List current Bilibili favorite folders and video counts without listing videos
python {baseDir}/scripts/video_knowledge.py list-bilibili-favorite-folders

# List or search the local Bilibili favorites index without hitting Bilibili APIs
python {baseDir}/scripts/video_knowledge.py list-bilibili-favorites --status pending --limit 20
python {baseDir}/scripts/video_knowledge.py search-bilibili-favorites "HLSL length" --status pending
python {baseDir}/scripts/video_knowledge.py list-bilibili-orphans --status processed --limit 20

# Add a selected video to the local ingestion queue
python {baseDir}/scripts/video_knowledge.py enqueue-video BV1NcSfBhEYe --priority high --reason "HLSL FlowMap"

# Prepare the next queued video work directory for the compiler pipeline
python {baseDir}/scripts/video_knowledge.py process-next
python {baseDir}/scripts/video_knowledge.py process-next BV1NcSfBhEYe

# Run the full local pipeline and verify final report artifacts before claiming completion
python {baseDir}/scripts/video_knowledge.py process-full BV1NcSfBhEYe
python {baseDir}/scripts/video_knowledge.py process-full BV1NcSfBhEYe --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh
python {baseDir}/scripts/video_knowledge.py process-full BV1NcSfBhEYe --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh --force

# Safely process a Bilibili favorite folder one video at a time.
python {baseDir}/scripts/video_knowledge.py process-folder-missing-reports "技术美术-材质" --one-by-one --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh --progress-file ./data/video-poc/_batch/技术美术-材质.progress.json

# Download/reuse local media, probe streams, and extract screenshots
python {baseDir}/scripts/video_knowledge.py capture-local BV1NcSfBhEYe --frame-interval-seconds 30 --max-frames 48

# Run local ASR, API ASR, or index existing transcript files
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --language zh
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh --chunk-seconds 300 --force
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --provider gemini --api-key-env GEMINI_API_KEY --max-chunks 1 --force

# Run visual/keyframe analysis or validate the plan first
python {baseDir}/scripts/video_knowledge.py analyze-visual BV1NcSfBhEYe --mode keyframes --endpoint vertex-express --model gemini-3.1-pro-preview
python {baseDir}/scripts/video_knowledge.py analyze-visual BV1NcSfBhEYe --dry-run --max-segments 1

# Compose transcript and visual evidence into searchable bundles
python {baseDir}/scripts/video_knowledge.py compose-bundle BV1NcSfBhEYe

# Compose a human-facing Markdown video report plus timestamped evidence document.
# By default, this auto-generates semantic-tight report screenshots when local video and visual summary are available.
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe --keyframe-preset balanced
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe --auto-keyframe-selection false

# Compose an experimental report variant from a hybrid keyframe manifest without replacing canonical report paths
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe --document-variant hybrid-keyframes --keyframe-manifest-path /path/to/hybrid-030.manifest.json

# Select representative keyframes from a video
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --out /path/to/evidence_screenshots --interval 2

# Select denser report-review candidates without adding local OCR/CV dependencies.
# This keeps visual cluster representatives, adds timeline coverage frames, and can force timestamps from ASR/visual notes.
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --strategy hybrid --interval 2 --diff-threshold 0.08 --target-interval-seconds 30 --out /path/to/keyframe-candidates --manifest /path/to/keyframe-candidates.manifest.json
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --strategy hybrid --force-timestamp 01:15,02:30,06:45 --out /path/to/keyframe-candidates

# Select report candidates with OCR/LLM semantic scoring from Gemini visual summaries or generic timestamped score manifests.
# Balanced: useful for audit/evidence reports.
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --strategy hybrid --interval 2 --diff-threshold 0.08 --target-interval-seconds 30 --semantic-manifest /path/to/keyframe-steps-summary.json --semantic-window-seconds 12 --semantic-min-score 0.55 --max-frames-per-minute 6 --out /path/to/semantic-keyframes --manifest /path/to/semantic-keyframes.manifest.json

# Tight: prefer this for reviewable study reports when the user says the image set is too loose.
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --strategy hybrid --interval 2 --diff-threshold 0.08 --target-interval-seconds 30 --semantic-manifest /path/to/keyframe-steps-summary.json --semantic-window-seconds 10 --semantic-min-score 0.80 --max-frames-per-minute 3 --out /path/to/semantic-tight-keyframes --manifest /path/to/semantic-tight-keyframes.manifest.json

# === Douyin commands (Python 3.11 required for f2; rest of pipeline uses Python 3.14) ===

# Pull the user's Douyin collection + likes lists into _collections/. Cookie must already be at secrets/douyin.cookie.txt.
pnpm fetch:douyin
pnpm fetch:douyin -- --enrich-stats         # adds per-video stats (slow, ~10s/video)

# Score Douyin candidates (Python 3.14 OK; no f2 dep here)
pnpm prescore:douyin

# Process one Douyin video end-to-end (capture + ASR + visual + bundle + document + verify)
"python" {baseDir}/scripts/process_douyin.py <aweme_id_or_url>
"python" {baseDir}/scripts/process_douyin.py 7641173377796902170 --skip-capture
"python" {baseDir}/scripts/process_douyin.py https://v.douyin.com/mQvv4NV8y6I/ --force

# === Batch pipeline (Bilibili + Douyin share the same runner) ===

pnpm process-by-score:dry                                  # Bilibili dry-run (top 20 + cost preview)
pnpm process-by-score:douyin:dry                           # Douyin dry-run
powershell -NoProfile -File scripts/process-by-score.ps1 -Platform douyin -MinScore 85 -BudgetUsd 5
powershell -NoProfile -File scripts/process-by-score.ps1 -Tier high -BudgetUsd 30 -MaxVideos 25
```

## Quality & Maintenance

After ingestion, use these read-only / dry-run-by-default commands to inspect, repair, and reclaim space. None of them call the LLM except `retry-failed-videos` (which goes through `process-full`).

```bash
# Scan all videos and list quality issues (failed ASR, low coverage, tiny reports, missing reports).
python {baseDir}/scripts/video_knowledge.py list-quality-issues
python {baseDir}/scripts/video_knowledge.py list-quality-issues --only asr_failed visual_partial

# Rebuild the _collections/processed-video-index.json from filesystem state.
# Defaults to dry-run; pass --write to overwrite with a timestamped .backup-YYYYMMDD-HHMMSS.json beside it.
python {baseDir}/scripts/video_knowledge.py rebuild-index
python {baseDir}/scripts/video_knowledge.py rebuild-index --write

# Post-process documented video-report.md files: inject a data-quality warning banner,
# neutralize unsafe inline code (`code` -> 「code」 with caveat), add chapter confidence badges,
# and patch bundle.signal_profile.primary_signal. Idempotent via HTML banner markers.
# Default dry-run; --write creates .backup-YYYYMMDD-HHMMSS files alongside the original.
python {baseDir}/scripts/video_knowledge.py verify-and-fix-reports
python {baseDir}/scripts/video_knowledge.py verify-and-fix-reports --only BV12o63B5EFd --write

# Re-run process-full on videos flagged by list-quality-issues. Stops after a streak of consecutive
# failures (default 3). Default dry-run.
python {baseDir}/scripts/video_knowledge.py retry-failed-videos --dry-run --max-videos 3
python {baseDir}/scripts/video_knowledge.py retry-failed-videos --only asr_failed --max-videos 5 \
    --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh

# Reclaim disk space by deleting raw video.mp4, audio chunks, and frame caches for documented videos.
# Keeps PNG/JSON/Markdown report artifacts. Default dry-run.
python {baseDir}/scripts/video_knowledge.py archive-processed-videos
python {baseDir}/scripts/video_knowledge.py archive-processed-videos --keep-mp4 --write
python {baseDir}/scripts/video_knowledge.py archive-processed-videos --write

# Fetch and curate Bilibili comments for ONE video. NO LLM CALLS — uses B station's
# public reply API + rule-based filtering (author replies / pinned / high likes /
# sub-thread author follow-ups). Safe even after the LLM quota expires.
# Cookie + author mid auto-detected from connector config + source.info.json.
# Outputs comments.raw.json (full) and comments.curated.json (filtered) into the work dir.
python {baseDir}/scripts/video_knowledge.py fetch-comments BV12o63B5EFd
python {baseDir}/scripts/video_knowledge.py fetch-comments BV12o63B5EFd --main-count 50 --sub-count 20 --sort 2 --min-likes 5
python {baseDir}/scripts/video_knowledge.py fetch-comments BV12o63B5EFd --no-anonymize  # keep usernames (default: anonymized to author_mid only)

# Batch fetch comments for every documented video. Top-level repo-root pnpm script.
# Use after `rebuild-index --write` so processed-video-index.json is current.
# After this finishes, run `pnpm recompose-all` to embed curated comments into
# bundle.community_signals and the report's "评论区精选" section.
# (Direct powershell bypasses pnpm's `--` separator quirk on Windows.)
powershell -NoProfile -File ./scripts/fetch-comments-all.ps1
powershell -NoProfile -File ./scripts/fetch-comments-all.ps1 -SkipExisting
powershell -NoProfile -File ./scripts/fetch-comments-all.ps1 -MainCount 50 -SubCount 30
powershell -NoProfile -File ./scripts/fetch-comments-all.ps1 -DryRun
```

Recommended unattended-loop order:

1. `process-folder-missing-reports` (with `--max-consecutive-failures 3`) processes new favorites.
2. `list-quality-issues` snapshots current state.
3. `retry-failed-videos` reruns flagged failures.
4. `verify-and-fix-reports --write` injects warning banners and neutralizes unsafe quotes.
5. `rebuild-index --write` keeps the processed-video-index aligned with filesystem state.
6. `archive-processed-videos --write` reclaims space once batches are stable.
7. `fetch-comments-all` (optional) pulls Bilibili comments and curates them for documented videos; rerun `recompose-all` afterward to embed curated comments into reports.

## Failure Recovery

When a stage errors out, report the exact error to the user and **stop**. Do not auto-retry, do not silently switch models, do not run any "repair" command without being asked. The triage matrix below gives the right first response.

### Gemini / AI Studio errors

| Error | What it means | Agent action |
|---|---|---|
| HTTP 503 "high demand" | Transient overload on the model | Retry up to 3× with 5s exponential backoff. If still failing, stop and tell the user "Gemini overloaded, try later". |
| HTTP 429 "quota exceeded" | Monthly budget or per-minute rate hit | Stop. Report quota state. Do not switch to a different model. Ask user to check the AI Studio billing page. |
| HTTP 401 / 403 | API key invalid or revoked | Stop. Report exact code. The fix is "rotate the key in `secrets/gemini-aistudio.key.txt`"; do not generate one yourself. |
| HTTP 400 "model not found" | Model deprecated or typo | Stop. Show the model name that was rejected. The fix is to update `data/connectors.json` `visionModel`; ask the user. |
| "PROHIBITED_CONTENT" / safety filter | Some Douyin clips trip Gemini's safety filters | Skip that video, mark it `visual_failed` with reason="safety_filter", continue the batch. |

### Whisper / local ASR errors

| Symptom | Likely cause | Action |
|---|---|---|
| `RuntimeError: CUDA out of memory` | GPU memory exhausted | Re-run with `--device cpu` or `--model small`. Tell the user. |
| `Failed to load audio` | Video container missing audio stream or corrupt | Mark `transcript-quality.status=failed` with that reason; do not regenerate. |
| 0 segments + duration > 30s | Legitimate BGM-only / silent video | The script already emits `status="no_speech"` — this is fine. Continue. |
| Hangs > 5× realtime | CPU is choked | Stop the run, ask the user to close heavy apps or accept `small` model. |

### Douyin / f2 errors

| Symptom | Likely cause | Action |
|---|---|---|
| `请求被拦截` or HTTP 200 with empty body | Cookie expired or signature drift | Tell the user to re-export cookie via Cookie-Editor → paste → write file. Do **not** try Chrome database decryption again. |
| `APIRetryExhaustedError` | Rate-limited or temporarily blocked | Back off 1-2 hours; reduce `--max-tasks` to 1. |
| `aweme_deleted=true` / `is_prohibited=true` | Video was taken down | Skip silently; not a failure. |
| `duration_seconds=0` from capture | Image-post (图文), not a video | `capture_douyin.py` will exit with a clear message; skip. |
| `ModuleNotFoundError: No module named 'f2'` | Script run under Python 3.14 instead of 3.11 | Use `python3.11` — f2 has no 3.14 wheels. |

### Capability server errors

| Symptom | Likely cause | Action |
|---|---|---|
| Cannot connect to `127.0.0.1:4317` | Server not running | Run `pnpm dev` in `.`. |
| `connector_unavailable` | Connector misconfigured in `data/connectors.json` | Stop; report the connector id from the error; ask the user before editing connector config. |
| `no_visual_analysis_job` from compose-bundle | The ingest queue does not have a `visual_analyzed` job for that video id | Confirm with `check-video <id>`; if visual stage really didn't run, run `analyze-visual` (or `process_douyin.py` for Douyin) first. |

### Sanity / verification failures

If `pnpm sanity` returns < 11/11, read the named check that failed and report it verbatim. Each check is independent and has a clear remediation in `scripts/sanity-check.ps1`. Do not "fix" by deleting or moving files.

### General principle

**The agent reports; the user decides.** Never silently change provider, model, connector config, secret file paths, or any input file as a "workaround". Those changes belong to the user. The only autonomous remediation allowed is: retry transient HTTP errors (503/timeout) up to 3× with backoff.

## Optional Tool Adapter

The canonical path is the local helper above, which calls the project's native `/api/execute` endpoint. If a compatible tool adapter is directly available, these capability names may also be called as tools:

- `video.knowledge.search`
- `video.knowledge.get`
- `video.knowledge.check`
- `video.environment.check`
- `bilibili.favorites.sync`
- `bilibili.favorites.folders`
- `bilibili.favorites.list`
- `bilibili.favorites.search`
- `bilibili.favorites.orphans`
- `video.ingest.enqueue`
- `video.ingest.process-next`
- `video.ingest.process-full`
- `video.ingest.capture-local`
- `video.ingest.transcribe-local`
- `video.ingest.analyze-visual`
- `video.ingest.compose-bundle`
- `video.ingest.compose-document`

Use `media:youtube-content` only for YouTube transcript fallback when the video is not yet in the local evidence store.

## Artifact Contract

This skill has a strict output contract. A completed video report exists only when `check-video` or `compose-document` returns all of these verified paths:

- `video-report.md`
- `video-evidence.md`
- `video-document-manifest.json`
- `document-assets/`

Never replace these with ad-hoc files such as `report.md`, `metadata.json`, `frames/`, date-stamped capture folders, or paths under a wiki/media library such as `F:\资源库\...`. Those belong to downstream archive or wiki skills, not this video capture/report project.

If the video file, downloader, ffmpeg, visual model, or any required tool is unavailable, the correct answer is a blocked/incomplete status. Do not write a transcript-only "final report" and do not present a screenshot directory as "待补充" while still claiming the report was generated.

## Skill Boundary

This skill includes the agent workflow, local helper, lightweight keyframe selector, and video report/evidence document generation. It stops at report/evidence files and does not write to any knowledge base.

Inside this skill:

- `ffmpeg/ffprobe` decode video and extract frames.
- Optional local `whisper` or API ASR runs transcription when transcript files do not already exist.
- `scripts/transcribe_audio_gemini.py` chunks audio and calls Gemini for timestamped transcript files when `transcribe-local --provider gemini` is used.
- `scripts/transcribe_audio_whisper.py` is the default ASR helper. It uses local `faster-whisper`, costs $0, and writes the same output shape as the Gemini helper (transcript.txt/.json/.srt + transcript-quality.json + transcript-manifest.json). It also emits `status="no_speech"` for legitimate BGM/silent videos so they don't pollute the asr_failed list.
- Gemini API keys should come from the shared visual/ASR source: `GEMINI_API_KEY` / `API_KEY`, connector `geminiApiKeyFilePath`, or a local key file outside the repository; do not paste API keys into chat.
- `scripts/analyze_visual_gemini.py` runs Gemini keyframe or clip analysis when a vision provider is configured.
- `scripts/analyze_visual_lmstudio.py` is a standby local-only visual analyzer that talks to LM Studio's OpenAI-compatible endpoint. Quality verified against Gemini 3.1 Pro is significantly lower (Qwen2.5-VL-7B identifies broad concepts but misses fine node names, software brand). Kept for offline fallback only — do not switch the connector to it without explicit user permission.
- `scripts/fetch_douyin_collections.py` (Python 3.11, f2-douyin) pulls the logged-in user's Douyin collection + likes into `_collections/douyin-collection.json` and `_collections/douyin-likes.json`.
- `scripts/capture_douyin.py` (Python 3.11, f2-douyin) downloads a single Douyin video into a BV-compatible work_dir (`douyin_<aweme_id>/`) and writes `source.info.json`, `local-capture-manifest.json`, `probe.json`, and 5 evidence screenshots.
- `scripts/process_douyin.py` (Python 3.14) is the Douyin equivalent of `process-full`: it spawns `capture_douyin.py`, upserts an ingest-queue job, then drives the existing transcribe/visual/compose/verify pipeline through the capability server.
- `scripts/prescore_douyin.py` (Python 3.14) scores the Douyin collection + likes for batch ordering, writing `_collections/douyin-prescored.json` in the same schema as Bilibili's `videos-prescored.json`.
- `scripts/process-by-score.ps1 -Platform douyin|bilibili` runs the prescored list through the appropriate per-video command, with a hard `-BudgetUsd` stop.
- The local capability server exposes processed evidence through `video.knowledge.*`.
- The local capability server syncs Bilibili favorites through `bilibili.favorites.sync`.
- The video compiler pipeline downloads videos, runs ASR/OCR/vision analysis, composes evidence bundles, and writes `video-report.md` for humans plus `video-evidence.md` for audit/agent handoff.
- `process-full` is the preferred tool when the user asks to run the complete pipeline. It accepts a queued item, prepared/captured/transcribed partial job, or a fresh Bilibili URL/BV; fresh targets are auto-enqueued before the pipeline continues. It calls the existing pipeline stages and returns `steps` plus `finalCheck`. Do not present success unless `finalCheck.ok=true`.
- `process-full` can resume a target video that is already `prepared`, `captured`, `transcribed`, or `visual_analyzed`; if it blocks at `capture-local`/`download` with Bilibili HTTP 412, report that a valid Bilibili login cookie is required instead of inventing report paths.
- `capture-local` passes the configured Bilibili cookie to `yt-dlp` with a temporary Netscape cookie file. The tool response may show the cookie file path, but must never expose the cookie header values.
- `compose-document` regenerates document screenshots from the local source video at the selected timestamps when `videoPath` is available, preserving original video resolution for the report/evidence documents; if extraction fails, it falls back to copied analysis/keyframe images.
- `scripts/select_keyframes.py --strategy hybrid` is a lightweight candidate selector. It adds timeline coverage and optional forced timestamps on top of visual clustering, but it does not perform OCR, CLIP retrieval, or LLM semantic scoring by itself.
- `scripts/select_keyframes.py --semantic-manifest` consumes OCR/LLM evidence that was produced elsewhere, including `analyze_visual_gemini.py` summaries. It maps timestamped semantic signals to nearby sampled frames, adds `semanticScore`/`semanticReasons`, and can prune low-value screenshots with `--semantic-min-score`.
- `compose-document` defaults to automatic semantic-tight report screenshots when no `keyframeManifestPath` is supplied and both the local video plus visual summary exist. Tight defaults are `--semantic-min-score 0.80`, `--max-frames-per-minute 3`, and `--semantic-window-seconds 10`.
- `compose-document` can be changed to `--keyframe-preset balanced`, disabled with `--auto-keyframe-selection false`, or pointed at an existing keyframe manifest through `keyframeManifestPath` plus `documentVariant`/`experimental=true`. Variant outputs use names such as `video-report.hybrid-keyframes.md` and do not replace canonical `video-report.md` / `video-evidence.md` / `video-document-manifest.json`.
- Gemini/Kimi/Claude/GPT or local vision models are optional providers for semantic visual analysis.

Hard rules on cost and batch runs:

- Real LLM spend lives on a paid AI Studio account with a monthly cap set by the user (see the user's stated budget in conversation memory). Never start `process-full`, `process_douyin.py`, or `process-by-score` in real-run mode without an explicit `BudgetUsd` from the user for that specific run.
- Dry-runs (`-DryRun` / `pnpm process-by-score:dry`) are free and unrestricted. Use them to answer "how much will it cost?" before asking the user to commit.
- If `process-full` or `process_douyin.py` fails partway through a batch, the runner already deducts a half-cost from the budget. Do not retry the same video without user confirmation — repeated failures often mean a structural problem (cookie expired, model deprecated, video deleted).
- A user request to "test one video" defaults to the single-video commands (`process-full <BV>` / `process_douyin.py <aweme_id>`), not to `process-by-score -MaxVideos 1`. The latter still requires `-BudgetUsd`.
- A request like "处理收藏夹里所有视频" is never executed open-ended. Show the dry-run candidate count and ask for budget + max count.

Outside this skill:

- deciding which evidence should become long-term knowledge
- rewriting evidence into knowledge-base pages
- deduping or merging with existing knowledge
- importing into llmwiki

The `video_knowledge.py` search/get helper can run without `ffmpeg`. The `select_keyframes.py` helper requires `ffmpeg/ffprobe`; if Hermes runs in WSL and those binaries are missing there, run the selector from the Windows project environment or install/pass WSL-visible ffmpeg binaries.

## Bilibili Favorites Sync

Use this when the user asks to read or sync their Bilibili favorites:

```bash
python {baseDir}/scripts/video_knowledge.py check-bilibili-cookie
python {baseDir}/scripts/video_knowledge.py refresh-bilibili-cookie --timeout 180
python {baseDir}/scripts/video_knowledge.py sync-bilibili-favorites --limit 5000 --delay-ms 1200
```

`refresh-bilibili-cookie` opens or reuses a dedicated local Chrome/Edge profile, reads Bilibili cookies through the browser DevTools port, writes the configured cookie header to the local secret file, and validates it with Bilibili's login status API. `sync-bilibili-favorites` then calls local capability `bilibili.favorites.sync`, which writes current favorites plus local lifecycle indexes at:

```text
<video-root>/_collections/bilibili-favorites.json
<video-root>/_collections/processed-video-index.json
<video-root>/_collections/video-catalog.json
```

Rules:

- Do not ask the user to paste cookies into chat.
- Do not use Chrome Default-profile cookie database decryption, DPAPI/AESGCM scripts, generic cookie extractors, or manual DevTools instructions unless the dedicated refresh command reports that the user must log in interactively.
- Try `refresh-bilibili-cookie` once. If it returns `refresh_failed`, `cookie_saved_but_not_logged_in`, or cannot reach DevTools, report that exact status and the `profileDir`/`cookiePath`; do not keep launching browsers in a loop.
- The Bilibili login cookie must come from local project connector config, `BILIBILI_COOKIE`, `BILIBILI_COOKIE_FILE`, or `refresh-bilibili-cookie`. The refresh command defaults to the project connector's `bilibiliCookieFilePath` when available.
- When running from WSL Hermes, `refresh-bilibili-cookie` launches the Windows browser through `powershell.exe` when available, exposes DevTools on a WSL-reachable host, and writes the Windows-visible cookie file configured by the project.
- If WSL DevTools connection still fails, return the raw JSON including `devtoolsHosts`; do not ask the user to paste cookies.
- If the tool returns `auth_required`, explain that Bilibili login is not configured locally.
- For large favorites lists, use `--delay-ms 800` to `1500` to reduce Bilibili `412` risk.
- Sync uses a local page-level resume cache by default: `<video-root>/_collections/bilibili-favorites.sync-cache.json`.
- If a sync fails halfway, retry the same command; completed cached pages are reused. Use `--force-refresh` only when deliberately refreshing stale cache from Bilibili.
- Limited syncs that stop before all known favorite videos are fetched write `bilibili-favorites.partial.json`; only complete syncs replace `bilibili-favorites.json`.
- Prefer `list-bilibili-favorites`, `search-bilibili-favorites`, and `list-bilibili-orphans` for inspection after sync; they read local indexes and do not call Bilibili.
- Prefer `list-bilibili-favorite-folders` when the user asks only for collection/folder names and video counts. It calls Bilibili live folder metadata and does not list videos.
- When presenting `list-bilibili-favorite-folders`, copy `data.presentation.markdown` when available. If you reformat manually, verify the displayed row count equals `data.count` and the displayed sum equals `data.mediaCountTotal`; do not omit low-count folders.
- `list/search` default to the official complete index. Use `--source partial` only when deliberately inspecting an incomplete test sync.
- Processing status is recomputed from local BV directories every time favorites are listed. A stale `ingestStatus` stored in old favorites JSON must not override local report/evidence files.
- A folder rename or video migration changes only `currentFavoriteFolders`; it must not reset a processed BV to pending.
- If a processed BV is missing from the current favorites snapshot, classify it as an orphan with `favoriteStatus=not_in_current_favorites` and keep its local report paths available. Possible causes include manual unfavorite, folder cleanup, source deletion/private visibility, or syncing against an incomplete snapshot.
- `list-bilibili-orphans --status processed` shows already processed local artifacts that are outside current favorites. Do not delete, re-enqueue, or reprocess them unless the user asks.
- Synced favorite titles are only metadata; do not answer content questions from them.
- Use the synced list to decide what to ingest next, then generate `video-report.md` and `video-evidence.md`.
- After `enqueue-video`, report the returned `job.status`. If it is `queued`, say it is "已加入队列/等待处理"; do not say it is "正在后台处理中" or will generate a complete summary unless you also ran the later processing capabilities or a known worker is active.

## Douyin Collections & Pipeline

Use this when the user asks about Douyin/抖音 favorites (收藏), likes (喜欢), single-video metadata, or wants to process Douyin videos.

Two architectural differences vs Bilibili that the agent must keep in mind:

- The Douyin client library `f2` only has wheels for **Python 3.11**, while the rest of the pipeline runs on Python 3.14. Every Douyin script either is Python 3.11 itself or spawns `python3.11` as a subprocess for the f2 step. Do not try to run `f2`, `fetch_douyin_collections.py`, or `capture_douyin.py` under Python 3.14 — `pip install f2` fails on Python 3.14 because `pydantic-core` has no prebuilt wheel.
- Chrome 127+ enforces **app-bound encryption** on cookies. No DPAPI/AES-GCM/`rookiepy`/`browser-cookie3`/`IElevator COM` extractor can read Douyin cookies, even when running as Administrator. The user must export cookies via a browser extension. Do not attempt VSS snapshots, decrypt scripts, or any "I'll just elevate and grab the database" path — those all fail on v20 ABE and waste user time.

### Cookie

The cookie header string lives at:

```text
./data/secrets/douyin.cookie.txt
```

Format: `name1=value1; name2=value2; ...` (HTTP Cookie header). The companion file `douyin.cookies-netscape.txt` is auto-generated for yt-dlp from the same source.

Refresh procedure when calls start failing:

1. Tell the user to install the Cookie-Editor extension in Chrome if not already installed: `https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm`
2. Have them open `https://www.douyin.com` (logged in), click the extension icon, hit the Export button at the bottom, and pick **"Header String"**.
3. The cookie is now in their clipboard. They paste it into the chat and you write it to `douyin.cookie.txt` for them.

Rules:

- Never ask the user to read cookies out loud or summarize them. Just have them paste; you write the file.
- Cookies typically last 30–60 days. When f2 starts returning empty bodies or "请求被拦截", re-export.
- Treat `sessionid_ss`, `sid_tt`, `passport_assist_user`, `ttwid` as the must-have fields. If any are missing, the export was incomplete.

### Collections + likes pull

```bash
pnpm fetch:douyin
# or, with per-video stats enrichment (slow ~10s/video):
pnpm fetch:douyin -- --enrich-stats
```

Writes:

```text
<video-root>/_collections/douyin-collection.json   (user's saved videos)
<video-root>/_collections/douyin-likes.json        (user's liked videos)
```

Each row carries `aweme_id`, `title`, `author`, `duration_seconds`, and optional `stats` (digg/comment/share/collect/play). f2 inserts ~30 s rate-limit sleeps between pages, so a 1300-item collection takes ~40 min. Without `--enrich-stats`, the `stats` field is `null` and the prescore step will skip stat-based bonuses.

### Value scoring

```bash
pnpm prescore:douyin
```

Reads both list files, scores each item, and writes:

```text
<video-root>/_collections/douyin-prescored.json
```

Same `score / tier / reasons / penalties` schema as Bilibili prescore. Differences: "collection" videos get +5 over "likes"; image-posts (`duration_seconds=0`) take a -20 penalty; the tech-keyword whitelist is tuned for AI/Agent/Claude/UE/Niagara/Houdini content; a "top author" bonus fires for any creator the user has saved or liked ≥3 times across both lists.

### Single-video processing

```bash
"python" {baseDir}/scripts/process_douyin.py <aweme_id_or_url>
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

Useful flags:

- `--skip-capture` — assume `<video-root>/douyin_<aweme_id>/video.mp4` already exists; only run downstream stages.
- `--skip-verify` — skip the final verify-and-fix-reports pass (rarely useful).
- `--force` — redo capture even when video.mp4 exists.

### ID rules

- Bilibili: `BV<10-alphanumeric>` (no prefix).
- Douyin: `douyin_<aweme_id>` where `aweme_id` is a 19-digit string. The prefix is part of the canonical `videoId` — never strip it when passing to `check-video`, `get`, `answer-context`, `search`, or capability-server commands.
- A bare aweme_id (no `douyin_` prefix) is acceptable input to `process_douyin.py` but not to anything downstream.

### Rate limits / failure modes

- f2's per-page 30 s sleep is intentional, do not parallelize fetches.
- HTTP 200 with empty body from `aweme/detail/` means cookie/signature mismatch — re-export cookie.
- Persistent empty responses despite a fresh cookie usually mean the account is being rate-limited; back off 1–2 hours.
- Some videos return `aweme_deleted=true` or `is_prohibited=true`; skip them silently.
- `duration_seconds=0` indicates an image-post (图文), which has no mp4 to download. `capture_douyin.py` errors out; treat that as "expected unsupported".

## Answer Rules

- Do not answer from title alone; titles can be misleading.
- Do not quote exact code from OCR unless `safeToQuoteExactCode` is true or a keyframe has been manually reviewed. If false, do not output fenced code blocks or line-by-line snippets copied from screenshots/visual terms; paraphrase the code's role and cite timestamps/screenshots instead.
- For screen recordings or hard-subtitle videos, trust visual evidence and operation notes over noisy ASR.
- For chatty audio, treat ASR as context and use screenshots/keyframes to confirm steps.
- If audio/video sync is suspect, prefer chunk ranges and visual timestamps over model-generated exact timestamps.
- If the user pasted the wrong URL for the topic, point out the mismatch and use the matching processed `videoId` when known.
- If the user pasted placeholder text or an invalid URL/BV id such as "随便换一个未处理BV号", "TODO", "example", or a non-`BV...` Bilibili path, do not silently choose a different pending video. Say the input is a placeholder/invalid id, then ask for a real BV/URL or offer to list pending candidates.
- For any specific BV/URL report-path request or "what does this video talk about" question, verify that exact `videoId` with `check-video`, `get`, or `answer-context` first. If the result is `not_processed`, `no_processed_video_match`, or `resource_not_found`, do not construct `video-report.md`, `video-evidence.md`, or screenshot paths by convention; say it has not been processed and offer `enqueue-video`.
- If `check-video` returns `in_progress`, the video has partial artifacts such as screenshots or ASR but no complete report/evidence document yet. Do not present a final summary. Continue the pipeline from the reported stage, or clearly label any answer as transcript-only provisional if the user explicitly asks for that.
- If `capture-local`, `transcribe-local`, `analyze-visual`, `compose-bundle`, or `compose-document` cannot run, do not compensate by creating files outside `<video-root>/<video-id>/`. Report the failed capability and the exact missing output (`video.mp4`, `video-report.md`, `video-evidence.md`, `document-assets/`, etc.).
- A transcript-only answer is allowed only when the user explicitly asks for a provisional summary. It must be labeled "临时/转录版", must not include "报告文件/证据文件/截图目录" fields, and must say which visual/report artifacts are missing.

## Keyframe Selection

When building screenshots for a new video, do not keep frames by "first similar frame wins". Use:

```text
sample frames -> cluster similar consecutive frames -> choose best frame inside each cluster -> keep novelty/boundary evidence
```

Run:

```bash
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --out /path/to/evidence_screenshots --interval 2 --manifest /path/to/keyframes.json
```

Selection rules:

- Treat `diff <= 0.30` as likely the same visual cluster, not as automatic deletion.
- Pick the highest-quality frame in each cluster, not the first frame.
- Prefer clear, stable, information-dense frames over transition frames.
- Use OCR or vision model output later to force-keep frames with new code, formulas, errors, UI states, hard subtitles, or step changes.
- For screen recordings, use stricter thresholds when small UI/code changes matter: `--diff-threshold 0.12` to `0.22`.
- Review `alternates` in the manifest when exact code or UI wiring matters.

## New Video Ingestion

This skill can orchestrate ingestion, but the heavy work belongs to the video compiler pipeline, not the skill body.

To queue a selected URL or BV id for later processing:

```bash
python {baseDir}/scripts/video_knowledge.py enqueue-video BV1NcSfBhEYe --priority high --reason "HLSL FlowMap"
```

The queue file lives at `<video-root>/_queues/video-ingest.json`. Enqueueing is idempotent by `platform:videoId`, enriches jobs from local Bilibili favorites metadata when available, and still does not mean the video has been analyzed.

To advance a queued item into a local work directory:

```bash
python {baseDir}/scripts/video_knowledge.py process-next
```

`process-next` selects the highest-priority queued job, creates `<video-root>/<video-id>/source.info.json`, and marks the job `prepared`. This is a queue/workspace preparation step only: `contentEvidence=false` means the video still needs download, ASR, keyframes, OCR/vision, and bundle generation before the agent can answer content questions.

To capture local media evidence for a prepared job:

```bash
python {baseDir}/scripts/video_knowledge.py capture-local BV1NcSfBhEYe --frame-interval-seconds 30 --max-frames 48
```

`capture-local` downloads or reuses `video.mp4`, writes `probe.json`, extracts screenshots into `evidence_screenshots/`, and writes `local-capture-manifest.json`. This creates media evidence only. `contentEvidence=false` remains true until ASR/OCR/vision analysis produces operation notes, transcripts, and report insights.

To attach speech transcript evidence for a captured job:

```bash
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --language zh
```

`transcribe-local` first indexes existing `asr/transcript.txt`, `asr/transcript.json`, and `asr/transcript.srt` if present. If no transcript exists, it can call local Whisper, or it can call Gemini API ASR:

```bash
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh --chunk-seconds 300 --force
```

The Gemini path chunks audio, writes `asr/transcript.txt`, `asr/transcript.json`, and `asr/transcript.srt`, then writes `asr/transcript-manifest.json`. Use `--max-chunks 1 --dry-run` for a cheap path/segmentation check before spending tokens. This is transcript evidence only: `contentEvidence=false` remains until OCR/vision synthesis and evidence composition are complete.

To attach visual evidence for a captured or transcribed job:

```bash
python {baseDir}/scripts/video_knowledge.py analyze-visual BV1NcSfBhEYe --mode keyframes --endpoint vertex-express --model gemini-3.1-pro-preview
```

`analyze-visual` calls `scripts/analyze_visual_gemini.py` through the local capability server. `--mode keyframes` samples frames and is cheaper; `--mode clips` sends short video clips and can read motion/hard subtitles better. Use `--dry-run --max-segments 1` first to validate ffmpeg paths and chunk planning without spending model tokens. A successful run writes `keyframe_steps/keyframe-steps-summary.json` or `hard_subtitle_steps/hard-subtitle-steps-summary.json` and marks the job `visual_analyzed`. This is still evidence extraction; final user-facing output requires the later bundle and document steps.

To compose extracted evidence into the final searchable report evidence files:

```bash
python {baseDir}/scripts/video_knowledge.py compose-bundle BV1NcSfBhEYe
```

`compose-bundle` reads visual summaries plus ASR transcript text and writes:

- `qwen-style-video-analysis-bundle.json`
- `hard-subtitle-operation-notes.safe.json`
- `video-report-insights.json`

When the composed evidence has operation notes, timeline ranges, transcript preview, screenshots, visible text, formulas, or gotchas, it marks the queue job `done` and sets `contentEvidence=true` in `source.info.json`. This bundle is an intermediate report evidence store, not knowledge-base writing.

To generate the final report and evidence document:

```bash
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe
```

`compose-document` writes:

- `video-report.md`: the human-facing video content report, organized like a reading guide with keywords, summary, chapters, screenshots, key points, and transcript excerpts.
- `video-evidence.md`: the timestamped audit/agent evidence document with visual judgment, ASR/OCR evidence, gotchas, and boundary notes.
- `video-document-manifest.json`
- `document-assets/` with timestamped screenshot assets, regenerated from the local source video at original resolution when available

The report is the default file to show the user. The evidence document is the default file to give another agent when it needs timestamped proof, screenshot links, and boundary metadata. Neither file writes content into a knowledge base.

For new URLs, use the project pipeline when available:

If no source-specific downloader is installed, tell the user the ingestion path is not yet installed for that source and ask whether to run the video compiler setup. Do not fabricate a summary before evidence exists.

Read `references/workflow.md` for the full ingestion and evidence model when implementing or extending the pipeline.

## Batch Processing (process-by-score)

When the user wants to process **many** videos at once, do **not** loop `process-full` per video manually. Use the batch runner:

```bash
pnpm process-by-score:dry                # Bilibili dry-run: top 20 + worst-case spend
pnpm process-by-score:douyin:dry         # Douyin dry-run
pnpm process-by-score                     # Bilibili real run, no budget cap, scores >= 50
pnpm process-by-score:douyin              # Douyin real run, no budget cap, scores >= 50
```

The runner reads the prescored JSON for the chosen platform, sorts by score desc + duration asc, and calls the right per-video command (`video_knowledge.py process-full` for Bilibili, `process_douyin.py` for Douyin). Re-running the same batch is safe — already-documented videos return `outcome=skipped` with $0 spend instantly.

### Mandatory budget cap (agent must enforce)

Real runs cost real money. The agent must **never** start a batch without an explicit, user-provided budget. If the user asks to "跑批 / process all / run top N" without naming a dollar figure:

1. Run dry-run first.
2. Show count of candidates + worst-case spend.
3. Ask "what's your budget for this run?".
4. Only then call with `-BudgetUsd <N>`.

```bash
powershell -NoProfile -File scripts/process-by-score.ps1 -Platform douyin -MinScore 85 -BudgetUsd 5
```

How budget cap behaves:

- Hard-stops before the next fresh video would exceed `BudgetUsd`.
- Default `-CostPerVideoUsd 0.5` is a conservative Gemini 2.5 Pro estimate for a 10-min Bilibili tutorial. Short Douyin videos are cheaper (often $0.10-0.20). Tune after the first real billing report on AI Studio.
- Skipped (already-documented) videos count $0.
- Failed videos count `CostPerVideoUsd * 0.5` toward spend because the model may have partially run before the crash.

### Filter parameters

| Flag | Default | Use |
|---|---|---|
| `-Platform bilibili\|douyin` | bilibili | Pick the source list |
| `-MinScore <N>` | 50 | Drop candidates below; use 70-95 to be selective |
| `-Tier high\|medium\|low\|skip` | any | Filter by tier label |
| `-MaxVideos <N>` | 0 (no cap) | Hard cap on number processed |
| `-MaxConsecutiveFailures <N>` | 5 | Auto-stop after N back-to-back fails |
| `-BudgetUsd <N>` | 0 (no cap) | **Required for real runs.** See above |
| `-CostPerVideoUsd <N>` | 0.5 | Per-fresh-video estimate |

### Progress tracking

`_progress/by-score-{platform}.json` is written after every video, so a crashed batch can be diagnosed without re-running. The same path is reused on rerun — earlier history is overwritten.

### Reading the batch summary

```text
===== Summary: processed=12 skipped=3 failed=1 spent=$3.85 elapsed=92.3 min =====
```

- `processed`: videos that consumed budget and now have a complete report.
- `skipped`: videos with an existing report (no LLM cost incurred).
- `failed`: pipeline errors; check `_progress/by-score-*.json` `reason` field.
- `spent`: **estimated** $$$ from `CostPerVideoUsd`, not actual billing. Cross-check against the AI Studio billing dashboard after every batch.
- If the summary ends with `(BUDGET HIT)`, more candidates remained. Either re-run with a higher budget or accept partial completion.

### Decision tree for "run a batch"

When the user says "处理 X 个" / "跑 top N" / "跑批" / "process all high tier":

1. **No count, no budget** → dry-run, show candidate count + worst-case, ask "what's your budget?".
2. **Budget only** → compute `MaxVideos = floor(BudgetUsd / 0.5)`, pass both `-BudgetUsd` and `-MaxVideos` so the user is not surprised by partial completion.
3. **Count only** → estimate spend (count × $0.5), confirm with user, then run with `-MaxVideos <count> -BudgetUsd <count*0.5*1.5>` (50% safety margin).
4. **Both supplied** → run as instructed.
5. **"看花多少钱"** → dry-run only, never real run.

### Common scenarios

| User says | Command |
|---|---|
| "Douyin 试试 5 个最高分" | `process-by-score.ps1 -Platform douyin -MinScore 85 -MaxVideos 5 -BudgetUsd 3` |
| "B 站 top 20 跑完" | confirm count → `-MaxVideos 20 -BudgetUsd 15` |
| "把所有 high 都跑完" | dry-run → confirm budget → `-Tier high -BudgetUsd <user>` |
| "估一下要花多少钱" | dry-run only |
| "继续上次没跑完的" | re-run same command; `outcome=skipped` for already-done
