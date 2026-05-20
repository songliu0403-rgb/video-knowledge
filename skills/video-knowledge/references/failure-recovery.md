# Failure Recovery

When a stage errors out, report the exact error to the user and **stop**. Do not auto-retry, do not silently switch models, do not run any "repair" command without being asked. The triage matrix below gives the right first response.

## Gemini / AI Studio errors

| Error | What it means | Agent action |
|---|---|---|
| HTTP 503 "high demand" | Transient overload on the model | Retry up to 3× with 5s exponential backoff. If still failing, stop and tell the user "Gemini overloaded, try later". |
| HTTP 429 "quota exceeded" | Monthly budget or per-minute rate hit | Stop. Report quota state. Do not switch to a different model. Ask user to check the AI Studio billing page. |
| HTTP 401 / 403 | API key invalid or revoked | Stop. Report exact code. The fix is "rotate the key in `secrets/gemini-aistudio.key.txt`"; do not generate one yourself. |
| HTTP 400 "model not found" | Model deprecated or typo | Stop. Show the model name that was rejected. The fix is to update `data/connectors.json` `visionModel`; ask the user. |
| "PROHIBITED_CONTENT" / safety filter | Some Douyin clips trip Gemini's safety filters | Skip that video, mark it `visual_failed` with reason="safety_filter", continue the batch. |

## Whisper / local ASR errors

| Symptom | Likely cause | Action |
|---|---|---|
| `RuntimeError: CUDA out of memory` | GPU memory exhausted | Re-run with `--device cpu` or `--model small`. Tell the user. |
| `Failed to load audio` | Video container missing audio stream or corrupt | Mark `transcript-quality.status=failed` with that reason; do not regenerate. |
| 0 segments + duration > 30s | Legitimate BGM-only / silent video | The script already emits `status="no_speech"` — this is fine. Continue. |
| Hangs > 5× realtime | CPU is choked | Stop the run, ask the user to close heavy apps or accept `small` model. |

## Douyin / f2 errors

| Symptom | Likely cause | Action |
|---|---|---|
| `请求被拦截` or HTTP 200 with empty body | Cookie expired or signature drift | Tell the user to re-export cookie via Cookie-Editor → paste → write file. Do **not** try Chrome database decryption again. |
| `APIRetryExhaustedError` | Rate-limited or temporarily blocked | Back off 1–2 hours; reduce `--max-tasks` to 1. |
| `aweme_deleted=true` / `is_prohibited=true` | Video was taken down | Skip silently; not a failure. |
| `duration_seconds=0` from capture | Image-post (图文), not a video | `capture_douyin.py` will exit with a clear message; skip. |
| `ModuleNotFoundError: No module named 'f2'` | Script run under Python 3.14 instead of 3.11 | Use `python3.11` — f2 has no 3.14 wheels. |

## Bilibili / yt-dlp errors

| Symptom | Likely cause | Action |
|---|---|---|
| HTTP 412 from B 站 during capture | Cookie expired or rate-limited | Run `refresh-bilibili-cookie --timeout 180`; if still failing, back off 30 min and retry. |
| `auth_required` from sync | No cookie configured | Tell the user; do not ask for paste. |
| `412` during sync | Page rate limit | Use `--delay-ms 1500` and retry; previously-cached pages are reused. |

## Capability server errors

| Symptom | Likely cause | Action |
|---|---|---|
| Cannot connect to `127.0.0.1:4317` | Server not running | Run `pnpm dev` in the project root. |
| `connector_unavailable` | Connector misconfigured in `data/connectors.json` | Stop; report the connector id from the error; ask the user before editing connector config. |
| `no_visual_analysis_job` from compose-bundle | The ingest queue does not have a `visual_analyzed` job for that video id | Confirm with `check-video <id>`; if visual stage really didn't run, run `analyze-visual` (or `process_douyin.py` for Douyin) first. |

## Sanity / verification failures

If `pnpm sanity` returns < 11/11, read the named check that failed and report it verbatim. Each check is independent and has a clear remediation in `scripts/sanity-check.ps1`. Do not "fix" by deleting or moving files.

## General principle

**The agent reports; the user decides.** Never silently change provider, model, connector config, secret file paths, or any input file as a "workaround". Those changes belong to the user. The only autonomous remediation allowed is: retry transient HTTP errors (503/timeout) up to 3× with backoff.
