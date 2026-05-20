# Bilibili Pipeline

End-to-end Bilibili (B站) workflow: cookie refresh, favorites sync, single-video ingestion, and the stage-by-stage breakdown when you need to debug.

## Cookie + Favorites Sync

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

### Cookie rules

- Do not ask the user to paste cookies into chat.
- Do not use Chrome Default-profile cookie database decryption, DPAPI/AESGCM scripts, generic cookie extractors, or manual DevTools instructions unless the dedicated refresh command reports that the user must log in interactively.
- Try `refresh-bilibili-cookie` once. If it returns `refresh_failed`, `cookie_saved_but_not_logged_in`, or cannot reach DevTools, report that exact status and the `profileDir`/`cookiePath`; do not keep launching browsers in a loop.
- The Bilibili login cookie must come from local project connector config, `BILIBILI_COOKIE`, `BILIBILI_COOKIE_FILE`, or `refresh-bilibili-cookie`. The refresh command defaults to the project connector's `bilibiliCookieFilePath` when available.
- When running from WSL Hermes, `refresh-bilibili-cookie` launches the Windows browser through `powershell.exe` when available, exposes DevTools on a WSL-reachable host, and writes the Windows-visible cookie file configured by the project.
- If WSL DevTools connection still fails, return the raw JSON including `devtoolsHosts`; do not ask the user to paste cookies.
- If the tool returns `auth_required`, explain that Bilibili login is not configured locally.

### Sync rules

- For large favorites lists, use `--delay-ms 800` to `1500` to reduce Bilibili `412` risk.
- Sync uses a local page-level resume cache by default: `<video-root>/_collections/bilibili-favorites.sync-cache.json`.
- If a sync fails halfway, retry the same command; completed cached pages are reused. Use `--force-refresh` only when deliberately refreshing stale cache from Bilibili.
- Limited syncs that stop before all known favorite videos are fetched write `bilibili-favorites.partial.json`; only complete syncs replace `bilibili-favorites.json`.

### Inspection rules

- Prefer `list-bilibili-favorites`, `search-bilibili-favorites`, and `list-bilibili-orphans` for inspection after sync; they read local indexes and do not call Bilibili.
- Prefer `list-bilibili-favorite-folders` when the user asks only for collection/folder names and video counts. It calls Bilibili live folder metadata and does not list videos.
- When presenting `list-bilibili-favorite-folders`, copy `data.presentation.markdown` when available. If you reformat manually, verify the displayed row count equals `data.count` and the displayed sum equals `data.mediaCountTotal`; do not omit low-count folders.
- `list/search` default to the official complete index. Use `--source partial` only when deliberately inspecting an incomplete test sync.
- Processing status is recomputed from local BV directories every time favorites are listed. A stale `ingestStatus` stored in old favorites JSON must not override local report/evidence files.

### Orphan + identity rules

- Processing identity is the BV id (`bilibili:BV...`), not the folder name. Favorite folders are mutable current membership only.
- A folder rename or video migration changes only `currentFavoriteFolders`; it must not reset a processed BV to pending.
- If a processed BV is missing from the current favorites snapshot, classify it as an orphan with `favoriteStatus=not_in_current_favorites` and keep its local report paths available. Possible causes include manual unfavorite, folder cleanup, source deletion/private visibility, or syncing against an incomplete snapshot.
- `list-bilibili-orphans --status processed` shows already processed local artifacts that are outside current favorites. Do not delete, re-enqueue, or reprocess them unless the user asks.
- Synced favorite titles are only metadata; do not answer content questions from them.

### Enqueueing

- Use the synced list to decide what to ingest next, then generate `video-report.md` and `video-evidence.md`.
- After `enqueue-video`, report the returned `job.status`. If it is `queued`, say it is "已加入队列/等待处理"; do not say it is "正在后台处理中" or will generate a complete summary unless you also ran the later processing capabilities or a known worker is active.

## Single-Video Ingestion (process-full)

When the user gives only a video URL/BV and wants it processed, run the one-shot intake command:

```bash
python {baseDir}/scripts/video_knowledge.py process-full "https://www.bilibili.com/video/BV1NcSfBhEYe/"
```

It checks existing artifacts, auto-enqueues fresh targets, runs capture/ASR/visual analysis/document composition, and verifies the final report paths. A full pipeline is complete only when `process-full.data.outcome=processed` and `process-full.data.finalCheck.ok=true`, or a later `check-video` returns `ok=true`.

`process-full` can resume a target video that is already `prepared`, `captured`, `transcribed`, or `visual_analyzed`. If it blocks at `capture-local`/`download` with Bilibili HTTP 412, report that a valid Bilibili login cookie is required instead of inventing report paths.

## Folder Batch (process-folder-missing-reports)

When the user asks to process all missing reports in a Bilibili favorite folder, use the safe one-by-one folder runner instead of manually chaining pipeline steps. It skips verified reports, reruns `processed_invalid_transcript` videos with `--force`, writes progress after each item, and stops on the first blocked item unless `--continue-on-error` is explicitly set:

