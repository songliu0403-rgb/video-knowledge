# Keyframe Selection

When building screenshots for a new video, do not keep frames by "first similar frame wins". Use:

```text
sample frames -> cluster similar consecutive frames -> choose best frame inside each cluster -> keep novelty/boundary evidence
```

## Run

```bash
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --out /path/to/evidence_screenshots --interval 2 --manifest /path/to/keyframes.json
```

## Selection rules

- Treat `diff <= 0.30` as likely the same visual cluster, not as automatic deletion.
- Pick the highest-quality frame in each cluster, not the first frame.
- Prefer clear, stable, information-dense frames over transition frames.
- Use OCR or vision model output later to force-keep frames with new code, formulas, errors, UI states, hard subtitles, or step changes.
- For screen recordings, use stricter thresholds when small UI/code changes matter: `--diff-threshold 0.12` to `0.22`.
- Review `alternates` in the manifest when exact code or UI wiring matters.

## Hybrid + semantic strategies

`scripts/select_keyframes.py --strategy hybrid` is a lightweight candidate selector. It adds timeline coverage and optional forced timestamps on top of visual clustering, but it does not perform OCR, CLIP retrieval, or LLM semantic scoring by itself.

```bash
# Hybrid: visual cluster reps + timeline coverage + force timestamps
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --strategy hybrid \
    --interval 2 --diff-threshold 0.08 --target-interval-seconds 30 \
    --out /path/to/keyframe-candidates --manifest /path/to/keyframe-candidates.manifest.json

python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --strategy hybrid \
    --force-timestamp 01:15,02:30,06:45 --out /path/to/keyframe-candidates
```

`scripts/select_keyframes.py --semantic-manifest` consumes OCR/LLM evidence produced elsewhere (e.g. `analyze_visual_gemini.py` summaries). It maps timestamped semantic signals to nearby sampled frames, adds `semanticScore`/`semanticReasons`, and can prune low-value screenshots with `--semantic-min-score`.

```bash
# Balanced: useful for audit/evidence reports
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --strategy hybrid \
    --interval 2 --diff-threshold 0.08 --target-interval-seconds 30 \
    --semantic-manifest /path/to/keyframe-steps-summary.json \
    --semantic-window-seconds 12 --semantic-min-score 0.55 --max-frames-per-minute 6 \
    --out /path/to/semantic-keyframes --manifest /path/to/semantic-keyframes.manifest.json

# Tight: prefer this for reviewable study reports when the user says the image set is too loose
python {baseDir}/scripts/select_keyframes.py /path/to/video.mp4 --strategy hybrid \
    --interval 2 --diff-threshold 0.08 --target-interval-seconds 30 \
    --semantic-manifest /path/to/keyframe-steps-summary.json \
    --semantic-window-seconds 10 --semantic-min-score 0.80 --max-frames-per-minute 3 \
    --out /path/to/semantic-tight-keyframes --manifest /path/to/semantic-tight-keyframes.manifest.json
```

## Compose-document defaults

`compose-document` defaults to automatic semantic-tight report screenshots when no `keyframeManifestPath` is supplied and both the local video plus visual summary exist. Tight defaults are `--semantic-min-score 0.80`, `--max-frames-per-minute 3`, `--semantic-window-seconds 10`.

Switch modes with `--keyframe-preset balanced`, disable with `--auto-keyframe-selection false`, or point at an existing keyframe manifest through `keyframeManifestPath` plus `documentVariant`/`experimental=true`. Variant outputs use names such as `video-report.hybrid-keyframes.md` and do not replace canonical paths.

## Trust answer fields when present

If `check-video.data.keyframeSelection.answerFields` is present, copy those fields directly for questions asking `selectedCount`, `semantic-min-score`, `max-frames-per-minute`, `semantic-window-seconds`, or `keyframe manifest path`. Do not calculate `max-frames-per-minute` from selected frame count and video duration — it means the configured selection cap, not the resulting average density.

Do not switch to older experimental manifests such as `semantic-tight-080-m3.manifest.json` unless that exact path is returned by the current `check-video` response.
