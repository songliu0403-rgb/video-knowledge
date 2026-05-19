# Video Evidence Document Workflow Reference

This workflow stops at video reports and timestamped evidence documents. Knowledge-base curation, rewriting, dedupe, and llmwiki import are separate project responsibilities.

## Evidence Store Shape

Each processed video should have a directory under:

```text
<video-root>/<videoId>/
```

Expected files:

- `source.info.json`: source metadata.
- `probe.json`: ffprobe/media stream data.
- `asr/transcript.json`, `.srt`, `.txt`: ASR with timestamps.
- `evidence_screenshots/*.png`: key screenshots.
- `video-report-insights.json`: report-focused insight candidates and review hints.
- `hard-subtitle-operation-notes.safe.json`: visual-first operation notes.
- `qwen-style-video-analysis-bundle.json`: combined report bundle.
- `video-report.md`: final human-facing video content report with image links.
- `video-evidence.md`: timestamped audit/agent evidence document with image links.
- `video-document-manifest.json`: machine-readable handoff manifest for downstream skills.
- `document-assets/*`: screenshot assets referenced by the document. When the local source video is available, `compose-document` regenerates these frames from the original video resolution at the selected timestamps; otherwise it falls back to copied analysis/keyframe images.

Collection indexes live under:

```text
<video-root>/_collections/
```

Expected Bilibili favorites index:

- `bilibili-favorites.json`: synced favorite folders and video URL metadata. It is a queue/index source, not processed video evidence.

## Ingestion Phases

1. Identify source URL and stable id.
2. Download or register local video.
3. Collect platform metadata and subtitles when present.
4. Probe media streams and detect sync/duration issues.
5. Run ASR when audio has useful speech.
6. Extract keyframes and screenshots.
7. Run visual analysis for hard subtitles, code, UI steps, and screen recordings.
8. Merge into operation notes, timeline ranges, visible text evidence, gotchas, and report insight candidates.
9. Mark unsafe exact OCR/code snippets with `safe_to_quote_exact_code=false`.
10. Compose `video-report.md` for human reading and `video-evidence.md` for timestamped screenshots, ASR/OCR, and LLM visual judgment.
11. Hand the report, evidence document, and manifest to another project only if later knowledge-base writing is needed.

## Ingestion Queue

Use `video.ingest.enqueue` or the helper when a video has been selected for later processing:

```bash
python {baseDir}/scripts/video_knowledge.py enqueue-video BV1NcSfBhEYe --priority high --reason "HLSL FlowMap"
```

The queue is stored at `_queues/video-ingest.json` under the video root. Jobs are deduped by `platform:videoId`, enriched from local favorites metadata when available, and marked `metadataOnly=true` / `contentEvidence=false`. Queue entries are scheduling intent only; they are not processed evidence and must not be used to answer video-content questions.

Use `video.ingest.process-next` or the helper to prepare the next queued job:

```bash
python {baseDir}/scripts/video_knowledge.py process-next
```

`process-next` chooses the highest-priority queued job, creates `<video-root>/<videoId>/source.info.json`, and changes that job to `prepared`. It preserves existing source metadata when present and does not claim semantic analysis. If a processed bundle already exists in the work directory, it can mark the job `done`; otherwise `contentEvidence=false` remains the boundary for agent answers.

Use `video.ingest.capture-local` after `prepared`:

```bash
python {baseDir}/scripts/video_knowledge.py capture-local BV1NcSfBhEYe --frame-interval-seconds 30 --max-frames 48
```

This stage downloads or reuses `video.mp4`, runs `ffprobe` into `probe.json`, extracts simple sampled screenshots into `evidence_screenshots/`, and writes `local-capture-manifest.json`. It can mark a job `captured` with `mediaEvidence=true`, but it must keep `contentEvidence=false`. Agents still need ASR/OCR/vision analysis before answering what the video teaches.

Use `video.ingest.transcribe-local` after `captured`:

```bash
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --language zh
```

This stage reuses existing `asr/transcript.txt`, `asr/transcript.json`, and `asr/transcript.srt` when present. If transcript text is missing, it can run local Whisper or Gemini API ASR. For Gemini:

```bash
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --provider gemini --endpoint vertex-express --model gemini-3.1-pro-preview --language zh --chunk-seconds 300 --force
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --provider gemini --api-key-env GEMINI_API_KEY --max-chunks 1 --force
```

The Gemini helper chunks audio and writes normalized `asr/transcript.*` outputs plus `asr/transcript-manifest.json`. Gemini API keys should come from the same shared source used by visual analysis: `GEMINI_API_KEY` / `API_KEY` in the local server environment, connector `geminiApiKeyFilePath`, or a local key file passed as `--api-key-file-path`; do not ask the user to paste API keys into chat. This still does not mean semantic video content has been analyzed: `contentEvidence=false` remains the boundary until OCR/vision analysis and evidence composition write the final evidence bundle and document.

Use `video.ingest.analyze-visual` after `captured` or `transcribed`:

```bash
python {baseDir}/scripts/video_knowledge.py analyze-visual BV1NcSfBhEYe --mode keyframes --endpoint vertex-express --model gemini-3.1-pro-preview
```

This stage calls `scripts/analyze_visual_gemini.py` through the local capability server. It supports two evidence modes:

- `keyframes`: lower token/cost path; extracts timestamped frames and asks Gemini to identify hard subtitles, UI labels, nodes, parameters, visible formulas, errors, concepts, and operation steps.
- `clips`: higher token/cost path; cuts short clips and asks Gemini to analyze motion and hard subtitles in context.

Use `--dry-run --max-segments 1` first when testing a new machine or video. Dry runs validate paths and segmentation without calling Gemini. Successful analysis writes either `keyframe_steps/keyframe-steps-summary.json` or `hard_subtitle_steps/hard-subtitle-steps-summary.json` and marks the job `visual_analyzed`. This is visual evidence only; final user-facing output still requires the bundle and document steps.

Use `video.ingest.compose-bundle` after `visual_analyzed`:

```bash
python {baseDir}/scripts/video_knowledge.py compose-bundle BV1NcSfBhEYe
```

This stage reads visual summaries from `keyframe_steps/keyframe-steps-summary.json` or `hard_subtitle_steps/hard-subtitle-steps-summary.json`, combines them with `asr/transcript.txt` when present, and writes searchable intermediate evidence files:

- `qwen-style-video-analysis-bundle.json`
- `hard-subtitle-operation-notes.safe.json`
- `video-report-insights.json`

It sets `contentEvidence=true` and marks the job `done` only when there is usable composed evidence: operation notes, timeline ranges, screenshots, visible text, formulas, gotchas, or transcript preview. This is report evidence generation only.

Use `video.ingest.compose-document` after `compose-bundle`:

```bash
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe
```

This stage reads the composed evidence bundle, regenerates referenced screenshots into `document-assets/` from the local source video when available, and writes:

- `video-report.md`
- `video-evidence.md`
- `video-document-manifest.json`

`video-report.md` is the default user-facing report, closer to a reading guide: keywords, full summary, chapter overview, key screenshots, key takeaways, and transcript excerpts. `video-evidence.md` is organized by timestamp and includes screenshot references, LLM visual judgment, ASR/OCR evidence, code/formula candidates, gotchas, and video-report-only boundary metadata.

## Query Decision

- Query already processed video evidence first.
- When the user asks only for Bilibili favorite folder names and counts, call `list-bilibili-favorite-folders` for live folder metadata instead of inferring counts from the video index.
- When the user asks which videos are in favorites, sync or inspect `_collections/bilibili-favorites.json`.
- If `videoId` is known, search with `--video-id`.
- If no hit appears, call `get` only when the user asks for the whole bundle or evidence context.
- If the video is absent, do not use platform title as content truth.

## Bilibili Favorites Sync

The local capability server exposes `bilibili.favorites.sync` for account collection indexing. The skill helper wraps it:

```bash
python {baseDir}/scripts/video_knowledge.py login-bilibili --timeout 180
python {baseDir}/scripts/video_knowledge.py list-bilibili-favorite-folders
python {baseDir}/scripts/video_knowledge.py sync-bilibili-favorites --limit 1000 --delay-ms 1200
```