```bash
python {baseDir}/scripts/video_knowledge.py process-folder-missing-reports "技术美术-材质" --one-by-one --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh --progress-file <video-root>/_batch/技术美术-材质.progress.json
```

For multi-platform batch by score, see `references/batch.md`.

## Stage-by-Stage (only for debugging)

When `process-full` is the right call, prefer it over chaining individual stages. The breakdown below is for when one stage blocked and you want to redo just that one.

### Enqueue

```bash
python {baseDir}/scripts/video_knowledge.py enqueue-video BV1NcSfBhEYe --priority high --reason "HLSL FlowMap"
```

The queue file lives at `<video-root>/_queues/video-ingest.json`. Enqueueing is idempotent by `platform:videoId`, enriches jobs from local Bilibili favorites metadata when available, and still does not mean the video has been analyzed.

### Prepare workdir

```bash
python {baseDir}/scripts/video_knowledge.py process-next
```

`process-next` selects the highest-priority queued job, creates `<video-root>/<video-id>/source.info.json`, and marks the job `prepared`. This is a queue/workspace preparation step only.

### Capture (download + probe + screenshots)

```bash
python {baseDir}/scripts/video_knowledge.py capture-local BV1NcSfBhEYe --frame-interval-seconds 30 --max-frames 48
```

Downloads or reuses `video.mp4`, writes `probe.json`, extracts screenshots into `evidence_screenshots/`, and writes `local-capture-manifest.json`. Creates media evidence only.

`capture-local` passes the configured Bilibili cookie to `yt-dlp` with a temporary Netscape cookie file. The tool response may show the cookie file path, but must never expose the cookie header values.

### Transcribe

```bash
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --language zh
```

First indexes existing `asr/transcript.txt`, `asr/transcript.json`, `asr/transcript.srt` if present. If no transcript exists, calls Whisper or Gemini ASR.

Local Whisper (default, $0) writes via `scripts/transcribe_audio_whisper.py`. Gemini path:

```bash
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh --chunk-seconds 300 --force
```

Use `--max-chunks 1 --dry-run` for a cheap path/segmentation check before spending tokens.

### Visual analysis

```bash
python {baseDir}/scripts/video_knowledge.py analyze-visual BV1NcSfBhEYe --mode keyframes --endpoint vertex-express --model gemini-3.1-pro-preview
```

`--mode keyframes` samples frames and is cheaper; `--mode clips` sends short video clips and can read motion/hard subtitles better. Use `--dry-run --max-segments 1` first to validate ffmpeg paths and chunk planning without spending model tokens. A successful run writes `keyframe_steps/keyframe-steps-summary.json` or `hard_subtitle_steps/hard-subtitle-steps-summary.json` and marks the job `visual_analyzed`.

### Compose bundle

```bash
python {baseDir}/scripts/video_knowledge.py compose-bundle BV1NcSfBhEYe
```

Reads visual summaries plus ASR transcript text and writes `qwen-style-video-analysis-bundle.json`, `hard-subtitle-operation-notes.safe.json`, `video-report-insights.json`. When the composed evidence has operation notes/timeline/transcript/screenshots/visible-text/formulas/gotchas, it marks the queue job `done` and sets `contentEvidence=true` in `source.info.json`.

### Compose document

```bash
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe
```

Writes:

- `video-report.md`: the human-facing video content report, organized like a reading guide with keywords, summary, chapters, screenshots, key points, and transcript excerpts.
- `video-evidence.md`: the timestamped audit/agent evidence document with visual judgment, ASR/OCR evidence, gotchas, and boundary notes.
- `video-document-manifest.json`
- `document-assets/` with timestamped screenshot assets, regenerated from the local source video at original resolution when available

`compose-document` regenerates document screenshots from the local source video at the selected timestamps when `videoPath` is available, preserving original video resolution for the report/evidence documents; if extraction fails, it falls back to copied analysis/keyframe images.

It defaults to automatic semantic-tight report screenshots when no `keyframeManifestPath` is supplied and both the local video plus visual summary exist. Tight defaults are `--semantic-min-score 0.80`, `--max-frames-per-minute 3`, `--semantic-window-seconds 10`.

Switch modes with `--keyframe-preset balanced`, disable with `--auto-keyframe-selection false`, or point at an existing keyframe manifest through `keyframeManifestPath` plus `documentVariant`/`experimental=true`. Variant outputs use names such as `video-report.hybrid-keyframes.md` and do not replace canonical paths.

The report is the default file to show the user. The evidence document is the default file to give another agent when it needs timestamped proof, screenshot links, and boundary metadata. Neither file writes content into a knowledge base.

Read `references/workflow.md` for the evidence-store layout, `references/keyframes.md` for keyframe selection, and `references/architecture.md` for the artifact contract and boundary.
