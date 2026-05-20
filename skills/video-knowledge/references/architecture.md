# Architecture, Boundaries, and Artifact Contract

What this skill owns, what it explicitly does not, and the strict shape of its outputs.

## Artifact contract

A completed video report exists only when `check-video` or `compose-document` returns all of these verified paths:

- `video-report.md`
- `video-evidence.md`
- `video-document-manifest.json`
- `document-assets/`

Never replace these with ad-hoc files such as `report.md`, `metadata.json`, `frames/`, date-stamped capture folders, or paths under a wiki/media library such as `F:\资源库\...`. Those belong to downstream archive or wiki skills, not this video capture/report project.

If the video file, downloader, ffmpeg, visual model, or any required tool is unavailable, the correct answer is a blocked/incomplete status. Do not write a transcript-only "final report" and do not present a screenshot directory as "待补充" while still claiming the report was generated.

## Skill boundary

This skill includes the agent workflow, local helper, lightweight keyframe selector, and video report/evidence document generation. It stops at report/evidence files and does not write to any knowledge base.

### Inside this skill

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

### Hard rules on cost and batch runs

- Real LLM spend lives on a paid AI Studio account with a monthly cap set by the user. Never start `process-full`, `process_douyin.py`, or `process-by-score` in real-run mode without an explicit `BudgetUsd` from the user for that specific run.
- Dry-runs (`-DryRun` / `pnpm process-by-score:dry`) are free and unrestricted. Use them to answer "how much will it cost?" before asking the user to commit.
- If `process-full` or `process_douyin.py` fails partway through a batch, the runner already deducts a half-cost from the budget. Do not retry the same video without user confirmation — repeated failures often mean a structural problem (cookie expired, model deprecated, video deleted).
- A user request to "test one video" defaults to the single-video commands (`process-full <BV>` / `process_douyin.py <aweme_id>`), not to `process-by-score -MaxVideos 1`. The latter still requires `-BudgetUsd`.
- A request like "处理收藏夹里所有视频" is never executed open-ended. Show the dry-run candidate count and ask for budget + max count.

### Outside this skill

- deciding which evidence should become long-term knowledge
- rewriting evidence into knowledge-base pages
- deduping or merging with existing knowledge
- importing into llmwiki or Obsidian

The `video_knowledge.py` search/get helper can run without `ffmpeg`. The `select_keyframes.py` helper requires `ffmpeg/ffprobe`; if Hermes runs in WSL and those binaries are missing there, run the selector from the Windows project environment or install/pass WSL-visible ffmpeg binaries.

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
