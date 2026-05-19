# Setup

First-time setup for a fresh checkout. Assumes Windows; macOS/Linux paths are similar but you'll adapt PowerShell commands.

## 1. System prerequisites

| Tool | Version | Where |
|---|---|---|
| Node.js | 20+ | https://nodejs.org/ |
| pnpm | latest | `npm install -g pnpm` |
| Python (main) | 3.12 / 3.13 / 3.14 | https://python.org/ |
| Python 3.11 (Douyin only) | 3.11.x | Side-by-side install. `f2-douyin` has no 3.14 wheels. |
| ffmpeg + ffprobe | latest | On PATH |

Verify:

```bash
node --version       # >= 20
pnpm --version
python --version
python3.11 --version
ffmpeg -version
```

## 2. Install dependencies

```bash
pnpm install                # TS server
pip install faster-whisper google-genai requests   # main pipeline
python3.11 -m pip install f2-douyin browser-cookie3   # Douyin only
```

`faster-whisper` will download the model on first run (~1.5 GB for `medium`). To pre-cache: `python -c "from faster_whisper import WhisperModel; WhisperModel('medium')"`

## 3. Configure connectors

```bash
cp data/connectors.json.example data/connectors.json
```

Edit `data/connectors.json`. Key fields:

- `rootPath`: where per-video work directories live, e.g. `./data/video-poc`.
- `bilibiliCookieFilePath`: where the Bilibili login cookie will be written.
- `geminiApiKeyFilePath`: where the Gemini AI Studio key lives.

The defaults in `.example` use `./data/...` and work without further changes.

## 4. Get a Gemini AI Studio API key

1. Visit https://aistudio.google.com/app/apikey
2. Create a key (`AIzaSy...`)
3. **Important:** enable the Paid Tier on that key. The free tier has 0 RPM for `gemini-2.5-pro`.
4. Set a monthly billing cap on your Google Cloud billing page as a safety net.
5. Write the key to the path you configured:

```powershell
Set-Content -Path data/secrets/gemini-aistudio.key.txt -Value "AIzaSy..."
```

## 5. Bilibili cookie

```bash
python skills/video-knowledge/scripts/video_knowledge.py refresh-bilibili-cookie --timeout 180
```

This opens a dedicated Chrome/Edge profile. Log in to Bilibili once; the cookie is then auto-extracted via DevTools and written to your configured path. Future refreshes are unattended as long as the profile stays logged in.

## 6. Douyin cookie (optional, for Douyin support)

Chrome 127+ encrypts cookies with App-Bound Encryption, which means no script can read them directly. Use a browser extension:

1. Install **Cookie-Editor**: https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm
2. Open `https://www.douyin.com` (logged in)
3. Click the extension icon → bottom Export button → **"Header String"**
4. Save the clipboard content to the path you configured (`data/secrets/douyin.cookie.txt` by default):

```powershell
# Paste the header string into a file
notepad data/secrets/douyin.cookie.txt
```

The cookie format is the HTTP `Cookie:` header (`name1=value1; name2=value2; ...`). It typically lasts 30–60 days; re-export when calls start failing.

## 7. Start the server

```bash
pnpm dev
# server listens on http://localhost:4317
```

In another terminal:

```bash
pnpm sanity         # must pass 11/11 before any batch ingestion
```

## 8. First ingestion

```bash
python skills/video-knowledge/scripts/video_knowledge.py process-full "https://www.bilibili.com/video/BV1xxxx/"
```

This will:

1. Add the video to the ingest queue
2. Download via yt-dlp using your Bilibili cookie
3. Transcribe with local Whisper (~real-time on CPU, much faster on GPU)
4. Run Gemini visual analysis (~$0.30 for a 10-min video on `gemini-2.5-pro`)
5. Compose `video-report.md` + `video-evidence.md` + `document-assets/` under `data/video-poc/BV1xxxx/`
6. Run verify-and-fix to add data-quality banners

If `finalCheck.ok=true`, you're set. The agent can now answer:

```bash
python skills/video-knowledge/scripts/video_knowledge.py answer-context "BV1xxxx 怎么样?" --video-id BV1xxxx
```

## 9. Batch ingestion (after you've validated single-video runs)

```bash
pnpm prescore                                          # score all Bilibili favorites
pnpm process-by-score:dry                              # preview top + worst-case spend
powershell -File scripts/process-by-score.ps1 -Tier high -BudgetUsd 30 -MaxVideos 50
```

Read the **Batch Processing** section in [skills/video-knowledge/SKILL.md](../skills/video-knowledge/SKILL.md) for the full decision tree.

## Troubleshooting

- **`pnpm sanity` fails on `source <-> .agents in sync`**: run `pnpm sync-skills` first.
- **Bilibili `412` errors during sync**: rate-limited. Increase `--delay-ms 1500` and retry; previously-fetched pages are cached.
- **Whisper out-of-memory on GPU**: re-run with `--device cpu` or `--model small`.
- **Douyin returns empty 200 from API**: cookie expired. Re-export via Cookie-Editor.
- **Gemini HTTP 503**: transient overload. Auto-retry with backoff handles it; if persistent, stop and try later.

For more failure modes see the **Failure Recovery** section in [SKILL.md](../skills/video-knowledge/SKILL.md).
