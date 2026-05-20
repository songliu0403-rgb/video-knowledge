# Conversation Q&A

How to answer the two most common user requests using the `answer-context` endpoint instead of re-deriving from raw evidence.

## What's in the bundle

Every processed video carries a `video_value` block (score 0–100, tier high/medium/low, recommendation text, reasons, penalties) and a `signal_profile` (primary_signal: visual/audio/both, has_hard_subtitles, etc.). The answer-context endpoint surfaces both.

## "BV1xx 怎么样？/ 这视频值不值得看？"

```bash
python {baseDir}/scripts/video_knowledge.py answer-context "BV1EXDMB2EGm 这个视频怎么样？" --video-id BV1EXDMB2EGm
```

Lead with `videoValue.recommendation` + `tier` + `reasons[]`. Mention `signalProfile.primary_signal` so the user knows whether it's a watch-the-video kind of video or a read-the-transcript kind. Then point to the top chapter timestamps. Never paraphrase value judgments — quote `videoValue.recommendation` verbatim.

## "推荐学 X 的视频"

```bash
python {baseDir}/scripts/video_knowledge.py answer-context "我想学雪地材质" --query "雪地材质"
```

Search results are already sorted by `videoValue.score` descending. The response's `alternates` array (up to 5) carries `score / tier / recommendation` for each candidate, plus 2 evidence anchors per candidate. List 2–3 picks; for each give:

- `videoId` + `title` + `sourceUrl`
- The `videoValue.recommendation` line as the why-watch reason
- One concrete evidence anchor (timestamp range from `matches` or `alternates[].evidence`) — no anchor → no claim

## Hard rules

- Any specific assertion ("第 12 分钟讲了 X", "里面用了 Dot 节点") must cite either `matches[].evidenceRanges` or `operationNotes[].time`. Without an anchor, do not say it.
- If `videoValue` is absent, the bundle predates the value-scoring step. Say "this video was processed before the value-scoring pass, recommendation unavailable" rather than inventing one.
- Treat `safeToQuoteExactCode=false` as a hard rule: paraphrase code/OCR snippets; never paste them.

## Answer rules (general)

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