`login-bilibili` launches local Chrome/Edge with a dedicated local profile, waits for QR login, reads Bilibili cookies through the local Chrome DevTools Protocol, and writes the local cookie file. The sync tool reads that cookie from local connector config or environment, calls the Bilibili favorites APIs, and writes `_collections/bilibili-favorites.json`.
The default local cookie path comes from `BILIBILI_COOKIE_FILE` or the user-local `~/.video-knowledge/secrets/` directory.

`list-bilibili-favorite-folders` returns current folder names and Bilibili `media_count` values only. It does not list videos, does not read stale local indexes, and is the preferred tool for "how many videos are in each favorite folder" questions.

Limited syncs that stop before all known favorite videos are fetched write `_collections/bilibili-favorites.partial.json`; only complete syncs replace `_collections/bilibili-favorites.json`. Writes should be atomic and failed syncs must leave the last complete official index untouched.
Sync also maintains `_collections/bilibili-favorites.sync-cache.json`, a page-level resume cache. On retry, completed cached pages are reused to reduce Bilibili API calls and lower `412` risk. Use `--force-refresh` only when deliberately refreshing stale cached pages.
After sync, inspect favorites through the local read-only tools instead of calling Bilibili again:

```bash
python {baseDir}/scripts/video_knowledge.py list-bilibili-favorites --status pending --limit 20
python {baseDir}/scripts/video_knowledge.py search-bilibili-favorites "HLSL length" --status pending
```

These commands expose metadata only. They help select ingestion candidates, but they are not content evidence and must not be used to answer what a video teaches. They default to the complete official index; use `--source partial` only to inspect an incomplete test sync.

Index records should include:

- `folderId`, `folderTitle`: source favorite folder.
- `bvid`, `url`: stable video identity.
- `title`, `author`, `duration`: platform metadata.
- `ingestStatus`: `done` when a processed evidence folder exists, otherwise `pending`.
- `reportVideoId`: normally the same as `bvid`.

Security rules:

- Never ask the user to paste Bilibili cookies into chat.
- Keep cookie files outside the repository, preferably under `~/.video-knowledge/secrets/` or a path pointed to by `BILIBILI_COOKIE_FILE`.
- Use `login-bilibili --dry-run` to verify browser and secret paths without opening the login flow.
- Use `--delay-ms 800` to `1500` for larger syncs to reduce Bilibili `412` throttling.
- Do not expose cookie values in tool output or files.
- Treat `auth_required` as a local login setup problem, not a video analysis failure.

## Provider Guidance

- Gemini/Kimi/Claude/GPT vision models are useful for keyframes and short clips.
- Use chunked video analysis to control token cost.
- For long videos, keep evidence ranges conservative.
- Local models may help with OCR/keyframe triage, but use API models for high-value synthesis unless local quality is proven on the same video type.

## Keyframe Selection

Use `scripts/select_keyframes.py` before OCR or vision-model analysis when a video needs fresh screenshots:

```bash
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --out /path/to/evidence_screenshots --interval 2 --diff-threshold 0.30 --manifest /path/to/keyframes.json
```

The script samples low-resolution grayscale frames, groups visually similar consecutive samples, and exports the highest-quality frame from each group. This solves the main weakness of naive frame differencing: similar frames are clustered first, then the best frame is chosen by sharpness, entropy, and exposure, instead of blindly keeping the first frame that happened to cross a threshold.

Treat the manifest as audit evidence:

- `selected`: exported screenshot paths with timestamps and quality scores.
- `clusters`: all sampled alternatives inside each visual cluster.
- `alternates`: frames to review when exact code, UI state, or subtitles matter.

Use lower thresholds for screen recordings where small changes are meaningful:

- `0.12` to `0.18`: code editors, node graphs, small UI state changes.
- `0.18` to `0.22`: ordinary software tutorials.
- `0.30`: coarse lecture/slides/video scene changes.

After selection, OCR or a vision model should still force-keep frames with semantic novelty: new code, formulas, errors, menu state, hard subtitles, or step transitions.
