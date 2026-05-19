#!/usr/bin/env python3
"""Helper for the video-knowledge skill.

Wraps the local capability-repository video knowledge server so agents can
reliably check availability, sync Bilibili favorites, search processed evidence,
and get compact answer context without hand-writing HTTP requests.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = (
    os.environ.get("VIDEO_KNOWLEDGE_BASE_URL")
    or "http://127.0.0.1:4317"
)
BILIBILI_NAV_URL = "https://api.bilibili.com/x/web-interface/nav"


def default_repo_path() -> Path:
    configured = os.environ.get("VIDEO_KNOWLEDGE_REPO")

    if configured:
        return Path(configured)

    script_path = Path(__file__).resolve()
    candidates = [
        *script_path.parents,
        Path.cwd(),
        *Path.cwd().parents,
        Path("."),
    ]
    for candidate in candidates:
        if (candidate / "package.json").exists() and (candidate / "src").exists():
            return candidate

    return Path.cwd()


DEFAULT_REPO = default_repo_path()
REQUIRED_TOOLS = {
    "video.knowledge.search",
    "video.knowledge.get",
    "video.knowledge.check",
    "video.environment.check",
    "bilibili.favorites.sync",
    "bilibili.favorites.folders",
    "bilibili.favorites.list",
    "bilibili.favorites.orphans",
    "bilibili.favorites.search",
    "video.ingest.enqueue",
    "video.ingest.process-next",
    "video.ingest.process-full",
    "video.ingest.capture-local",
    "video.ingest.transcribe-local",
    "video.ingest.analyze-visual",
    "video.ingest.compose-bundle",
    "video.ingest.compose-document",
}


class VideoKnowledgeError(RuntimeError):
    pass


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def server_visible_path(value: str | None) -> str | None:
    if not value:
        return None

    path = Path(value)
    if os.name == "nt" or not path.is_absolute():
        return value

    try:
        converted = subprocess.check_output(["wslpath", "-w", value], text=True).strip()
        return converted or value
    except (OSError, subprocess.SubprocessError):
        return value


def is_windows_absolute_path(value: str) -> bool:
    return bool(re.match(r"^[A-Za-z]:[\\/]", value))


def resolve_local_path(value: str, repo: Path) -> Path:
    expanded = os.path.expandvars(os.path.expanduser(value))
    if is_windows_absolute_path(expanded):
        return Path(expanded)

    path = Path(expanded)
    if path.is_absolute():
        return path

    return (repo / path).resolve()


def read_video_connector_config(repo: Path) -> dict[str, Any]:
    connectors_path = repo / "data" / "connectors.json"
    if not connectors_path.exists():
        return {}

    try:
        payload = json.loads(connectors_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    connectors = payload.get("connectors")
    if not isinstance(connectors, list):
        return {}

    for connector in connectors:
        if not isinstance(connector, dict):
            continue
        if connector.get("connectorType") == "runtime" and connector.get("connectorId") == "runtime.video-knowledge.main":
            config = connector.get("config")
            return config if isinstance(config, dict) else {}

    return {}


def default_bilibili_cookie_path(repo: Path) -> Path:
    configured = (
        os.environ.get("VIDEO_KNOWLEDGE_BILIBILI_COOKIE_FILE")
        or os.environ.get("BILIBILI_COOKIE_FILE")
    )
    if configured:
        return resolve_local_path(configured, repo)

    connector_cookie_file = read_video_connector_config(repo).get("bilibiliCookieFilePath")
    if isinstance(connector_cookie_file, str) and connector_cookie_file.strip():
        return resolve_local_path(connector_cookie_file, repo)

    if (repo / "package.json").exists():
        return (repo / ".." / "data" / "secrets" / "bilibili.cookie.txt").resolve()

    return Path.home() / ".video-knowledge" / "secrets" / "bilibili.cookie.txt"


def default_bilibili_profile_dir(repo: Path) -> Path:
    configured = (
        os.environ.get("VIDEO_KNOWLEDGE_BILIBILI_PROFILE_DIR")
        or os.environ.get("BILIBILI_LOGIN_PROFILE_DIR")
    )
    if configured:
        return resolve_local_path(configured, repo)

    if (repo / "package.json").exists():
        return (repo / ".." / "data" / "browser-profiles" / "bilibili-login").resolve()

    return Path.home() / ".video-knowledge" / "browser-profiles" / "bilibili-login"


def read_cookie_header(path: Path) -> str:
    try:
        return normalize_cookie_text(path.read_text(encoding="utf-8"))
    except OSError:
        return ""


def normalize_cookie_text(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        return ""

    if "\t" in stripped and "\n" in stripped:
        return cookie_header_from_netscape_text(stripped)

    lines = [line.strip() for line in stripped.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if len(lines) > 1 and all("\t" in line for line in lines):
        return cookie_header_from_netscape_text(stripped)

    return " ".join(lines)


def cookie_header_from_netscape_text(text: str) -> str:
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        columns = stripped.split("\t")
        if len(columns) < 7:
            continue
        domain, _, _, _, _, name, value = columns[:7]
        if "bilibili.com" not in domain.lower() and "bilibili.cn" not in domain.lower():
            continue
        if name and value:
            values[name] = value

    preferred = [
        "SESSDATA",
        "bili_jct",
        "DedeUserID",
        "DedeUserID__ckMd5",
        "sid",
        "buvid3",
        "buvid4",
        "b_nut",
        "CURRENT_FNVAL",
        "bili_ticket",
        "bili_ticket_expires",
    ]
    ordered = [name for name in preferred if name in values]
    ordered.extend(sorted(name for name in values if name not in set(ordered)))
    return "; ".join(f"{name}={values[name]}" for name in ordered)


def cookie_names(cookie_header: str) -> list[str]:
    names = []
    for part in cookie_header.split(";"):
        if "=" not in part:
            continue
        name = part.split("=", 1)[0].strip()
        if name:
            names.append(name)
    return names


def validate_bilibili_cookie_header(cookie_header: str, timeout: float = 8) -> dict[str, Any]:
    if not cookie_header:
        return {
            "ok": False,
            "status": "missing_cookie",
            "isLogin": False,
        }

    request = urllib.request.Request(
        BILIBILI_NAV_URL,
        headers={
            "accept": "application/json",
            "cookie": cookie_header,
            "referer": "https://www.bilibili.com/",
            "user-agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return {
            "ok": False,
            "status": "http_error",
            "httpStatus": error.code,
            "isLogin": False,
        }
    except ValueError:
        return {
            "ok": False,
            "status": "invalid_cookie_format",
            "isLogin": False,
        }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        return {
            "ok": False,
            "status": "request_failed",
            "error": str(error),
            "isLogin": False,
        }

    data = payload.get("data") if isinstance(payload, dict) else None
    data = data if isinstance(data, dict) else {}
    is_login = data.get("isLogin") is True

    return {
        "ok": is_login,
        "status": "logged_in" if is_login else "not_logged_in",
        "code": payload.get("code") if isinstance(payload, dict) else None,
        "message": payload.get("message") if isinstance(payload, dict) else None,
        "isLogin": is_login,
        "mid": data.get("mid"),
        "uname": data.get("uname"),
    }


def check_bilibili_cookie(repo: Path, cookie_file: str | None = None) -> dict[str, Any]:
    path = resolve_local_path(cookie_file, repo) if cookie_file else default_bilibili_cookie_path(repo)
    header = read_cookie_header(path)
    validation = validate_bilibili_cookie_header(header)

    return {
        "ok": validation.get("ok") is True,
        "cookiePath": str(path),
        "exists": path.exists(),
        "cookieNames": cookie_names(header),
        "validation": validation,
        "nextCommand": None if validation.get("ok") is True else "python {baseDir}/scripts/video_knowledge.py refresh-bilibili-cookie --timeout 180",
    }


def request_json(base_url: str, path: str, payload: dict[str, Any] | None = None, timeout: float = 8) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}{path}"
    data = None
    headers = {"accept": "application/json"}
    method = "GET"

    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json"
        method = "POST"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with url_opener(url).open(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise VideoKnowledgeError(f"HTTP {error.code} from {url}: {body}") from error
    except urllib.error.URLError as error:
        raise VideoKnowledgeError(f"Cannot connect to {url}: {error.reason}") from error
    except TimeoutError as error:
        raise VideoKnowledgeError(f"Timed out connecting to {url}") from error


def url_opener(url: str) -> urllib.request.OpenerDirector:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    is_local = host in {"localhost", "127.0.0.1", "::1"} or host.startswith("127.")
    if is_local:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


def extract_bv_id(text: str) -> str | None:
    match = re.search(r"\b(BV[0-9A-Za-z]+)\b", text)
    return match.group(1) if match else None


def get_tools(base_url: str) -> list[dict[str, Any]]:
    response = request_json(base_url, "/api/capabilities")
    capabilities = response.get("capabilities")
    if not isinstance(capabilities, list):
        raise VideoKnowledgeError(f"Capability list request failed: {response}")
    return [
        {
            "name": capability.get("capabilityId"),
            "description": capability.get("summary"),
            "category": capability.get("category"),
            "side_effect_level": capability.get("sideEffectLevel"),
            "input_schema": capability.get("inputSchema", {}),
        }
        for capability in capabilities
        if isinstance(capability, dict)
    ]


def check_tools(base_url: str) -> dict[str, Any]:
    tools = get_tools(base_url)
    names = {tool.get("name") for tool in tools}
    missing = sorted(REQUIRED_TOOLS - names)
    return {
        "baseUrl": base_url,
        "mode": "native-api",
        "ok": not missing,
        "missing": missing,
        "videoTools": [
            tool
            for tool in tools
            if str(tool.get("name", "")).startswith(("video.knowledge.", "video.environment.", "bilibili.favorites.", "video.ingest."))
        ],
    }


def pnpm_command() -> str:
    configured = os.environ.get("VIDEO_KNOWLEDGE_PNPM")
    if configured:
        return configured

    if os.name == "nt":
        return "pnpm.cmd"

    resolved = shutil.which("pnpm")
    if resolved:
        return resolved

    return "pnpm"


def wait_until_ready(base_url: str, seconds: float = 15) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            request_json(base_url, "/api/health", timeout=2)
            return True
        except VideoKnowledgeError:
            time.sleep(0.35)
    return False


def start_local_server(repo: Path, port: int) -> dict[str, Any]:
    if not repo.exists():
        raise VideoKnowledgeError(f"capability-repository not found: {repo}")

    out_log = Path(tempfile.gettempdir()) / f"video-knowledge-server-{port}.out.log"
    err_log = Path(tempfile.gettempdir()) / f"video-knowledge-server-{port}.err.log"
    env = os.environ.copy()
    env["PORT"] = str(port)

    creationflags = 0
    kwargs: dict[str, Any] = {}
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    else:
        kwargs["start_new_session"] = True

    with out_log.open("ab") as stdout, err_log.open("ab") as stderr:
        process = subprocess.Popen(
            [pnpm_command(), "dev"],
            cwd=str(repo),
            env=env,
            stdout=stdout,
            stderr=stderr,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
            **kwargs,
        )

    return {
        "pid": process.pid,
        "repo": str(repo),
        "stdout": str(out_log),
        "stderr": str(err_log),
    }


def ensure_local_server(base_url: str, repo: Path) -> dict[str, Any]:
    if wait_until_ready(base_url, seconds=1):
        result = check_tools(base_url)
        result["started"] = False
        return result

    port = int(base_url.rstrip("/").rsplit(":", 1)[-1])
    started = start_local_server(repo, port)
    if not wait_until_ready(base_url, seconds=20):
        raise VideoKnowledgeError(f"Started local capability server but it did not become ready: {started}")

    result = check_tools(base_url)
    result["started"] = True
    result["process"] = started
    return result


def call_tool(
    base_url: str,
    tool: str,
    input_data: dict[str, Any],
    caller: str = "video-knowledge-skill",
    timeout: float = 8,
) -> dict[str, Any]:
    response = request_json(
        base_url,
        "/api/execute",
        {
            "capabilityId": tool,
            "input": input_data,
            "context": {"caller": caller},
        },
        timeout=timeout,
    )
    if response.get("ok") is not True:
        raise VideoKnowledgeError(f"Capability {tool} failed: {response}")

    result = response.get("result")
    if not isinstance(result, dict):
        raise VideoKnowledgeError(f"Capability {tool} returned an invalid response: {response}")

    return {
        "executionId": response.get("executionId"),
        "capabilityId": tool,
        **result,
        "error": None,
    }


def search(base_url: str, query: str, video_id: str | None = None) -> dict[str, Any]:
    input_data: dict[str, Any] = {"query": query}
    if video_id:
        input_data["videoId"] = video_id
    return call_tool(base_url, "video.knowledge.search", input_data)


def get_bundle(base_url: str, video_id: str) -> dict[str, Any]:
    return call_tool(base_url, "video.knowledge.get", {"videoId": video_id})


def check_processed_video(base_url: str, video_id: str) -> dict[str, Any]:
    return call_tool(base_url, "video.knowledge.check", {"videoId": video_id})


def check_environment(
    base_url: str,
    scope: str | None = None,
    strict: bool = False,
    provider: str | None = None,
    asr_provider: str | None = None,
    download: str | None = None,
    probe: str | None = None,
    keyframes: str | None = None,
    transcription_script_path: str | None = None,
    script_path: str | None = None,
    python_path: str | None = None,
    auto_keyframe_selection: str | None = None,
    keyframe_selector_script_path: str | None = None,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if scope:
        input_data["scope"] = scope
    if strict:
        input_data["strict"] = "true"
    if provider or asr_provider:
        input_data["provider"] = provider or asr_provider
    if download:
        input_data["download"] = download
    if probe:
        input_data["probe"] = probe
    if keyframes:
        input_data["keyframes"] = keyframes
    if transcription_script_path:
        input_data["transcriptionScriptPath"] = server_visible_path(transcription_script_path)
    if script_path:
        input_data["scriptPath"] = server_visible_path(script_path)
    if python_path:
        input_data["pythonPath"] = python_path
    if auto_keyframe_selection:
        input_data["autoKeyframeSelection"] = auto_keyframe_selection
    if keyframe_selector_script_path:
        input_data["keyframeSelectorScriptPath"] = server_visible_path(keyframe_selector_script_path)
    return call_tool(base_url, "video.environment.check", input_data)


def sync_bilibili_favorites(
    base_url: str,
    folder_id: str | None = None,
    limit: str | None = None,
    delay_ms: str | None = None,
    resume: str | None = None,
    force_refresh: bool = False,
    cache: str | None = None,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if folder_id:
        input_data["folderId"] = folder_id
    if limit:
        input_data["limit"] = limit
    if delay_ms:
        input_data["delayMs"] = delay_ms
    if resume:
        input_data["resume"] = resume
    if force_refresh:
        input_data["forceRefresh"] = "true"
    if cache:
        input_data["cache"] = cache
    return call_tool(base_url, "bilibili.favorites.sync", input_data, timeout=600)


def list_bilibili_favorite_folders(
    base_url: str,
    folder_id: str | None = None,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if folder_id:
        input_data["folderId"] = folder_id
    return call_tool(base_url, "bilibili.favorites.folders", input_data)


def list_bilibili_favorites(
    base_url: str,
    source: str | None = None,
    folder_id: str | None = None,
    status: str | None = None,
    limit: str | None = None,
    offset: str | None = None,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if source:
        input_data["source"] = source
    if folder_id:
        input_data["folderId"] = folder_id
    if status:
        input_data["status"] = status
    if limit:
        input_data["limit"] = limit
    if offset:
        input_data["offset"] = offset
    return call_tool(base_url, "bilibili.favorites.list", input_data)


def search_bilibili_favorites(
    base_url: str,
    query: str,
    source: str | None = None,
    folder_id: str | None = None,
    status: str | None = None,
    limit: str | None = None,
    offset: str | None = None,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {"query": query}
    if source:
        input_data["source"] = source
    if folder_id:
        input_data["folderId"] = folder_id
    if status:
        input_data["status"] = status
    if limit:
        input_data["limit"] = limit
    if offset:
        input_data["offset"] = offset
    return call_tool(base_url, "bilibili.favorites.search", input_data)


def list_bilibili_favorite_orphans(
    base_url: str,
    source: str | None = None,
    status: str | None = None,
    limit: str | None = None,
    offset: str | None = None,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if source:
        input_data["source"] = source
    if status:
        input_data["status"] = status
    if limit:
        input_data["limit"] = limit
    if offset:
        input_data["offset"] = offset
    return call_tool(base_url, "bilibili.favorites.orphans", input_data)


def enqueue_video_ingest(
    base_url: str,
    target: str,
    title: str | None = None,
    priority: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    video_id = extract_bv_id(target)
    if target.startswith(("http://", "https://")):
        input_data["url"] = target
    elif video_id:
        input_data["videoId"] = video_id
    else:
        input_data["videoId"] = target
    if title:
        input_data["title"] = title
    if priority:
        input_data["priority"] = priority
    if reason:
        input_data["reason"] = reason
    return call_tool(base_url, "video.ingest.enqueue", input_data)


def process_next_video_ingest(base_url: str, target: str | None = None) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if target:
        video_id = extract_bv_id(target)
        if target.startswith(("http://", "https://")):
            input_data["url"] = target
        elif video_id:
            input_data["videoId"] = video_id
        else:
            input_data["videoId"] = target
    return call_tool(base_url, "video.ingest.process-next", input_data)


def process_full_video_ingest(
    base_url: str,
    target: str | None = None,
    download: str | None = None,
    probe: str | None = None,
    keyframes: str | None = None,
    frame_interval_seconds: str | None = None,
    max_frames: str | None = None,
    whisper: str | None = None,
    provider: str | None = None,
    asr_provider: str | None = None,
    transcription_script_path: str | None = None,
    script_path: str | None = None,
    python_path: str | None = None,
    endpoint: str | None = None,
    model: str | None = None,
    language: str | None = None,
    auto_keyframe_selection: str | None = None,
    keyframe_preset: str | None = None,
    force: bool = False,
    force_keyframe_selection: bool = False,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if target:
        video_id = extract_bv_id(target)
        if target.startswith(("http://", "https://")):
            input_data["url"] = target
        elif video_id:
            input_data["videoId"] = video_id
        else:
            input_data["videoId"] = target
    if download:
        input_data["download"] = download
    if probe:
        input_data["probe"] = probe
    if keyframes:
        input_data["keyframes"] = keyframes
    if frame_interval_seconds:
        input_data["frameIntervalSeconds"] = frame_interval_seconds
    if max_frames:
        input_data["maxFrames"] = max_frames
    if whisper:
        input_data["whisper"] = whisper
    if provider or asr_provider:
        input_data["provider"] = provider or asr_provider
    if transcription_script_path:
        input_data["transcriptionScriptPath"] = server_visible_path(transcription_script_path)
    if script_path:
        input_data["scriptPath"] = server_visible_path(script_path)
    if python_path:
        input_data["pythonPath"] = python_path
    if endpoint:
        input_data["endpoint"] = endpoint
    if model:
        input_data["model"] = model
    if language:
        input_data["language"] = language
    if auto_keyframe_selection:
        input_data["autoKeyframeSelection"] = auto_keyframe_selection
    if keyframe_preset:
        input_data["keyframePreset"] = keyframe_preset
    if force:
        input_data["force"] = "true"
    if force_keyframe_selection:
        input_data["forceKeyframeSelection"] = "true"
    return call_tool(base_url, "video.ingest.process-full", input_data, timeout=14400)


def response_data(response: dict[str, Any]) -> dict[str, Any]:
    data = response.get("data")
    return data if isinstance(data, dict) else {}


def normalize_label(value: Any) -> str:
    return str(value or "").strip().casefold()


def first_string_value(values: list[Any]) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)):
            return str(value)
    return None


def favorite_folder_id(folder: dict[str, Any]) -> str | None:
    return first_string_value([
        folder.get("folderId"),
        folder.get("mediaId"),
        folder.get("id"),
        folder.get("fid"),
    ])


def favorite_folder_name(folder: dict[str, Any]) -> str | None:
    return first_string_value([
        folder.get("title"),
        folder.get("name"),
        folder.get("folderName"),
        folder.get("mediaName"),
    ])


def favorite_video_id(item: dict[str, Any]) -> str | None:
    value = first_string_value([
        item.get("knowledgeVideoId"),
        item.get("bvid"),
        item.get("videoId"),
        item.get("id"),
    ])
    return extract_bv_id(value) or value


def favorite_video_title(item: dict[str, Any]) -> str | None:
    return first_string_value([
        item.get("title"),
        item.get("name"),
    ])


def int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def resolve_favorite_folder_id(
    folders: list[dict[str, Any]],
    folder: str | None,
    folder_id: str | None,
) -> tuple[str | None, str | None]:
    if folder_id:
        matched = next((entry for entry in folders if favorite_folder_id(entry) == folder_id), None)
        return folder_id, favorite_folder_name(matched or {}) or folder

    if not folder:
        return None, None

    normalized = normalize_label(folder)
    for entry in folders:
        entry_id = favorite_folder_id(entry)
        entry_name = favorite_folder_name(entry)
        if normalize_label(entry_id) == normalized or normalize_label(entry_name) == normalized:
            return entry_id, entry_name or folder

    raise VideoKnowledgeError(f"Bilibili favorite folder was not found: {folder}")


def collect_bilibili_favorites(
    base_url: str,
    source: str | None,
    folder_id: str | None,
    status: str | None,
    page_size: int,
) -> dict[str, Any]:
    offset = 0
    items: list[dict[str, Any]] = []
    first_page: dict[str, Any] | None = None

    while True:
        response = list_bilibili_favorites(
            base_url,
            source,
            folder_id,
            status,
            str(page_size),
            str(offset),
        )
        data = response_data(response)
        if first_page is None:
            first_page = data
        page_items = [item for item in data.get("items", []) if isinstance(item, dict)]
        items.extend(page_items)

        total = int_or_default(data.get("total"), len(items))
        count = int_or_default(data.get("count"), len(page_items))
        if count <= 0 or len(items) >= total:
            break
        offset += count

    page = dict(first_page or {})
    page["items"] = items
    page["count"] = len(items)
    page["total"] = int_or_default(page.get("total"), len(items))
    return page


def write_progress_file(path: str | None, payload: dict[str, Any]) -> None:
    if not path:
        return

    progress_path = Path(path)
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = progress_path.with_suffix(progress_path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(progress_path)


def process_folder_missing_reports(
    base_url: str,
    folder: str | None = None,
    folder_id: str | None = None,
    source: str | None = None,
    status: str | None = None,
    one_by_one: bool = False,
    max_videos: int | None = None,
    page_size: int = 500,
    progress_file: str | None = None,
    dry_run: bool = False,
    continue_on_error: bool = False,
    download: str | None = None,
    probe: str | None = None,
    keyframes: str | None = None,
    frame_interval_seconds: str | None = None,
    max_frames: str | None = None,
    whisper: str | None = None,
    provider: str | None = None,
    asr_provider: str | None = None,
    transcription_script_path: str | None = None,
    script_path: str | None = None,
    python_path: str | None = None,
    endpoint: str | None = None,
    model: str | None = None,
    language: str | None = None,
    auto_keyframe_selection: str | None = None,
    keyframe_preset: str | None = None,
    force_keyframe_selection: bool = False,
    max_consecutive_failures: int = 3,
    stop_on_first_error: bool = False,
) -> dict[str, Any]:
    if not one_by_one:
        raise VideoKnowledgeError("process-folder-missing-reports requires --one-by-one to avoid parallel ingestion.")

    first_page = collect_bilibili_favorites(base_url, source, None, None, page_size)
    folders = [entry for entry in first_page.get("folders", []) if isinstance(entry, dict)]
    resolved_folder_id, resolved_folder_name = resolve_favorite_folder_id(folders, folder, folder_id)
    folder_page = collect_bilibili_favorites(base_url, source, resolved_folder_id, status, page_size)
    items = [item for item in folder_page.get("items", []) if isinstance(item, dict)]
    records: list[dict[str, Any]] = []
    stats = {
        "totalInFolder": len(items),
        "alreadyProcessed": 0,
        "planned": 0,
        "processed": 0,
        "blocked": 0,
        "failed": 0,
        "skipped": 0,
    }

    result: dict[str, Any] = {
        "ok": True,
        "mode": "one-by-one",
        "dryRun": dry_run,
        "folder": {
            "id": resolved_folder_id,
            "name": resolved_folder_name,
        },
        "source": folder_page.get("source"),
        "indexPath": folder_page.get("indexPath"),
        "stats": stats,
        "items": records,
        "progressFile": progress_file,
    }
    write_progress_file(progress_file, result)

    processed_attempts = 0
    consecutive_failures = 0
    for item in items:
        video_id = favorite_video_id(item)
        record = {
            "videoId": video_id,
            "title": favorite_video_title(item),
        }
        records.append(record)

        if not video_id:
            record["outcome"] = "skipped"
            record["reason"] = "missing_video_id"
            stats["skipped"] += 1
            write_progress_file(progress_file, result)
            continue

        before = check_processed_video(base_url, video_id)
        before_data = response_data(before)
        before_status = str(before_data.get("status") or ("processed" if before_data.get("ok") is True else "unknown"))
        record["beforeStatus"] = before_status

        if before_data.get("ok") is True:
            record["outcome"] = "skipped"
            record["reason"] = "already_processed"
            stats["alreadyProcessed"] += 1
            write_progress_file(progress_file, result)
            continue

        if max_videos is not None and processed_attempts >= max_videos:
            record["outcome"] = "skipped"
            record["reason"] = "max_videos_reached"
            stats["skipped"] += 1
            write_progress_file(progress_file, result)
            continue

        force = before_status == "processed_invalid_transcript"
        record["force"] = force
        stats["planned"] += 1
        processed_attempts += 1

        if dry_run:
            record["outcome"] = "planned"
            write_progress_file(progress_file, result)
            if max_videos is not None and processed_attempts >= max_videos:
                result["stoppedReason"] = "max_videos_reached"
                result["remainingUninspected"] = len(items) - len(records)
                write_progress_file(progress_file, result)
                break
            continue

        try:
            pipeline = process_full_video_ingest(
                base_url,
                target=video_id,
                download=download,
                probe=probe,
                keyframes=keyframes,
                frame_interval_seconds=frame_interval_seconds,
                max_frames=max_frames,
                whisper=whisper,
                provider=provider,
                asr_provider=asr_provider,
                transcription_script_path=transcription_script_path,
                script_path=script_path,
                python_path=python_path,
                endpoint=endpoint,
                model=model,
                language=language,
                auto_keyframe_selection=auto_keyframe_selection,
                keyframe_preset=keyframe_preset,
                force=force,
                force_keyframe_selection=force_keyframe_selection,
            )
            record["processOutcome"] = response_data(pipeline).get("outcome")
            after = check_processed_video(base_url, video_id)
            after_data = response_data(after)
            record["afterStatus"] = after_data.get("status")
            record["ok"] = after_data.get("ok") is True
            if record["ok"]:
                record["outcome"] = "processed"
                stats["processed"] += 1
                consecutive_failures = 0
            else:
                record["outcome"] = "blocked"
                record["reason"] = after_data.get("status") or "final_check_not_ok"
                stats["blocked"] += 1
                result["ok"] = False
                consecutive_failures += 1
                if stop_on_first_error:
                    result["stoppedReason"] = "stop_on_first_error"
                    write_progress_file(progress_file, result)
                    break
                if max_consecutive_failures > 0 and consecutive_failures >= max_consecutive_failures:
                    result["stoppedReason"] = f"max_consecutive_failures_{max_consecutive_failures}_reached"
                    write_progress_file(progress_file, result)
                    break
        except Exception as error:
            record["outcome"] = "failed"
            record["error"] = str(error)
            stats["failed"] += 1
            result["ok"] = False
            consecutive_failures += 1
            if stop_on_first_error:
                result["stoppedReason"] = "stop_on_first_error"
                write_progress_file(progress_file, result)
                break
            if max_consecutive_failures > 0 and consecutive_failures >= max_consecutive_failures:
                result["stoppedReason"] = f"max_consecutive_failures_{max_consecutive_failures}_reached"
                write_progress_file(progress_file, result)
                break

        write_progress_file(progress_file, result)
        if max_videos is not None and processed_attempts >= max_videos:
            result["stoppedReason"] = "max_videos_reached"
            result["remainingUninspected"] = len(items) - len(records)
            write_progress_file(progress_file, result)
            break

    result["guidance"] = (
        "Each item was checked with check-video. Items with ok=true were skipped; "
        "processed_invalid_transcript items were rerun with force=true before final verification."
    )
    write_progress_file(progress_file, result)
    return result


def capture_local_video_ingest(
    base_url: str,
    target: str | None = None,
    video_path: str | None = None,
    download: str | None = None,
    probe: str | None = None,
    keyframes: str | None = None,
    frame_interval_seconds: str | None = None,
    max_frames: str | None = None,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if target:
        video_id = extract_bv_id(target)
        if target.startswith(("http://", "https://")):
            input_data["url"] = target
        elif video_id:
            input_data["videoId"] = video_id
        else:
            input_data["videoId"] = target
    if video_path:
        input_data["videoPath"] = video_path
    if download:
        input_data["download"] = download
    if probe:
        input_data["probe"] = probe
    if keyframes:
        input_data["keyframes"] = keyframes
    if frame_interval_seconds:
        input_data["frameIntervalSeconds"] = frame_interval_seconds
    if max_frames:
        input_data["maxFrames"] = max_frames
    return call_tool(base_url, "video.ingest.capture-local", input_data, timeout=1800)


def transcribe_local_video_ingest(
    base_url: str,
    target: str | None = None,
    video_path: str | None = None,
    whisper: str | None = None,
    provider: str | None = None,
    asr_provider: str | None = None,
    transcription_script_path: str | None = None,
    python_path: str | None = None,
    model: str | None = None,
    endpoint: str | None = None,
    project: str | None = None,
    location: str | None = None,
    language: str | None = None,
    chunk_seconds: str | None = None,
    max_chunks: str | None = None,
    api_key_env: str | None = None,
    api_key_file_path: str | None = None,
    task: str | None = None,
    force: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if target:
        video_id = extract_bv_id(target)
        if target.startswith(("http://", "https://")):
            input_data["url"] = target
        elif video_id:
            input_data["videoId"] = video_id
        else:
            input_data["videoId"] = target
    if video_path:
        input_data["videoPath"] = video_path
    if whisper:
        input_data["whisper"] = whisper
    if provider or asr_provider:
        input_data["provider"] = provider or asr_provider
    if transcription_script_path:
        input_data["transcriptionScriptPath"] = transcription_script_path
    if python_path:
        input_data["pythonPath"] = python_path
    if model:
        input_data["model"] = model
    if endpoint:
        input_data["endpoint"] = endpoint
    if project:
        input_data["project"] = project
    if location:
        input_data["location"] = location
    if language:
        input_data["language"] = language
    if chunk_seconds:
        input_data["chunkSeconds"] = chunk_seconds
    if max_chunks:
        input_data["maxChunks"] = max_chunks
    if api_key_env:
        input_data["apiKeyEnv"] = api_key_env
    if api_key_file_path:
        input_data["apiKeyFilePath"] = api_key_file_path
    if task:
        input_data["task"] = task
    if force:
        input_data["force"] = "true"
    if dry_run:
        input_data["dryRun"] = "true"
    return call_tool(base_url, "video.ingest.transcribe-local", input_data, timeout=7200)


def analyze_visual_video_ingest(
    base_url: str,
    target: str | None = None,
    video_path: str | None = None,
    script_path: str | None = None,
    python_path: str | None = None,
    mode: str | None = None,
    endpoint: str | None = None,
    model: str | None = None,
    project: str | None = None,
    location: str | None = None,
    segment_seconds: str | None = None,
    frame_interval: str | None = None,
    max_segments: str | None = None,
    sleep_seconds: str | None = None,
    api_key_env: str | None = None,
    api_key_file_path: str | None = None,
    force: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if target:
        video_id = extract_bv_id(target)
        if target.startswith(("http://", "https://")):
            input_data["url"] = target
        elif video_id:
            input_data["videoId"] = video_id
        else:
            input_data["videoId"] = target
    if video_path:
        input_data["videoPath"] = server_visible_path(video_path)
    if script_path:
        input_data["scriptPath"] = server_visible_path(script_path)
    if python_path:
        input_data["pythonPath"] = python_path
    if mode:
        input_data["mode"] = mode
    if endpoint:
        input_data["endpoint"] = endpoint
    if model:
        input_data["model"] = model
    if project:
        input_data["project"] = project
    if location:
        input_data["location"] = location
    if segment_seconds:
        input_data["segmentSeconds"] = segment_seconds
    if frame_interval:
        input_data["frameInterval"] = frame_interval
    if max_segments:
        input_data["maxSegments"] = max_segments
    if sleep_seconds:
        input_data["sleepSeconds"] = sleep_seconds
    if api_key_env:
        input_data["apiKeyEnv"] = api_key_env
    if api_key_file_path:
        input_data["apiKeyFilePath"] = api_key_file_path
    if force:
        input_data["force"] = "true"
    if dry_run:
        input_data["dryRun"] = "true"
    return call_tool(base_url, "video.ingest.analyze-visual", input_data, timeout=7200)


def compose_video_evidence_bundle(
    base_url: str,
    target: str | None = None,
    visual_summary_path: str | None = None,
    transcript_text_path: str | None = None,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if target:
        video_id = extract_bv_id(target)
        if target.startswith(("http://", "https://")):
            input_data["url"] = target
        elif video_id:
            input_data["videoId"] = video_id
        else:
            input_data["videoId"] = target
    if visual_summary_path:
        input_data["visualSummaryPath"] = visual_summary_path
    if transcript_text_path:
        input_data["transcriptTextPath"] = transcript_text_path
    return call_tool(base_url, "video.ingest.compose-bundle", input_data)


def compose_video_evidence_document(
    base_url: str,
    target: str | None = None,
    video_path: str | None = None,
    bundle_path: str | None = None,
    transcript_text_path: str | None = None,
    document_path: str | None = None,
    report_path: str | None = None,
    evidence_path: str | None = None,
    document_manifest_path: str | None = None,
    document_assets_dir: str | None = None,
    document_variant: str | None = None,
    experimental: bool = False,
    keyframe_manifest_path: str | None = None,
    auto_keyframe_selection: str | None = None,
    keyframe_preset: str | None = None,
    visual_summary_path: str | None = None,
    keyframe_selector_script_path: str | None = None,
    semantic_min_score: str | None = None,
    max_frames_per_minute: str | None = None,
    force_keyframe_selection: bool = False,
) -> dict[str, Any]:
    input_data: dict[str, Any] = {}
    if target:
        video_id = extract_bv_id(target)
        if target.startswith(("http://", "https://")):
            input_data["url"] = target
        elif video_id:
            input_data["videoId"] = video_id
        else:
            input_data["videoId"] = target
    if video_path:
        input_data["videoPath"] = video_path
    if bundle_path:
        input_data["bundlePath"] = bundle_path
    if transcript_text_path:
        input_data["transcriptTextPath"] = transcript_text_path
    if document_path:
        input_data["documentPath"] = document_path
    if report_path:
        input_data["reportPath"] = report_path
    if evidence_path:
        input_data["evidencePath"] = evidence_path
    if document_manifest_path:
        input_data["documentManifestPath"] = document_manifest_path
    if document_assets_dir:
        input_data["documentAssetsDir"] = document_assets_dir
    if document_variant:
        input_data["documentVariant"] = document_variant
    if experimental:
        input_data["experimental"] = "true"
    if keyframe_manifest_path:
        input_data["keyframeManifestPath"] = server_visible_path(keyframe_manifest_path)
    if auto_keyframe_selection:
        input_data["autoKeyframeSelection"] = auto_keyframe_selection
    if keyframe_preset:
        input_data["keyframePreset"] = keyframe_preset
    if visual_summary_path:
        input_data["visualSummaryPath"] = server_visible_path(visual_summary_path)
    if keyframe_selector_script_path:
        input_data["keyframeSelectorScriptPath"] = server_visible_path(keyframe_selector_script_path)
    if semantic_min_score:
        input_data["semanticMinScore"] = semantic_min_score
    if max_frames_per_minute:
        input_data["maxFramesPerMinute"] = max_frames_per_minute
    if force_keyframe_selection:
        input_data["forceKeyframeSelection"] = "true"
    return call_tool(base_url, "video.ingest.compose-document", input_data, timeout=1800)


def run_bilibili_browser_login_raw(
    timeout: str | None,
    port: str | None,
    dry_run: bool,
    cookie_file: Path,
    profile_dir: Path,
    browser: str | None = None,
) -> subprocess.CompletedProcess[str]:
    script_path = Path(__file__).with_name("bilibili_browser_login.py")
    command = [sys.executable, str(script_path)]
    if timeout:
        command.extend(["--timeout", timeout])
    if port:
        command.extend(["--port", port])
    command.extend(["--cookie-file", str(cookie_file)])
    command.extend(["--profile-dir", str(profile_dir)])
    if browser:
        command.extend(["--browser", browser])
    if dry_run:
        command.append("--dry-run")
    return subprocess.run(command, text=True, capture_output=True)


def parse_json_stdout(completed: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    stdout = completed.stdout.strip()
    if not stdout:
        return {}

    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return {
            "rawStdout": stdout[-4000:],
        }


def refresh_bilibili_cookie(
    repo: Path,
    timeout: str | None,
    port: str | None,
    dry_run: bool,
    cookie_file: str | None = None,
    profile_dir: str | None = None,
    browser: str | None = None,
) -> dict[str, Any]:
    cookie_path = resolve_local_path(cookie_file, repo) if cookie_file else default_bilibili_cookie_path(repo)
    profile_path = resolve_local_path(profile_dir, repo) if profile_dir else default_bilibili_profile_dir(repo)
    completed = run_bilibili_browser_login_raw(timeout, port, dry_run, cookie_path, profile_path, browser)
    login_result = parse_json_stdout(completed)

    result: dict[str, Any] = {
        "ok": completed.returncode == 0,
        "status": "dry_run" if dry_run else "cookie_refreshed",
        "cookiePath": str(cookie_path),
        "profileDir": str(profile_path),
        "loginTool": login_result,
    }

    if completed.stderr.strip():
        result["stderrTail"] = completed.stderr.strip()[-2000:]

    if dry_run:
        return result

    if completed.returncode != 0:
        result["ok"] = False
        result["status"] = "refresh_failed"
        result["guidance"] = (
            "Use the dedicated browser window/profile opened by this command. "
            "If it did not open or DevTools was unreachable, run the dry-run command and check the reported browser/profile/port."
        )
        return result

    check_result = check_bilibili_cookie(repo, str(cookie_path))
    result["ok"] = check_result.get("ok") is True
    result["status"] = "cookie_refreshed_and_valid" if result["ok"] else "cookie_saved_but_not_logged_in"
    result["validation"] = check_result.get("validation")
    result["cookieNames"] = check_result.get("cookieNames", [])
    if not result["ok"]:
        result["guidance"] = "The cookie file was updated, but Bilibili API still reports not logged in. Log into Bilibili in the dedicated browser profile and rerun refresh-bilibili-cookie."
    return result


def build_answer_context(base_url: str, query: str, video_id: str | None) -> dict[str, Any]:
    inferred_video_id = video_id or extract_bv_id(query)
    search_result = search(base_url, query, inferred_video_id)
    items = search_result.get("data", {}).get("items", [])
    if not items:
        return {
            "ok": False,
            "reason": "no_processed_video_match",
            "query": query,
            "videoId": inferred_video_id,
            "guidance": "No processed evidence was found. Do not answer from the title alone; ingest the video first.",
        }

    top = items[0]
    bundle = get_bundle(base_url, top["videoId"])
    video = bundle.get("data", {}).get("video", {})
    matches = top.get("matches", [])[:8]
    screenshots = top.get("evidence", {}).get("screenshots", [])[:6]
    transcript = video.get("transcript", {})
    safe_to_quote_exact_code = top.get("evidence", {}).get("safeToQuoteExactCode") is True

    # Surface video value + signal profile so the agent can answer
    # "this video worth my time?" / "recommend something to learn X"
    # without re-deriving the answer from raw evidence.
    video_value = top.get("videoValue") or video.get("videoValue")
    signal_profile = top.get("signalProfile") or video.get("signalProfile")

    # For each alternate we keep up to 2 evidence rows (kind, title, summary,
    # evidenceRanges) so the agent can recommend with an anchor *without*
    # making an extra video.knowledge.get call.
    alternates: list[dict[str, Any]] = []
    for it in items[1:6]:
        alt_val = it.get("videoValue") or {}
        alt_sig = it.get("signalProfile") or {}
        alt_matches = (it.get("matches") or [])[:2]
        compact_matches = [
            {
                "kind": m.get("kind"),
                "title": m.get("title"),
                "summary": (m.get("summary") or "")[:200] if m.get("summary") else None,
                "evidenceRanges": m.get("evidenceRanges"),
                "confidence": m.get("confidence"),
            }
            for m in alt_matches
        ]
        alternates.append({
            "videoId": it.get("videoId"),
            "title": it.get("title"),
            "sourceUrl": it.get("sourceUrl"),
            "durationSeconds": it.get("durationSeconds"),
            "score": alt_val.get("score") if isinstance(alt_val, dict) else None,
            "tier": alt_val.get("tier") if isinstance(alt_val, dict) else None,
            "recommendation": alt_val.get("recommendation") if isinstance(alt_val, dict) else None,
            "primarySignal": alt_sig.get("primary_signal") if isinstance(alt_sig, dict) else None,
            "evidence": compact_matches,
        })

    return {
        "ok": True,
        "query": query,
        "videoId": top.get("videoId"),
        "title": top.get("title"),
        "sourceUrl": top.get("sourceUrl"),
        "videoValue": video_value,
        "signalProfile": signal_profile,
        "alternates": alternates,
        "safeToQuoteExactCode": safe_to_quote_exact_code,
        "codeQuotePolicy": {
            "exactCodeAllowed": safe_to_quote_exact_code,
            "instruction": "If exactCodeAllowed is false, paraphrase code structure and cite timestamps/screenshots; do not output fenced code blocks or copied OCR/visual_text snippets.",
        },
        "matches": matches,
        "operationNotes": video.get("operationNotes", [])[:8],
        "screenshots": screenshots,
        "transcript": {
            "path": transcript.get("path"),
            "preview": transcript.get("preview", [])[:12],
        },
        "answerInstructions": [
            "Lead with videoValue.recommendation + tier when the user asks 'worth it?'/'how is this video?'.",
            "When recommending, rank by alternates' score and cite each one's tier + reason.",
            "Answer specifics from operationNotes/matches/transcript evidence; cite timestamps.",
            "Mention screenshot paths when they support the claim.",
            "If safeToQuoteExactCode is false, do not output fenced code blocks or exact OCR/visual_text code snippets; paraphrase the code role instead.",
        ],
    }


def resolve_video_root(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit)
    env = os.environ.get("VIDEO_KNOWLEDGE_VIDEO_ROOT")
    if env:
        return Path(env)
    candidates = [
        Path("./data/video-poc"),
        Path("./data/video-poc"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise VideoKnowledgeError(
        "Cannot locate video root; set VIDEO_KNOWLEDGE_VIDEO_ROOT or pass --video-root."
    )


def inspect_video_quality(video_dir: Path, min_coverage: float, min_report_size: int) -> dict[str, Any]:
    issues: list[str] = []
    issue_types: list[str] = []
    details: dict[str, Any] = {}

    asr_dir = video_dir / "asr"
    asr_quality_path = asr_dir / "transcript-quality.json"
    if asr_quality_path.exists():
        try:
            asr_q = json.loads(asr_quality_path.read_text(encoding="utf-8"))
            details["asr"] = {
                "status": asr_q.get("status"),
                "coverageRatio": asr_q.get("coverageRatio"),
                "chunksFailed": asr_q.get("chunksFailed"),
                "chunksTotal": asr_q.get("chunksTotal"),
            }
            status = asr_q.get("status")
            if status == "failed":
                issues.append("asr_failed")
                issue_types.append("asr_failed")
            elif status == "partial":
                issues.append("asr_partial")
                issue_types.append("asr_partial")
            # `no_speech`: BGM-only / silent video legitimately produces 0
            # segments — not a failure, no retry needed. Recorded in details
            # but never flagged as a fixable issue.
            coverage = asr_q.get("coverageRatio") or 0.0
            if isinstance(coverage, (int, float)) and coverage < min_coverage and status == "ok":
                issues.append("asr_low_coverage")
                issue_types.append("asr_low_coverage")
        except (json.JSONDecodeError, OSError):
            issues.append("asr_quality_unreadable")
            issue_types.append("asr_quality_unreadable")
    elif (asr_dir / "transcript.txt").exists():
        legacy_errors = list(asr_dir.glob("gemini-transcript-*.error.txt"))
        if legacy_errors:
            issues.append(f"asr_legacy_errors_{len(legacy_errors)}")
            issue_types.append("asr_legacy_errors")
            details["asr"] = {"legacyErrorFiles": len(legacy_errors)}

    visual_summary_candidates = [
        video_dir / "keyframe_steps" / "keyframe-steps-summary.json",
        video_dir / "hard_subtitle_steps" / "hard-subtitle-steps-summary.json",
    ]
    for summary_path in visual_summary_candidates:
        if not summary_path.exists():
            continue
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            issues.append(f"visual_unreadable_{summary_path.parent.name}")
            issue_types.append("visual_unreadable")
            break
        visual_q = summary.get("quality")
        if isinstance(visual_q, dict):
            details["visual"] = {
                "mode": summary_path.parent.name,
                "status": visual_q.get("status"),
                "segmentsFailed": visual_q.get("segmentsFailed"),
                "segmentsTotal": visual_q.get("segmentsTotal"),
                "usableEntries": visual_q.get("usableEntries"),
            }
            v_status = visual_q.get("status")
            if v_status in ("failed", "partial"):
                issues.append(f"visual_{v_status}")
                issue_types.append(f"visual_{v_status}")
        else:
            results = summary.get("results") or []
            errors = sum(1 for r in results if r.get("error"))
            parse_errors = sum(
                1 for r in results
                if isinstance(r.get("analysis"), dict) and r["analysis"].get("parse_error") is True
            )
            broken = errors + parse_errors
            total = len(results)
            if total and broken:
                issues.append(f"visual_legacy_errors_{broken}_of_{total}")
                issue_types.append("visual_legacy_errors")
                details["visual"] = {
                    "mode": summary_path.parent.name,
                    "legacy": True,
                    "errors": errors,
                    "parseErrors": parse_errors,
                    "total": total,
                }
        break

    report_path = video_dir / "video-report.md"
    if report_path.exists():
        size = report_path.stat().st_size
        details["report"] = {"sizeBytes": size}
        if size < min_report_size:
            issues.append(f"report_too_small_{size}b")
            issue_types.append("report_too_small")
    elif (video_dir / "qwen-style-video-analysis-bundle.json").exists():
        issues.append("report_missing_after_compose")
        issue_types.append("report_missing")

    return {
        "videoId": video_dir.name,
        "issues": issues,
        "issueTypes": list(dict.fromkeys(issue_types)),
        "details": details,
    }


def list_quality_issues(
    video_root: Path,
    min_coverage: float = 0.30,
    min_report_size: int = 5000,
    only: list[str] | None = None,
) -> dict[str, Any]:
    if not video_root.exists():
        raise VideoKnowledgeError(f"Video root does not exist: {video_root}")

    only_set = set(only) if only else None
    flagged: list[dict[str, Any]] = []
    healthy = 0
    scanned = 0

    for entry in sorted(video_root.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith("_"):
            continue
        if not entry.name.startswith(("BV", "youtube_", "douyin_")):
            continue
        scanned += 1
        record = inspect_video_quality(entry, min_coverage, min_report_size)
        if not record["issues"]:
            healthy += 1
            continue
        if only_set and not (only_set & set(record["issueTypes"])):
            continue
        flagged.append(record)

    issue_type_counts: dict[str, int] = {}
    for record in flagged:
        for t in record["issueTypes"]:
            issue_type_counts[t] = issue_type_counts.get(t, 0) + 1

    return {
        "ok": True,
        "videoRoot": str(video_root),
        "totalScanned": scanned,
        "healthy": healthy,
        "withIssues": len(flagged),
        "issueTypeCounts": dict(sorted(issue_type_counts.items(), key=lambda kv: -kv[1])),
        "videos": flagged,
    }


def infer_processing_state(video_dir: Path) -> dict[str, Any]:
    has_source = (video_dir / "source.info.json").exists()
    has_video = (video_dir / "video.mp4").exists()
    transcript_path = video_dir / "asr" / "transcript.txt"
    has_transcript = transcript_path.exists() and transcript_path.stat().st_size > 0

    visual_summary: Path | None = None
    for candidate in (
        video_dir / "keyframe_steps" / "keyframe-steps-summary.json",
        video_dir / "hard_subtitle_steps" / "hard-subtitle-steps-summary.json",
    ):
        if candidate.exists():
            visual_summary = candidate
            break

    has_bundle = (video_dir / "qwen-style-video-analysis-bundle.json").exists()
    report_path = video_dir / "video-report.md"
    has_report = report_path.exists() and report_path.stat().st_size >= 1000
    has_doc_manifest = (video_dir / "video-document-manifest.json").exists()
    has_evidence_doc = (video_dir / "video-evidence.md").exists()

    if has_report and has_doc_manifest:
        status = "documented"
    elif has_report:
        status = "documented_variant"
    elif has_bundle:
        status = "composed"
    elif visual_summary is not None:
        status = "visual_analyzed"
    elif has_transcript:
        status = "transcribed"
    elif has_video:
        status = "captured"
    elif has_source:
        status = "prepared"
    else:
        status = "unknown"

    paths: dict[str, str] = {"workDir": str(video_dir)}
    if has_source:
        paths["sourceInfoPath"] = str(video_dir / "source.info.json")
    if has_video:
        paths["videoPath"] = str(video_dir / "video.mp4")
    if (video_dir / "probe.json").exists():
        paths["probePath"] = str(video_dir / "probe.json")
    if (video_dir / "evidence_screenshots").is_dir():
        paths["screenshotsDir"] = str(video_dir / "evidence_screenshots")
    if has_transcript:
        paths["transcriptPath"] = str(transcript_path)
    if visual_summary is not None:
        paths["visualSummaryPath"] = str(visual_summary)
    if has_bundle:
        paths["bundlePath"] = str(video_dir / "qwen-style-video-analysis-bundle.json")
    safe_notes = video_dir / "hard-subtitle-operation-notes.safe.json"
    if safe_notes.exists():
        paths["safeNotesPath"] = str(safe_notes)
    insights = video_dir / "video-report-insights.json"
    if insights.exists():
        paths["reportInsightsPath"] = str(insights)
    if has_report:
        paths["reportPath"] = str(report_path)
    if has_evidence_doc:
        paths["evidencePath"] = str(video_dir / "video-evidence.md")
    if has_doc_manifest:
        paths["documentManifestPath"] = str(video_dir / "video-document-manifest.json")

    return {
        "processingStatus": status,
        "contentEvidence": has_bundle,
        "processingComplete": has_report and has_doc_manifest,
        "ingestStatus": "done" if (has_report and has_doc_manifest) else "in_progress",
        "paths": paths,
    }


def rebuild_processed_video_index(video_root: Path, write: bool) -> dict[str, Any]:
    if not video_root.exists():
        raise VideoKnowledgeError(f"Video root does not exist: {video_root}")

    index_path = video_root / "_collections" / "processed-video-index.json"

    old_index: dict[str, Any] = {}
    old_videos_by_id: dict[str, dict[str, Any]] = {}
    if index_path.exists():
        try:
            old_index = json.loads(index_path.read_text(encoding="utf-8"))
            for v in old_index.get("videos", []):
                key = v.get("videoId") or v.get("videoKey")
                if isinstance(key, str):
                    old_videos_by_id[key] = v
        except (json.JSONDecodeError, OSError):
            pass

    new_videos: list[dict[str, Any]] = []
    status_counts: dict[str, int] = {}

    for entry in sorted(video_root.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith("_"):
            continue
        if not entry.name.startswith(("BV", "youtube_", "douyin_")):
            continue

        state = infer_processing_state(entry)
        old = old_videos_by_id.get(entry.name) or {}

        platform = old.get("platform")
        if not platform:
            if entry.name.startswith("BV"):
                platform = "bilibili"
            elif entry.name.startswith("youtube_"):
                platform = "youtube"
            elif entry.name.startswith("douyin_"):
                platform = "douyin"
            else:
                platform = "unknown"

        video_id = old.get("videoId") or entry.name
        video_key = old.get("videoKey") or f"{platform}:{video_id}"
        title = old.get("title")
        source_url = old.get("sourceUrl")

        if (not title or not source_url) and (entry / "source.info.json").exists():
            try:
                src = json.loads((entry / "source.info.json").read_text(encoding="utf-8"))
                title = title or src.get("platform_title") or src.get("title")
                source_url = source_url or src.get("source_url") or src.get("webpage_url")
            except (json.JSONDecodeError, OSError):
                pass

        record = {
            "platform": platform,
            "videoKey": video_key,
            "videoId": video_id,
            "title": title,
            "sourceUrl": source_url,
            "processingStatus": state["processingStatus"],
            "ingestStatus": state["ingestStatus"],
            "processingComplete": state["processingComplete"],
            "contentEvidence": state["contentEvidence"],
            "workDir": str(entry),
            "paths": state["paths"],
        }
        new_videos.append(record)
        status_counts[state["processingStatus"]] = status_counts.get(state["processingStatus"], 0) + 1

    documented_count = status_counts.get("documented", 0) + status_counts.get("documented_variant", 0)
    new_index = {
        "platform": old_index.get("platform") or "local-video-processing",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "rootPath": str(video_root),
        "videos": new_videos,
        "stats": {
            "totalVideos": len(new_videos),
            "byStatus": dict(sorted(status_counts.items(), key=lambda kv: -kv[1])),
            "documentedCount": documented_count,
        },
    }

    old_status_map = {
        v.get("videoId"): v.get("processingStatus")
        for v in old_index.get("videos", [])
        if isinstance(v.get("videoId"), str)
    }
    changed: list[dict[str, Any]] = []
    for record in new_videos:
        old_status = old_status_map.get(record["videoId"])
        if old_status != record["processingStatus"]:
            changed.append({
                "videoId": record["videoId"],
                "from": old_status,
                "to": record["processingStatus"],
            })

    result: dict[str, Any] = {
        "ok": True,
        "indexPath": str(index_path),
        "totalVideos": len(new_videos),
        "byStatus": new_index["stats"]["byStatus"],
        "documentedCount": documented_count,
        "changedCount": len(changed),
        "changed": changed[:80],
        "wrote": False,
    }

    if write:
        if index_path.exists():
            backup_path = index_path.with_suffix(
                f".backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
            )
            backup_path.write_text(index_path.read_text(encoding="utf-8"), encoding="utf-8")
            result["backupPath"] = str(backup_path)
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(json.dumps(new_index, ensure_ascii=False, indent=2), encoding="utf-8")
        result["wrote"] = True

    return result


def humanize_bytes(n: float) -> str:
    value = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def archive_processed_videos(
    video_root: Path,
    keep_mp4: bool,
    keep_frames: bool,
    keep_audio_chunks: bool,
    write: bool,
) -> dict[str, Any]:
    if not video_root.exists():
        raise VideoKnowledgeError(f"Video root does not exist: {video_root}")

    candidates: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    total_bytes = 0

    for entry in sorted(video_root.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith("_"):
            continue
        if not entry.name.startswith(("BV", "youtube_", "douyin_")):
            continue

        state = infer_processing_state(entry)
        if state["processingStatus"] != "documented":
            continue
        if not (entry / "video-document-manifest.json").exists():
            skipped.append({"videoId": entry.name, "reason": "no_document_manifest"})
            continue
        doc_assets = entry / "document-assets"
        if not doc_assets.is_dir() or not any(doc_assets.iterdir()):
            skipped.append({"videoId": entry.name, "reason": "empty_document_assets"})
            continue

        targets: list[dict[str, Any]] = []

        if not keep_mp4:
            mp4 = entry / "video.mp4"
            if mp4.exists():
                targets.append({"path": str(mp4), "kind": "mp4", "sizeBytes": mp4.stat().st_size})

        if not keep_audio_chunks:
            chunks_dir = entry / "asr" / "api-audio-chunks"
            if chunks_dir.is_dir():
                for f in chunks_dir.glob("*.mp3"):
                    targets.append({"path": str(f), "kind": "audio_chunk", "sizeBytes": f.stat().st_size})

        if not keep_frames:
            frames_dir = entry / "keyframe_steps" / "frames"
            if frames_dir.is_dir():
                for f in list(frames_dir.glob("*.jpg")) + list(frames_dir.glob("*.png")):
                    targets.append({"path": str(f), "kind": "keyframe", "sizeBytes": f.stat().st_size})
            clips_dir = entry / "hard_subtitle_steps" / "clips"
            if clips_dir.is_dir():
                for f in clips_dir.glob("*.mp4"):
                    targets.append({"path": str(f), "kind": "clip", "sizeBytes": f.stat().st_size})

        if not targets:
            continue

        video_bytes = sum(int(t["sizeBytes"]) for t in targets)
        total_bytes += video_bytes
        candidates.append({
            "videoId": entry.name,
            "freedBytes": video_bytes,
            "freedHuman": humanize_bytes(video_bytes),
            "freedFiles": len(targets),
            "targets": targets,
        })

    deleted_count = 0
    delete_errors: list[dict[str, str]] = []
    if write:
        for cand in candidates:
            for target in cand["targets"]:
                try:
                    Path(target["path"]).unlink()
                    deleted_count += 1
                except OSError as exc:
                    delete_errors.append({"path": target["path"], "error": str(exc)})

    summarized_videos = []
    for cand in candidates:
        summary = {
            "videoId": cand["videoId"],
            "freedBytes": cand["freedBytes"],
            "freedHuman": cand["freedHuman"],
            "freedFiles": cand["freedFiles"],
        }
        if write:
            summary["targets"] = cand["targets"]
        summarized_videos.append(summary)

    return {
        "ok": True,
        "dryRun": not write,
        "videoRoot": str(video_root),
        "candidates": len(candidates),
        "totalFreedBytes": total_bytes,
        "totalFreedHuman": humanize_bytes(total_bytes),
        "deletedFileCount": deleted_count,
        "deleteErrors": delete_errors,
        "skipped": skipped,
        "videos": summarized_videos,
    }


def valueToNumberLike(value: Any) -> int | None:
    """Helper: convert value to int, return None on failure."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


_VERIFY_BANNER_START = "<!-- VERIFY:WARNING_BANNER:START -->"
_VERIFY_BANNER_END = "<!-- VERIFY:WARNING_BANNER:END -->"
_VERIFY_DESC_START = "<!-- VERIFY:DESCRIPTION:START -->"
_VERIFY_DESC_END = "<!-- VERIFY:DESCRIPTION:END -->"


def _load_video_info(video_dir: Path) -> dict[str, Any] | None:
    """Read yt-dlp metadata."""
    p = video_dir / "video.info.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _load_community(video_dir: Path) -> dict[str, Any] | None:
    p = video_dir / "comments.curated.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def assess_video_value(
    bundle: dict[str, Any] | None,
    asr_quality: dict[str, Any] | None,
    visual_quality: dict[str, Any] | None,
    video_info: dict[str, Any] | None,
    community: dict[str, Any] | None,
    description: str | None,
) -> dict[str, Any]:
    """Rule-based video-level value assessment. No LLM calls.

    Aggregates ASR/visual quality, chapter ASR-cross-check rate, community
    signals (author replies, sub-thread author follow-ups, high likes),
    description resources, and platform metadata into a single 0-100 score
    plus a human-readable tier and reasons list.
    """
    score = 0
    reasons: list[str] = []
    penalties: list[str] = []

    # 1) ASR quality (0-25)
    asr_cov = 0.0
    asr_status = None
    if asr_quality:
        asr_cov = float(asr_quality.get("coverageRatio") or 0.0)
        asr_status = asr_quality.get("status")
    if asr_status == "ok" and asr_cov >= 0.5:
        score += 25
        reasons.append(f"ASR 覆盖良好（{asr_cov*100:.0f}%）")
    elif asr_status == "ok" or asr_status == "partial":
        sub = 10 if asr_status == "partial" else 15
        score += sub
        reasons.append(f"ASR {'部分' if asr_status=='partial' else ''}覆盖（{asr_cov*100:.0f}%）")
    elif asr_status == "failed":
        penalties.append("ASR 全部失败（仅靠视觉）")
    elif asr_status == "no_speech":
        # BGM-only / silent video — no ASR bonus, but not a penalty either.
        # Score relies entirely on visual + community.
        reasons.append("无人声音频（纯视觉报告）")

    # 2) Visual analysis (0-20)
    v_status = (visual_quality or {}).get("status")
    if v_status == "ok":
        score += 20
        reasons.append("视觉分析完整")
    elif v_status == "partial":
        score += 12
        reasons.append("视觉分析大部分可用")
    elif v_status == "failed":
        penalties.append("视觉分析失败")

    # 3) Chapter ASR cross-check rate (0-15)
    timeline = (bundle or {}).get("timeline_segments") or []
    if isinstance(timeline, list) and timeline:
        evidence_high = sum(1 for s in timeline if isinstance(s, dict) and s.get("topic_evidence") == "high")
        evidence_med = sum(1 for s in timeline if isinstance(s, dict) and s.get("topic_evidence") == "medium")
        total = len(timeline)
        printed_ratio = (evidence_high + evidence_med * 0.5) / max(1, total)
        score += int(15 * printed_ratio)
        if (evidence_high + evidence_med) >= 1:
            reasons.append(f"{evidence_high+evidence_med}/{total} 章节有 ASR 印证（{int(printed_ratio*100)}%）")

    # 4) Community signals (0-25) — author follow-ups are the goldmine
    c_score = 0
    if community:
        stats = community.get("stats") or {}
        author_subs = int(stats.get("withAuthorSubReply") or 0)
        author_replies = int(stats.get("authorReplies") or 0)
        high_likes = int(stats.get("highLikes") or 0)
        pinned = int(stats.get("pinnedFetched") or 0)
        if author_subs > 0:
            c_score += min(18, author_subs * 4)
            reasons.append(f"{author_subs} 条作者楼中楼追问回复（社区金矿）")
        if author_replies > 0:
            c_score += min(5, author_replies * 2)
            if author_subs == 0:
                reasons.append(f"{author_replies} 条作者主楼回复")
        if pinned > 0:
            c_score += 3
            reasons.append(f"{pinned} 条置顶评论")
        if high_likes >= 3:
            c_score += min(5, high_likes // 3)
            reasons.append(f"{high_likes} 条高赞讨论")
        score += min(25, c_score)

    # 5) Description resources (0-10)
    if description:
        url_count = len(re.findall(r"https?://", description))
        if url_count > 0:
            score += min(10, 4 + url_count * 3)
            reasons.append(f"简介含 {url_count} 个资源链接")
        elif len(description) > 50:
            score += 3
            reasons.append("简介有内容补充")

    # 6) Platform metadata (0-5)
    if video_info:
        likes = int(video_info.get("like_count") or 0)
        views = int(video_info.get("view_count") or 0)
        if likes > 100 and views > 0:
            ratio = likes / views
            if ratio >= 0.05:
                score += 5
                reasons.append(f"点赞率高（{ratio*100:.1f}%）")
            elif ratio >= 0.02:
                score += 2

    # Penalties
    duration = 0
    if video_info:
        try:
            duration = int(video_info.get("duration") or 0)
        except (ValueError, TypeError):
            duration = 0
    if 0 < duration < 60:
        score -= 10
        penalties.append(f"视频太短（{duration} 秒，可能仅是片段或演示）")

    score = max(0, min(100, score))

    # Tier
    if score >= 70:
        tier = "high"
        recommendation = "**强烈推荐**（多信号 + 高质量）"
    elif score >= 45:
        tier = "medium"
        recommendation = "推荐看（有明确知识价值）"
    elif score >= 25:
        tier = "low"
        recommendation = "扫一眼（部分有用，可只看高赞或作者回复段）"
    else:
        tier = "skip"
        recommendation = "**可跳过**（信号密度低，建议先看其他来源）"

    # Primary signal
    visual_ok = v_status in ("ok", "partial")
    asr_ok = asr_status == "ok" and asr_cov >= 0.30
    if asr_ok and visual_ok:
        primary = "both"
    elif asr_ok:
        primary = "audio"
    elif visual_ok:
        primary = "visual"
    elif community and (community.get("stats") or {}).get("withAuthorSubReply", 0) > 0:
        primary = "community"
    elif description:
        primary = "metadata"
    else:
        primary = "unknown"

    return {
        "score": score,
        "tier": tier,
        "recommendation": recommendation,
        "primary_signal": primary,
        "reasons": reasons,
        "penalties": penalties,
        "duration_seconds": duration,
    }


_VERIFY_VALUE_START = "<!-- VERIFY:VALUE:START -->"
_VERIFY_VALUE_END = "<!-- VERIFY:VALUE:END -->"


def _build_value_section(value: dict[str, Any]) -> str:
    score = value.get("score", 0)
    tier = value.get("tier", "?")
    rec = value.get("recommendation", "")
    primary = value.get("primary_signal", "?")
    reasons = value.get("reasons") or []
    penalties = value.get("penalties") or []

    tier_emoji = {"high": "⭐⭐⭐", "medium": "⭐⭐", "low": "⭐", "skip": "⊘"}.get(tier, "?")
    primary_label = {
        "both": "音视频双信号",
        "audio": "音频主导（讲解清晰）",
        "visual": "视觉主导（演示/操作）",
        "community": "社区主导（评论金矿）",
        "metadata": "元数据主导（简介/资源）",
        "unknown": "信号不足",
    }.get(primary, primary)

    lines = [
        f"**评分 {score}/100  {tier_emoji}  档位：{tier}**",
        "",
        f"> {rec}",
        "",
        f"- 主信号：**{primary_label}**",
    ]
    if reasons:
        lines.append("- 加分项：")
        for r in reasons:
            lines.append(f"  - {r}")
    if penalties:
        lines.append("- 扣分项：")
        for p in penalties:
            lines.append(f"  - {p}")
    lines.append("")
    lines.append("_评分规则：ASR 质量 + 视觉质量 + 章节 ASR 印证率 + 评论金矿 + 简介资源 + 平台数据。完全规则化，0 LLM 调用。_")

    return "\n".join(lines)


def _strip_old_value_section(text: str) -> str:
    pattern = re.compile(
        re.escape(_VERIFY_VALUE_START) + r".*?" + re.escape(_VERIFY_VALUE_END) + r"\n*",
        re.DOTALL,
    )
    return pattern.sub("", text)


def _insert_value_section(text: str, value: dict[str, Any] | None) -> tuple[str, bool]:
    cleaned = _strip_old_value_section(text)
    if not value:
        return cleaned, cleaned != text

    body = _build_value_section(value)
    section = (
        f"{_VERIFY_VALUE_START}\n"
        f"## 视频价值评估\n\n"
        f"{body}\n"
        f"{_VERIFY_VALUE_END}\n\n"
    )

    # Insert right after the warning banner (or at the start of "## 关键词")
    for anchor in ("## 关键词",):
        idx = cleaned.find(anchor)
        if idx >= 0:
            return cleaned[:idx] + section + cleaned[idx:], True

    return cleaned.rstrip() + "\n\n" + section, True


def _load_video_description(video_dir: Path) -> str | None:
    """Read description from video.info.json (yt-dlp metadata)."""
    info_path = video_dir / "video.info.json"
    if not info_path.exists():
        return None
    try:
        d = json.loads(info_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    desc = d.get("description")
    if not isinstance(desc, str):
        return None
    desc = desc.strip()
    if not desc:
        return None
    return desc


def _build_description_section(desc: str) -> str:
    """Render video description as a markdown blockquote, with extracted URLs called out."""
    lines = desc.split("\n")
    out: list[str] = []
    quoted = "\n".join(f"> {line}" if line.strip() else ">" for line in lines)
    out.append(quoted)

    urls = re.findall(r"https?://[^\s，。、；）)\]》】]+", desc)
    urls_unique: list[str] = []
    for u in urls:
        # Strip trailing punctuation that often follows URLs in Chinese text
        u = u.rstrip(".,;:'\"")
        if u not in urls_unique:
            urls_unique.append(u)
    if urls_unique:
        out.append("")
        out.append("**简介中的链接**（用户手动复核来源可信度）：")
        for u in urls_unique:
            out.append(f"- {u}")

    return "\n".join(out)


def _strip_old_description_section(text: str) -> str:
    pattern = re.compile(
        re.escape(_VERIFY_DESC_START) + r".*?" + re.escape(_VERIFY_DESC_END) + r"\n*",
        re.DOTALL,
    )
    return pattern.sub("", text)


def _insert_description_section(text: str, desc: str | None) -> tuple[str, bool]:
    """Insert/replace '## 视频简介' section. Returns (new_text, changed)."""
    cleaned = _strip_old_description_section(text)
    if not desc:
        return cleaned, cleaned != text

    body = _build_description_section(desc)
    section = (
        f"{_VERIFY_DESC_START}\n"
        f"## 视频简介\n\n"
        f"{body}\n\n"
        f"_来源：B 站平台元数据 (video.info.json)，由 yt-dlp 抓取，非 LLM 推断。_\n"
        f"{_VERIFY_DESC_END}\n\n"
    )

    # Insert before the first matching anchor (sections that appear after summary)
    for anchor in ("## 语音/音频", "## 章节速览", "## 评论区精选", "## 生成说明"):
        idx = cleaned.find(anchor)
        if idx >= 0:
            return cleaned[:idx] + section + cleaned[idx:], True

    # No anchor found — append at end
    return cleaned.rstrip() + "\n\n" + section, True



def _legacy_asr_fallback(video_dir: Path) -> dict[str, Any] | None:
    asr_dir = video_dir / "asr"
    if not asr_dir.is_dir():
        return None
    transcript_path = asr_dir / "transcript.txt"
    legacy_errors = list(asr_dir.glob("gemini-transcript-*.error.txt"))
    if not transcript_path.exists() or transcript_path.stat().st_size == 0:
        if legacy_errors:
            return {"status": "failed", "coverageRatio": 0.0, "chunksFailed": len(legacy_errors), "chunksTotal": None, "_legacy": True}
        return None
    if not legacy_errors:
        return None

    duration = 0.0
    probe_path = video_dir / "probe.json"
    if probe_path.exists():
        try:
            probe = json.loads(probe_path.read_text(encoding="utf-8"))
            d = (probe.get("format") or {}).get("duration") or probe.get("duration")
            if d is not None:
                duration = float(d)
        except (json.JSONDecodeError, OSError, ValueError, TypeError):
            pass

    transcribed_seconds = 0.0
    transcript_json_path = asr_dir / "transcript.json"
    if transcript_json_path.exists():
        try:
            tdata = json.loads(transcript_json_path.read_text(encoding="utf-8"))
            for seg in tdata.get("segments") or []:
                if isinstance(seg, dict):
                    try:
                        s = float(seg.get("start_seconds") or 0)
                        e = float(seg.get("end_seconds") or 0)
                        transcribed_seconds += max(0.0, e - s)
                    except (ValueError, TypeError):
                        pass
        except (json.JSONDecodeError, OSError):
            pass

    coverage = transcribed_seconds / duration if duration > 0 else 0.0
    coverage = max(0.0, min(1.0, coverage))
    chunks_failed = len(legacy_errors)
    chunks_total = max(chunks_failed + 1, (int(duration) + 299) // 300) if duration > 0 else chunks_failed + 1

    if coverage < 0.05:
        status = "failed"
    elif coverage < 0.30:
        status = "partial"
    else:
        status = "partial"

    return {
        "status": status,
        "coverageRatio": round(coverage, 4),
        "chunksFailed": chunks_failed,
        "chunksTotal": chunks_total,
        "transcribedSeconds": round(transcribed_seconds, 2),
        "_legacy": True,
    }


def _neutralize_asr_self_assertions(text: str, asr_quality: dict[str, Any] | None) -> tuple[str, int]:
    if not asr_quality or asr_quality.get("status") not in ("failed", "partial"):
        return text, 0
    cov = asr_quality.get("coverageRatio")
    cov_text = f"{cov * 100:.1f}%" if isinstance(cov, (int, float)) else "未知"
    replacements = 0

    pattern_asr_generated = re.compile(r"^ASR：已生成（共 \d+ 条时间戳文本，?语音/音频区预览 \d+ 条）。?\s*$", re.MULTILINE)
    new_text, n = pattern_asr_generated.subn(f"ASR：覆盖率 {cov_text}，本节预览仅供参考，**详见顶部数据质量警告**。", text)
    replacements += n

    new_text, n = re.subn(r"本报告结合了画面识别和 ASR/字幕文本；", "本报告主要基于视觉关键帧分析（ASR 状态见顶部警告）；", new_text)
    replacements += n

    new_text, n = re.subn(r"报告结合画面分析和 ASR/字幕文本生成；", "报告主要基于画面分析，ASR 状态见顶部警告；", new_text)
    replacements += n

    return new_text, replacements


def _legacy_visual_fallback(visual_summary: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(visual_summary, dict):
        return None
    results = visual_summary.get("results") or []
    if not isinstance(results, list) or not results:
        return None
    total = len(results)
    failed = sum(1 for r in results if isinstance(r, dict) and r.get("error"))
    if failed == 0:
        return {"status": "ok", "segmentsFailed": 0, "segmentsTotal": total, "_legacy": True}
    fail_ratio = failed / total
    if fail_ratio > 0.7:
        return {"status": "failed", "segmentsFailed": failed, "segmentsTotal": total, "_legacy": True}
    return {"status": "partial", "segmentsFailed": failed, "segmentsTotal": total, "_legacy": True}


def _aggregate_segment_confidence(visual_summary: dict[str, Any]) -> dict[str, str]:
    confidence_by_range: dict[str, str] = {}
    for r in visual_summary.get("results") or []:
        seg_range = r.get("segment_range")
        analysis = r.get("analysis")
        if not isinstance(seg_range, str) or not isinstance(analysis, dict):
            continue
        counts = {"high": 0, "medium": 0, "low": 0}
        for key in ("operation_steps", "concepts", "visible_text"):
            for entry in analysis.get(key) or []:
                if isinstance(entry, dict):
                    c = entry.get("confidence")
                    if c in counts:
                        counts[c] += 1
        if sum(counts.values()) == 0:
            continue
        majority = max(counts, key=counts.get)
        confidence_by_range[seg_range] = majority
    return confidence_by_range


def _build_quality_banner(
    asr_quality: dict[str, Any] | None,
    visual_quality: dict[str, Any] | None,
    mp4_archived: bool,
) -> tuple[str, list[str]]:
    bullets: list[str] = []
    tags: list[str] = []

    if asr_quality:
        status = asr_quality.get("status")
        cov = float(asr_quality.get("coverageRatio") or 0.0)
        chunks_failed = asr_quality.get("chunksFailed") or 0
        chunks_total = asr_quality.get("chunksTotal") or 0
        cov_pct = f"{cov * 100:.1f}%"
        if status == "no_speech":
            bullets.append("**无人声音频**：本视频未检测到语音（纯 BGM/静音）。报告内容完全基于视觉分析，不存在 ASR 印证。")
            tags.append("asr_no_speech")
        elif status == "failed" or cov < 0.05:
            bullets.append(f"**ASR 失败**：语音转写覆盖率仅 {cov_pct}({chunks_failed}/{chunks_total} 段失败)。本报告章节内容主要由视觉模型推断，**不可作为口语化回答的依据**。")
            tags.append("asr_failed")
        elif status == "partial":
            bullets.append(f"**ASR 部分失败**：覆盖率 {cov_pct}({chunks_failed}/{chunks_total} 段失败)，缺失部分章节内容由视觉推断填充。")
            tags.append("asr_partial")
        elif cov < 0.30:
            bullets.append(f"**ASR 覆盖率偏低**：仅 {cov_pct}。")
            tags.append("asr_low_coverage")

    if visual_quality:
        v_status = visual_quality.get("status")
        v_failed = valueToNumberLike(visual_quality.get("segmentsFailed")) or 0
        v_total = valueToNumberLike(visual_quality.get("segmentsTotal")) or 0
        v_usable = valueToNumberLike(visual_quality.get("usableEntries"))
        if v_usable is None:
            v_usable = max(0, v_total - v_failed)
        v_incomplete = max(0, v_total - v_usable - v_failed)

        def _format_visual_breakdown() -> str:
            parts: list[str] = []
            if v_failed > 0:
                parts.append(f"{v_failed} 段失败")
            if v_incomplete > 0:
                parts.append(f"{v_incomplete} 段输出不完整")
            if not parts:
                return ""
            return "（" + "，".join(parts) + "）"

        if v_status == "failed":
            bullets.append(f"**视觉分析失败**：{v_total} 段中仅 {v_usable} 段可用{_format_visual_breakdown()}。")
            tags.append("visual_failed")
        elif v_status == "partial":
            bullets.append(f"**视觉分析部分可用**：{v_usable}/{v_total} 段可用{_format_visual_breakdown()}。")
            tags.append("visual_partial")

    bullets.append("**章节边界基于视觉关键帧推断**，未经 ASR 时间戳 cross-check。涉及精确代码、参数、UI 状态时请**复核截图**，不要直接作为知识库条目。")
    tags.append("chapter_boundary_disclaimer")

    if mp4_archived:
        bullets.append("**原视频已归档**，报告内截图为低分辨率关键帧回退版本。")
        tags.append("archive_screenshot_fallback")

    if not bullets:
        return "", []

    body = "\n".join(f"> - {b}" for b in bullets)
    banner = f"{_VERIFY_BANNER_START}\n> ⚠️ **数据质量警告**\n>\n{body}\n{_VERIFY_BANNER_END}"
    return banner, tags


def _strip_old_verify_banner(text: str) -> str:
    pattern = re.compile(re.escape(_VERIFY_BANNER_START) + r".*?" + re.escape(_VERIFY_BANNER_END) + r"\n*", re.DOTALL)
    return pattern.sub("", text)


def _insert_quality_banner(text: str, banner: str) -> str:
    if not banner:
        return _strip_old_verify_banner(text)
    text = _strip_old_verify_banner(text)
    match = re.search(r"^## ", text, flags=re.MULTILINE)
    if match:
        return text[:match.start()] + banner + "\n\n" + text[match.start():]
    return text + "\n\n" + banner + "\n"


def _neutralize_inline_code(text: str) -> tuple[str, int]:
    parts = re.split(r"(```[^\n]*\n.*?\n```)", text, flags=re.DOTALL)
    count = 0
    new_parts: list[str] = []
    for i, part in enumerate(parts):
        if i % 2 == 0:
            found = re.findall(r"`([^`\n]+)`", part)
            count += len(found)
            part = re.sub(r"`([^`\n]+)`", r"「\1」", part)
        new_parts.append(part)
    return "".join(new_parts), count


def _patch_chapter_confidence(text: str, confidence_by_range: dict[str, str]) -> tuple[str, int]:
    if not confidence_by_range:
        return text, 0
    badges = {"high": "", "medium": " *[置信度: 中]*", "low": " *[置信度: 低 ⚠]*"}
    count = 0

    def repl(m: re.Match[str]) -> str:
        nonlocal count
        prefix, seg_range, title = m.group(1), m.group(2), m.group(3)
        title_stripped = re.sub(r"\s*\*?\[置信度:[^\]]*\]\*?\s*$", "", title)
        conf = confidence_by_range.get(seg_range)
        badge = badges.get(conf or "high", "")
        if badge:
            count += 1
            return f"{prefix}{seg_range} {title_stripped}{badge}"
        return f"{prefix}{seg_range} {title_stripped}"

    new_text = re.sub(r"^(### )([0-9:]+-[0-9:]+) (.+)$", repl, text, flags=re.MULTILINE)
    return new_text, count


def verify_and_fix_report(video_dir: Path, write: bool) -> dict[str, Any] | None:
    report_path = video_dir / "video-report.md"
    if not report_path.exists():
        return None

    bundle_path = video_dir / "qwen-style-video-analysis-bundle.json"
    asr_quality_path = video_dir / "asr" / "transcript-quality.json"
    visual_summary_path = video_dir / "keyframe_steps" / "keyframe-steps-summary.json"

    asr_quality: dict[str, Any] | None = None
    if asr_quality_path.exists():
        try:
            asr_quality = json.loads(asr_quality_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass

    visual_summary: dict[str, Any] | None = None
    visual_quality: dict[str, Any] | None = None
    if visual_summary_path.exists():
        try:
            visual_summary = json.loads(visual_summary_path.read_text(encoding="utf-8"))
            if isinstance(visual_summary, dict):
                visual_quality = visual_summary.get("quality")
        except (json.JSONDecodeError, OSError):
            visual_summary = None

    if asr_quality is None:
        asr_quality = _legacy_asr_fallback(video_dir)
    if visual_quality is None:
        visual_quality = _legacy_visual_fallback(visual_summary)

    bundle: dict[str, Any] | None = None
    if bundle_path.exists():
        try:
            loaded = json.loads(bundle_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                bundle = loaded
        except (json.JSONDecodeError, OSError):
            pass

    mp4_archived = (
        not (video_dir / "video.mp4").exists()
        and (video_dir / "document-assets").is_dir()
        and any((video_dir / "document-assets").iterdir())
    )

    banner, banner_tags = _build_quality_banner(asr_quality, visual_quality, mp4_archived)
    confidence_by_range = _aggregate_segment_confidence(visual_summary or {})

    original_report = report_path.read_text(encoding="utf-8")
    new_report = _insert_quality_banner(original_report, banner)
    new_report, asr_assertion_count = _neutralize_asr_self_assertions(new_report, asr_quality)
    new_report, code_neutralized = _neutralize_inline_code(new_report)
    new_report, badge_count = _patch_chapter_confidence(new_report, confidence_by_range)

    description = _load_video_description(video_dir)
    new_report, description_changed = _insert_description_section(new_report, description)

    video_info = _load_video_info(video_dir)
    community = _load_community(video_dir)
    video_value = assess_video_value(
        bundle=bundle,
        asr_quality=asr_quality,
        visual_quality=visual_quality,
        video_info=video_info,
        community=community,
        description=description,
    )
    new_report, value_changed = _insert_value_section(new_report, video_value)

    bundle_patches: list[str] = []
    new_bundle: dict[str, Any] | None = None
    if bundle is not None:
        # Description from video.info.json into bundle.video_description
        existing_desc = bundle.get("video_description")
        if description and existing_desc != description:
            new_bundle = dict(bundle)
            new_bundle["video_description"] = description
            bundle_patches.append("video_description_set")
        elif (not description) and existing_desc:
            new_bundle = dict(bundle)
            new_bundle.pop("video_description", None)
            bundle_patches.append("video_description_cleared")
        bundle = new_bundle if new_bundle is not None else bundle
        # Inject video_value into bundle for downstream consumers (search/answer-context)
        existing_value = bundle.get("video_value")
        new_value_record = {
            "score": video_value["score"],
            "tier": video_value["tier"],
            "primary_signal": video_value["primary_signal"],
            "recommendation": video_value["recommendation"],
            "reasons": video_value.get("reasons", []),
            "penalties": video_value.get("penalties", []),
        }
        if existing_value != new_value_record:
            new_bundle = dict(bundle)
            new_bundle["video_value"] = new_value_record
            bundle_patches.append(f"video_value_set:{new_value_record['tier']}")
            bundle = new_bundle
        sp = dict(bundle.get("signal_profile") or {})
        old_primary = sp.get("primary_signal")
        asr_cov = float((asr_quality or {}).get("coverageRatio") or 0.0)
        asr_ok = (asr_quality or {}).get("status") == "ok" and asr_cov >= 0.30
        visual_ok = (visual_quality or {}).get("status") == "ok"
        if asr_ok and visual_ok:
            new_primary = "both"
        elif asr_ok:
            new_primary = "audio"
        elif visual_ok:
            new_primary = "visual"
        else:
            new_primary = "unknown"
        if old_primary != new_primary:
            sp["primary_signal"] = new_primary
            new_bundle = {**bundle, "signal_profile": sp}
            bundle_patches.append(f"primary_signal:{old_primary}->{new_primary}")

    patches = list(banner_tags)
    if asr_assertion_count > 0:
        patches.append(f"asr_self_assertions_neutralized_{asr_assertion_count}")
    if code_neutralized > 0:
        patches.append(f"unsafe_inline_code_neutralized_{code_neutralized}")
    if badge_count > 0:
        patches.append(f"chapter_confidence_badges_{badge_count}")
    if description_changed:
        patches.append("description_section_injected" if description else "description_section_removed")
    if value_changed:
        patches.append(f"video_value_{video_value.get('tier','?')}_{video_value.get('score',0)}")

    written: list[str] = []
    if write:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        if new_report != original_report:
            backup = report_path.with_suffix(f".backup-{ts}.md")
            backup.write_text(original_report, encoding="utf-8")
            report_path.write_text(new_report, encoding="utf-8")
            written.append("video-report.md")
        if new_bundle is not None and bundle_patches:
            backup_bundle = bundle_path.with_suffix(f".backup-{ts}.json")
            backup_bundle.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
            bundle_path.write_text(json.dumps(new_bundle, ensure_ascii=False, indent=2), encoding="utf-8")
            written.append("qwen-style-video-analysis-bundle.json")

    return {
        "videoId": video_dir.name,
        "patches": patches,
        "bundlePatches": bundle_patches,
        "written": written,
        "asrStatus": (asr_quality or {}).get("status"),
        "asrCoverage": (asr_quality or {}).get("coverageRatio"),
        "visualStatus": (visual_quality or {}).get("status"),
        "mp4Archived": mp4_archived,
    }


def verify_and_fix_reports(
    video_root: Path,
    write: bool,
    only_videos: list[str] | None = None,
) -> dict[str, Any]:
    if not video_root.exists():
        raise VideoKnowledgeError(f"Video root does not exist: {video_root}")

    only_set = set(only_videos) if only_videos else None
    records: list[dict[str, Any]] = []
    patch_counts: dict[str, int] = {}
    written_count = 0

    for entry in sorted(video_root.iterdir()):
        if not entry.is_dir() or entry.name.startswith("_"):
            continue
        if not entry.name.startswith(("BV", "youtube_", "douyin_")):
            continue
        if only_set and entry.name not in only_set:
            continue

        result = verify_and_fix_report(entry, write)
        if result is None:
            continue
        records.append(result)
        for tag in result.get("patches", []):
            base = re.sub(r"_\d+$", "", tag)
            patch_counts[base] = patch_counts.get(base, 0) + 1
        if result.get("written"):
            written_count += 1

    return {
        "ok": True,
        "dryRun": not write,
        "videoRoot": str(video_root),
        "totalReportsScanned": len(records),
        "writtenCount": written_count,
        "patchCounts": dict(sorted(patch_counts.items(), key=lambda kv: -kv[1])),
        "totalVideos": len(records),
        "videos": records[:50],
    }


def retry_failed_videos(
    base_url: str,
    video_root: Path,
    only_types: list[str] | None,
    max_videos: int | None,
    progress_file: str | None,
    dry_run: bool,
    provider: str | None,
    endpoint: str | None,
    model: str | None,
    language: str | None,
    max_consecutive_failures: int,
) -> dict[str, Any]:
    quality_report = list_quality_issues(video_root, only=only_types)
    candidates = list(quality_report.get("videos") or [])
    if max_videos is not None:
        candidates = candidates[:max_videos]

    records: list[dict[str, Any]] = []
    stats = {
        "totalCandidates": len(candidates),
        "attempted": 0,
        "succeeded": 0,
        "blocked": 0,
        "failed": 0,
    }
    result: dict[str, Any] = {
        "ok": True,
        "dryRun": dry_run,
        "videoRoot": str(video_root),
        "issueTypeCounts": quality_report.get("issueTypeCounts"),
        "stats": stats,
        "items": records,
    }
    write_progress_file(progress_file, result)

    consecutive_failures = 0
    for cand in candidates:
        record = {
            "videoId": cand.get("videoId"),
            "issueTypes": cand.get("issueTypes"),
        }
        records.append(record)

        if dry_run:
            record["outcome"] = "planned"
            write_progress_file(progress_file, result)
            continue

        try:
            pipeline = process_full_video_ingest(
                base_url,
                target=cand.get("videoId"),
                provider=provider,
                endpoint=endpoint,
                model=model,
                language=language,
                force=True,
            )
            record["processOutcome"] = response_data(pipeline).get("outcome")
            after = check_processed_video(base_url, cand.get("videoId"))
            after_data = response_data(after)
            record["afterStatus"] = after_data.get("status")
            if after_data.get("ok") is True:
                record["outcome"] = "processed"
                stats["succeeded"] += 1
                consecutive_failures = 0
            else:
                record["outcome"] = "blocked"
                record["reason"] = after_data.get("status") or "final_check_not_ok"
                stats["blocked"] += 1
                result["ok"] = False
                consecutive_failures += 1
        except Exception as error:
            record["outcome"] = "failed"
            record["error"] = str(error)
            stats["failed"] += 1
            result["ok"] = False
            consecutive_failures += 1

        stats["attempted"] += 1
        write_progress_file(progress_file, result)

        if max_consecutive_failures > 0 and consecutive_failures >= max_consecutive_failures:
            result["stoppedReason"] = f"max_consecutive_failures_{max_consecutive_failures}_reached"
            write_progress_file(progress_file, result)
            break

    return result


def fetch_comments_local(
    video_id: str,
    work_dir: str,
    cookie_file: str | None = None,
    main_count: str | None = None,
    sub_count: str | None = None,
    sort: str | None = None,
    delay_ms: str | None = None,
    min_likes: str | None = None,
    no_anonymize: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    script_path = Path(__file__).resolve().parent / "fetch_bilibili_comments.py"
    if not script_path.exists():
        raise VideoKnowledgeError(f"fetch_bilibili_comments.py not found at {script_path}")
    cmd: list[str] = [sys.executable, str(script_path), "--video-id", video_id, "--work-dir", work_dir]
    if cookie_file:
        cmd += ["--cookie-file", cookie_file]
    if main_count:
        cmd += ["--main-count", str(main_count)]
    if sub_count:
        cmd += ["--sub-count", str(sub_count)]
    if sort:
        cmd += ["--sort", str(sort)]
    if delay_ms:
        cmd += ["--delay-ms", str(delay_ms)]
    if min_likes:
        cmd += ["--min-likes", str(min_likes)]
    if no_anonymize:
        cmd += ["--no-anonymize"]
    if dry_run:
        cmd += ["--dry-run"]

    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    if proc.returncode != 0:
        raise VideoKnowledgeError(f"fetch_bilibili_comments exit {proc.returncode}: {stderr or stdout}")
    # The script prints progress lines to stdout and a final JSON summary on the last line.
    for line in reversed(stdout.splitlines()):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return {"ok": False, "raw": stdout, "stderr": stderr}


def resolve_cookie_file(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    env = os.environ.get("BILIBILI_COOKIE_FILE")
    if env:
        return env
    # Fall back to connectors.json bilibiliCookieFilePath
    candidates = [
        Path("./data/connectors.json"),
        Path("./data/connectors.json"),
    ]
    for c in candidates:
        if not c.exists():
            continue
        try:
            d = json.loads(c.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for conn in (d.get("connectors") or []):
            if (conn.get("connectorId") or "").endswith("video-knowledge.main"):
                cfg = conn.get("config") or {}
                p = cfg.get("bilibiliCookieFilePath")
                if p:
                    return p
    return None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Use local video knowledge capabilities.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--repo", default=str(DEFAULT_REPO))
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("ensure", help="Ensure the local capability server is running.")
    subparsers.add_parser("tools", help="List video knowledge capabilities exposed by the local server.")

    search_parser = subparsers.add_parser("search", help="Search processed video evidence.")
    search_parser.add_argument("query")
    search_parser.add_argument("--video-id")

    get_parser = subparsers.add_parser("get", help="Get a processed video evidence bundle.")
    get_parser.add_argument("video_id")

    check_video_parser = subparsers.add_parser("check-video", help="Check whether a video has processed evidence and verified report paths.")
    check_video_parser.add_argument("video_id")

    answer_parser = subparsers.add_parser("answer-context", help="Build compact evidence context for an agent answer.")
    answer_parser.add_argument("query")
    answer_parser.add_argument("--video-id")

    environment_parser = subparsers.add_parser("check-environment", help="Check local video pipeline prerequisites before processing.")
    environment_parser.add_argument("--scope", choices=["full", "capture", "download", "transcribe", "transcription", "asr", "visual", "vision", "analyze", "document", "compose-document"], default="full")
    environment_parser.add_argument("--strict", action="store_true", help="Fail transient temp executables such as /tmp/ffmpeg.")
    environment_parser.add_argument("--provider", choices=["whisper", "gemini", "kimi", "api"])
    environment_parser.add_argument("--asr-provider", "--asrProvider", choices=["whisper", "gemini", "kimi", "api"], dest="asr_provider")
    environment_parser.add_argument("--download", choices=["true", "false"])
    environment_parser.add_argument("--probe", choices=["true", "false"])
    environment_parser.add_argument("--keyframes", choices=["true", "false"])
    environment_parser.add_argument("--transcription-script-path")
    environment_parser.add_argument("--script-path")
    environment_parser.add_argument("--python-path")
    environment_parser.add_argument("--auto-keyframe-selection", choices=["true", "false"])
    environment_parser.add_argument("--keyframe-selector-script-path")

    check_cookie_parser = subparsers.add_parser("check-bilibili-cookie", help="Validate the configured local Bilibili cookie without exposing secret values.")
    check_cookie_parser.add_argument("--cookie-file")

    refresh_cookie_parser = subparsers.add_parser("refresh-bilibili-cookie", help="Refresh the local Bilibili cookie through a dedicated browser profile and validate it.")
    refresh_cookie_parser.add_argument("--timeout", default="180")
    refresh_cookie_parser.add_argument("--port")
    refresh_cookie_parser.add_argument("--cookie-file")
    refresh_cookie_parser.add_argument("--profile-dir")
    refresh_cookie_parser.add_argument("--browser")
    refresh_cookie_parser.add_argument("--dry-run", action="store_true")

    sync_parser = subparsers.add_parser("sync-bilibili-favorites", help="Sync Bilibili favorite folders and video URLs.")
    sync_parser.add_argument("--folder-id")
    sync_parser.add_argument("--limit")
    sync_parser.add_argument("--delay-ms")
    sync_parser.add_argument("--resume", choices=["true", "false"], help="Reuse page-level sync cache. Defaults to true in the local capability.")
    sync_parser.add_argument("--no-resume", action="store_true", help="Do not read cached pages during this sync.")
    sync_parser.add_argument("--force-refresh", action="store_true", help="Ignore cached pages and refetch from Bilibili.")
    sync_parser.add_argument("--no-cache", action="store_true", help="Disable sync cache reads and writes for this run.")

    folder_parser = subparsers.add_parser("list-bilibili-favorite-folders", help="List current Bilibili favorite folders and video counts without listing videos.")
    folder_parser.add_argument("--folder-id")

    list_favorites_parser = subparsers.add_parser("list-bilibili-favorites", help="List locally indexed Bilibili favorite videos.")
    list_favorites_parser.add_argument("--source", choices=["official", "partial", "auto"])
    list_favorites_parser.add_argument("--folder-id")
    list_favorites_parser.add_argument("--status")
    list_favorites_parser.add_argument("--limit")
    list_favorites_parser.add_argument("--offset")

    orphan_favorites_parser = subparsers.add_parser("list-bilibili-orphans", help="List local Bilibili video artifacts that are not in the current favorites snapshot.")
    orphan_favorites_parser.add_argument("--source", choices=["official", "partial", "auto"])
    orphan_favorites_parser.add_argument("--status")
    orphan_favorites_parser.add_argument("--limit")
    orphan_favorites_parser.add_argument("--offset")

    search_favorites_parser = subparsers.add_parser("search-bilibili-favorites", help="Search locally indexed Bilibili favorite video metadata.")
    search_favorites_parser.add_argument("query")
    search_favorites_parser.add_argument("--source", choices=["official", "partial", "auto"])
    search_favorites_parser.add_argument("--folder-id")
    search_favorites_parser.add_argument("--status")
    search_favorites_parser.add_argument("--limit")
    search_favorites_parser.add_argument("--offset")

    enqueue_parser = subparsers.add_parser("enqueue-video", help="Add a video URL or BV id to the local ingestion queue.")
    enqueue_parser.add_argument("target", help="Bilibili BV id or source URL.")
    enqueue_parser.add_argument("--title")
    enqueue_parser.add_argument("--priority")
    enqueue_parser.add_argument("--reason")

    process_parser = subparsers.add_parser("process-next", help="Prepare the next queued video for the compiler pipeline.")
    process_parser.add_argument("target", nargs="?", help="Optional Bilibili BV id or source URL to select from the queue.")

    process_full_parser = subparsers.add_parser("process-full", help="Run the full video pipeline and verify final report artifacts.")
    process_full_parser.add_argument("target", nargs="?", help="Optional Bilibili BV id or source URL to select from the queue.")
    process_full_parser.add_argument("--download", choices=["true", "false"])
    process_full_parser.add_argument("--probe", choices=["true", "false"])
    process_full_parser.add_argument("--keyframes", choices=["true", "false"])
    process_full_parser.add_argument("--frame-interval-seconds")
    process_full_parser.add_argument("--max-frames")
    process_full_parser.add_argument("--whisper", choices=["true", "false"])
    process_full_parser.add_argument("--provider", choices=["whisper", "gemini", "kimi", "api"])
    process_full_parser.add_argument("--asr-provider", "--asrProvider", choices=["whisper", "gemini", "kimi", "api"], dest="asr_provider")
    process_full_parser.add_argument("--transcription-script-path")
    process_full_parser.add_argument("--script-path")
    process_full_parser.add_argument("--python-path")
    process_full_parser.add_argument("--endpoint", choices=["vertex-standard", "vertex-express", "developer"])
    process_full_parser.add_argument("--model")
    process_full_parser.add_argument("--language")
    process_full_parser.add_argument("--auto-keyframe-selection", choices=["true", "false"])
    process_full_parser.add_argument("--keyframe-preset", choices=["semantic-tight", "tight", "balanced", "semantic"])
    process_full_parser.add_argument("--force", action="store_true", help="Force stages such as ASR to replace stale or invalid artifacts.")
    process_full_parser.add_argument("--force-keyframe-selection", action="store_true")

    folder_process_parser = subparsers.add_parser("process-folder-missing-reports", help="Process a Bilibili favorites folder one video at a time, skipping verified reports.")
    folder_process_parser.add_argument("folder", nargs="?", help="Favorite folder name or id.")
    folder_process_parser.add_argument("--folder-id")
    folder_process_parser.add_argument("--source", choices=["official", "partial", "auto"])
    folder_process_parser.add_argument("--status")
    folder_process_parser.add_argument("--one-by-one", action="store_true", help="Required; process one video at a time.")
    folder_process_parser.add_argument("--max-videos", type=int)
    folder_process_parser.add_argument("--page-size", type=int, default=500)
    folder_process_parser.add_argument("--progress-file")
    folder_process_parser.add_argument("--dry-run", action="store_true")
    folder_process_parser.add_argument("--continue-on-error", action="store_true", help="Deprecated; superseded by --max-consecutive-failures (default 3) which continues by default and only stops on a streak of failures.")
    folder_process_parser.add_argument("--max-consecutive-failures", type=int, default=3, help="Stop after this many consecutive failed/blocked videos (0 disables this guard).")
    folder_process_parser.add_argument("--stop-on-first-error", action="store_true", help="Stop on the first failure instead of using the consecutive-failure guard.")
    folder_process_parser.add_argument("--download", choices=["true", "false"])
    folder_process_parser.add_argument("--probe", choices=["true", "false"])
    folder_process_parser.add_argument("--keyframes", choices=["true", "false"])
    folder_process_parser.add_argument("--frame-interval-seconds")
    folder_process_parser.add_argument("--max-frames")
    folder_process_parser.add_argument("--whisper", choices=["true", "false"])
    folder_process_parser.add_argument("--provider", choices=["whisper", "gemini", "kimi", "api"])
    folder_process_parser.add_argument("--asr-provider", "--asrProvider", choices=["whisper", "gemini", "kimi", "api"], dest="asr_provider")
    folder_process_parser.add_argument("--transcription-script-path")
    folder_process_parser.add_argument("--script-path")
    folder_process_parser.add_argument("--python-path")
    folder_process_parser.add_argument("--endpoint", choices=["vertex-standard", "vertex-express", "developer"])
    folder_process_parser.add_argument("--model")
    folder_process_parser.add_argument("--language")
    folder_process_parser.add_argument("--auto-keyframe-selection", choices=["true", "false"])
    folder_process_parser.add_argument("--keyframe-preset", choices=["semantic-tight", "tight", "balanced", "semantic"])
    folder_process_parser.add_argument("--force-keyframe-selection", action="store_true")

    capture_parser = subparsers.add_parser("capture-local", help="Download/probe/extract screenshots for a prepared video.")
    capture_parser.add_argument("target", nargs="?", help="Optional Bilibili BV id or source URL to select from the prepared queue.")
    capture_parser.add_argument("--video-path")
    capture_parser.add_argument("--download", choices=["true", "false"])
    capture_parser.add_argument("--probe", choices=["true", "false"])
    capture_parser.add_argument("--keyframes", choices=["true", "false"])
    capture_parser.add_argument("--frame-interval-seconds")
    capture_parser.add_argument("--max-frames")

    transcribe_parser = subparsers.add_parser("transcribe-local", help="Run Whisper/API ASR or index existing transcript files for a captured video.")
    transcribe_parser.add_argument("target", nargs="?", help="Optional Bilibili BV id or source URL to select from the captured queue.")
    transcribe_parser.add_argument("--video-path")
    transcribe_parser.add_argument("--whisper", choices=["true", "false"])
    transcribe_parser.add_argument("--provider", choices=["whisper", "gemini", "kimi", "api"])
    transcribe_parser.add_argument("--asr-provider", "--asrProvider", choices=["whisper", "gemini", "kimi", "api"], dest="asr_provider")
    transcribe_parser.add_argument("--transcription-script-path")
    transcribe_parser.add_argument("--python-path")
    transcribe_parser.add_argument("--model")
    transcribe_parser.add_argument("--endpoint", choices=["vertex-standard", "vertex-express", "developer"])
    transcribe_parser.add_argument("--project")
    transcribe_parser.add_argument("--location")
    transcribe_parser.add_argument("--language")
    transcribe_parser.add_argument("--chunk-seconds")
    transcribe_parser.add_argument("--max-chunks")
    transcribe_parser.add_argument("--api-key-env")
    transcribe_parser.add_argument("--api-key-file-path")
    transcribe_parser.add_argument("--task", choices=["transcribe", "translate"])
    transcribe_parser.add_argument("--force", action="store_true")
    transcribe_parser.add_argument("--dry-run", action="store_true")

    visual_parser = subparsers.add_parser("analyze-visual", help="Run Gemini keyframe or clip visual analysis for a captured video.")
    visual_parser.add_argument("target", nargs="?", help="Optional Bilibili BV id or source URL to select from the captured queue.")
    visual_parser.add_argument("--video-path")
    visual_parser.add_argument("--script-path")
    visual_parser.add_argument("--python-path")
    visual_parser.add_argument("--mode", choices=["keyframes", "clips"], default="keyframes")
    visual_parser.add_argument("--endpoint", choices=["vertex-standard", "vertex-express", "developer"])
    visual_parser.add_argument("--model")
    visual_parser.add_argument("--project")
    visual_parser.add_argument("--location")
    visual_parser.add_argument("--segment-seconds")
    visual_parser.add_argument("--frame-interval")
    visual_parser.add_argument("--max-segments")
    visual_parser.add_argument("--sleep-seconds")
    visual_parser.add_argument("--api-key-env")
    visual_parser.add_argument("--api-key-file-path")
    visual_parser.add_argument("--force", action="store_true")
    visual_parser.add_argument("--dry-run", action="store_true")

    compose_parser = subparsers.add_parser("compose-bundle", help="Compose transcript and visual evidence into searchable bundles.")
    compose_parser.add_argument("target", nargs="?", help="Optional Bilibili BV id or source URL to select from the visual-analyzed queue.")
    compose_parser.add_argument("--visual-summary-path")
    compose_parser.add_argument("--transcript-text-path")

    document_parser = subparsers.add_parser("compose-document", help="Compose a human-facing video report plus a timestamped evidence document.")
    document_parser.add_argument("target", nargs="?", help="Optional Bilibili BV id or source URL to select from the composed queue.")
    document_parser.add_argument("--video-path")
    document_parser.add_argument("--bundle-path")
    document_parser.add_argument("--transcript-text-path")
    document_parser.add_argument("--document-path")
    document_parser.add_argument("--report-path")
    document_parser.add_argument("--evidence-path")
    document_parser.add_argument("--document-manifest-path")
    document_parser.add_argument("--document-assets-dir")
    document_parser.add_argument("--document-variant")
    document_parser.add_argument("--experimental", action="store_true")
    document_parser.add_argument("--keyframe-manifest-path")
    document_parser.add_argument("--auto-keyframe-selection", choices=["true", "false"])
    document_parser.add_argument("--keyframe-preset", choices=["semantic-tight", "tight", "balanced", "semantic"])
    document_parser.add_argument("--visual-summary-path")
    document_parser.add_argument("--keyframe-selector-script-path")
    document_parser.add_argument("--semantic-min-score")
    document_parser.add_argument("--max-frames-per-minute")
    document_parser.add_argument("--force-keyframe-selection", action="store_true")

    fetch_comments_parser = subparsers.add_parser("fetch-comments", help="Fetch Bilibili video comments and apply rule-based curation. Writes comments.raw.json + comments.curated.json into the video work-dir. No LLM calls.")
    fetch_comments_parser.add_argument("target", help="BV id (e.g. BV12o63B5EFd) or full bilibili URL")
    fetch_comments_parser.add_argument("--video-root", help="Path to video root; defaults to VIDEO_KNOWLEDGE_VIDEO_ROOT or known local paths.")
    fetch_comments_parser.add_argument("--cookie-file", help="Bilibili cookie file path; defaults to BILIBILI_COOKIE_FILE or connector config.")
    fetch_comments_parser.add_argument("--main-count", help="Number of main comments to fetch (default 30)")
    fetch_comments_parser.add_argument("--sub-count", help="Max sub-replies per main comment (default 20)")
    fetch_comments_parser.add_argument("--sort", choices=["0", "1", "2"], help="0=time, 1=likes, 2=hotness (default 2)")
    fetch_comments_parser.add_argument("--min-likes", help="High-likes filter threshold (default 5)")
    fetch_comments_parser.add_argument("--delay-ms", help="Delay between API calls (default 1200)")
    fetch_comments_parser.add_argument("--no-anonymize", action="store_true", help="Keep usernames in curated output (default: anonymize, only mid kept)")
    fetch_comments_parser.add_argument("--dry-run", action="store_true")

    verify_parser = subparsers.add_parser("verify-and-fix-reports", help="Post-process documented video-report.md files: inject quality warning banner, neutralize unsafe inline code, add chapter confidence badges, patch bundle signal_profile. Default dry-run; pass --write to actually edit reports (with timestamped backups).")
    verify_parser.add_argument("--video-root")
    verify_parser.add_argument("--only", nargs="+", help="Only process these video IDs (e.g. BV12o63B5EFd).")
    verify_parser.add_argument("--write", action="store_true", help="Actually write the patched report.md and bundle.json (with timestamped backups).")

    archive_parser = subparsers.add_parser("archive-processed-videos", help="Reclaim disk space by deleting raw video.mp4 / audio chunks / frame caches for fully documented videos. Defaults to dry-run; pass --write to actually delete.")
    archive_parser.add_argument("--video-root")
    archive_parser.add_argument("--keep-mp4", action="store_true", help="Keep video.mp4 (delete only audio/frame caches).")
    archive_parser.add_argument("--keep-frames", action="store_true", help="Keep keyframe and clip caches.")
    archive_parser.add_argument("--keep-audio-chunks", action="store_true", help="Keep asr/api-audio-chunks/*.mp3 files.")
    archive_parser.add_argument("--write", action="store_true", help="Actually delete the files (default is dry-run).")

    retry_parser = subparsers.add_parser("retry-failed-videos", help="Re-run process-full on videos that list-quality-issues flags as failed/partial; uses force=true and stops after a streak of consecutive failures.")
    retry_parser.add_argument("--video-root", help="Path to video root; defaults to VIDEO_KNOWLEDGE_VIDEO_ROOT env or known local paths.")
    retry_parser.add_argument("--only", nargs="+", help="Filter to records whose issueTypes include any of these (e.g. asr_failed visual_partial report_too_small). Default: all flagged.")
    retry_parser.add_argument("--max-videos", type=int)
    retry_parser.add_argument("--max-consecutive-failures", type=int, default=3, help="Stop after this many consecutive failed/blocked retries (0 disables).")
    retry_parser.add_argument("--progress-file")
    retry_parser.add_argument("--dry-run", action="store_true")
    retry_parser.add_argument("--provider", choices=["whisper", "gemini", "kimi", "api"])
    retry_parser.add_argument("--endpoint", choices=["vertex-standard", "vertex-express", "developer"])
    retry_parser.add_argument("--model")
    retry_parser.add_argument("--language")

    rebuild_parser = subparsers.add_parser("rebuild-index", help="Scan video root and rebuild _collections/processed-video-index.json from filesystem state. Defaults to dry-run; pass --write to overwrite the index (with timestamped backup).")
    rebuild_parser.add_argument("--video-root", help="Path to video root; defaults to VIDEO_KNOWLEDGE_VIDEO_ROOT env or known local paths.")
    rebuild_parser.add_argument("--write", action="store_true", help="Write the rebuilt index (the existing file is backed up first). Without --write the command only reports what would change.")

    quality_parser = subparsers.add_parser("list-quality-issues", help="Scan video root and list videos with ASR/visual/report quality issues.")
    quality_parser.add_argument("--video-root", help="Path to video root; defaults to VIDEO_KNOWLEDGE_VIDEO_ROOT env or known local paths.")
    quality_parser.add_argument("--min-coverage", type=float, default=0.30, help="ASR coverage ratio below which a successful transcript is still flagged.")
    quality_parser.add_argument("--min-report-size", type=int, default=5000, help="Report size in bytes below which the report is flagged as too small.")
    quality_parser.add_argument("--only", nargs="+", help="Filter to records with these issue types (e.g. asr_failed visual_partial report_too_small).")

    login_parser = subparsers.add_parser("login-bilibili", help="Alias for refresh-bilibili-cookie; opens a dedicated browser profile and saves cookies.")
    login_parser.add_argument("--timeout", default="180")
    login_parser.add_argument("--port")
    login_parser.add_argument("--cookie-file")
    login_parser.add_argument("--profile-dir")
    login_parser.add_argument("--browser")
    login_parser.add_argument("--dry-run", action="store_true")

    args = parser.parse_args(argv)

    try:
        if args.command == "ensure":
            emit(ensure_local_server(args.base_url, Path(args.repo)))
        elif args.command == "tools":
            emit(ensure_local_server(args.base_url, Path(args.repo)))
        elif args.command == "search":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(search(args.base_url, args.query, args.video_id))
        elif args.command == "get":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(get_bundle(args.base_url, args.video_id))
        elif args.command == "check-video":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(check_processed_video(args.base_url, args.video_id))
        elif args.command == "answer-context":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(build_answer_context(args.base_url, args.query, args.video_id))
        elif args.command == "check-environment":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(check_environment(
                args.base_url,
                args.scope,
                args.strict,
                args.provider,
                args.asr_provider,
                args.download,
                args.probe,
                args.keyframes,
                args.transcription_script_path,
                args.script_path,
                args.python_path,
                args.auto_keyframe_selection,
                args.keyframe_selector_script_path,
            ))
        elif args.command == "check-bilibili-cookie":
            emit(check_bilibili_cookie(Path(args.repo), args.cookie_file))
        elif args.command == "refresh-bilibili-cookie":
            result = refresh_bilibili_cookie(
                Path(args.repo),
                args.timeout,
                args.port,
                args.dry_run,
                args.cookie_file,
                args.profile_dir,
                args.browser,
            )
            emit(result)
            return 0 if result.get("ok") else 1
        elif args.command == "sync-bilibili-favorites":
            ensure_local_server(args.base_url, Path(args.repo))
            resume = "false" if args.no_resume else args.resume
            cache = "false" if args.no_cache else None
            emit(sync_bilibili_favorites(args.base_url, args.folder_id, args.limit, args.delay_ms, resume, args.force_refresh, cache))
        elif args.command == "list-bilibili-favorite-folders":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(list_bilibili_favorite_folders(args.base_url, args.folder_id))
        elif args.command == "list-bilibili-favorites":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(list_bilibili_favorites(args.base_url, args.source, args.folder_id, args.status, args.limit, args.offset))
        elif args.command == "list-bilibili-orphans":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(list_bilibili_favorite_orphans(args.base_url, args.source, args.status, args.limit, args.offset))
        elif args.command == "search-bilibili-favorites":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(search_bilibili_favorites(args.base_url, args.query, args.source, args.folder_id, args.status, args.limit, args.offset))
        elif args.command == "enqueue-video":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(enqueue_video_ingest(args.base_url, args.target, args.title, args.priority, args.reason))
        elif args.command == "process-next":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(process_next_video_ingest(args.base_url, args.target))
        elif args.command == "process-full":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(process_full_video_ingest(
                args.base_url,
                args.target,
                args.download,
                args.probe,
                args.keyframes,
                args.frame_interval_seconds,
                args.max_frames,
                args.whisper,
                args.provider,
                args.asr_provider,
                args.transcription_script_path,
                args.script_path,
                args.python_path,
                args.endpoint,
                args.model,
                args.language,
                args.auto_keyframe_selection,
                args.keyframe_preset,
                args.force,
                args.force_keyframe_selection,
            ))
        elif args.command == "process-folder-missing-reports":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(process_folder_missing_reports(
                args.base_url,
                args.folder,
                args.folder_id,
                args.source,
                args.status,
                args.one_by_one,
                args.max_videos,
                args.page_size,
                args.progress_file,
                args.dry_run,
                args.continue_on_error,
                args.download,
                args.probe,
                args.keyframes,
                args.frame_interval_seconds,
                args.max_frames,
                args.whisper,
                args.provider,
                args.asr_provider,
                args.transcription_script_path,
                args.script_path,
                args.python_path,
                args.endpoint,
                args.model,
                args.language,
                args.auto_keyframe_selection,
                args.keyframe_preset,
                args.force_keyframe_selection,
                args.max_consecutive_failures,
                args.stop_on_first_error,
            ))
        elif args.command == "capture-local":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(capture_local_video_ingest(
                args.base_url,
                args.target,
                args.video_path,
                args.download,
                args.probe,
                args.keyframes,
                args.frame_interval_seconds,
                args.max_frames,
            ))
        elif args.command == "transcribe-local":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(transcribe_local_video_ingest(
                args.base_url,
                args.target,
                args.video_path,
                args.whisper,
                args.provider,
                args.asr_provider,
                args.transcription_script_path,
                args.python_path,
                args.model,
                args.endpoint,
                args.project,
                args.location,
                args.language,
                args.chunk_seconds,
                args.max_chunks,
                args.api_key_env,
                args.api_key_file_path,
                args.task,
                args.force,
                args.dry_run,
            ))
        elif args.command == "analyze-visual":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(analyze_visual_video_ingest(
                args.base_url,
                args.target,
                args.video_path,
                args.script_path,
                args.python_path,
                args.mode,
                args.endpoint,
                args.model,
                args.project,
                args.location,
                args.segment_seconds,
                args.frame_interval,
                args.max_segments,
                args.sleep_seconds,
                args.api_key_env,
                args.api_key_file_path,
                args.force,
                args.dry_run,
            ))
        elif args.command == "compose-bundle":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(compose_video_evidence_bundle(
                args.base_url,
                args.target,
                args.visual_summary_path,
                args.transcript_text_path,
            ))
        elif args.command == "compose-document":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(compose_video_evidence_document(
                args.base_url,
                args.target,
                args.video_path,
                args.bundle_path,
                args.transcript_text_path,
                args.document_path,
                args.report_path,
                args.evidence_path,
                args.document_manifest_path,
                args.document_assets_dir,
                args.document_variant,
                args.experimental,
                args.keyframe_manifest_path,
                args.auto_keyframe_selection,
                args.keyframe_preset,
                args.visual_summary_path,
                args.keyframe_selector_script_path,
                args.semantic_min_score,
                args.max_frames_per_minute,
                args.force_keyframe_selection,
            ))
        elif args.command == "fetch-comments":
            video_id = extract_bv_id(args.target) or args.target
            video_root = resolve_video_root(args.video_root)
            work_dir = video_root / video_id
            cookie_file = resolve_cookie_file(args.cookie_file)
            emit(fetch_comments_local(
                video_id=video_id,
                work_dir=str(work_dir),
                cookie_file=cookie_file,
                main_count=args.main_count,
                sub_count=args.sub_count,
                sort=args.sort,
                delay_ms=args.delay_ms,
                min_likes=args.min_likes,
                no_anonymize=args.no_anonymize,
                dry_run=args.dry_run,
            ))
        elif args.command == "verify-and-fix-reports":
            emit(verify_and_fix_reports(
                resolve_video_root(args.video_root),
                write=args.write,
                only_videos=args.only,
            ))
        elif args.command == "archive-processed-videos":
            emit(archive_processed_videos(
                resolve_video_root(args.video_root),
                keep_mp4=args.keep_mp4,
                keep_frames=args.keep_frames,
                keep_audio_chunks=args.keep_audio_chunks,
                write=args.write,
            ))
        elif args.command == "retry-failed-videos":
            ensure_local_server(args.base_url, Path(args.repo))
            emit(retry_failed_videos(
                args.base_url,
                resolve_video_root(args.video_root),
                only_types=args.only,
                max_videos=args.max_videos,
                progress_file=args.progress_file,
                dry_run=args.dry_run,
                provider=args.provider,
                endpoint=args.endpoint,
                model=args.model,
                language=args.language,
                max_consecutive_failures=args.max_consecutive_failures,
            ))
        elif args.command == "rebuild-index":
            emit(rebuild_processed_video_index(
                resolve_video_root(args.video_root),
                write=args.write,
            ))
        elif args.command == "list-quality-issues":
            emit(list_quality_issues(
                resolve_video_root(args.video_root),
                min_coverage=args.min_coverage,
                min_report_size=args.min_report_size,
                only=args.only,
            ))
        elif args.command == "login-bilibili":
            result = refresh_bilibili_cookie(
                Path(args.repo),
                args.timeout,
                args.port,
                args.dry_run,
                args.cookie_file,
                args.profile_dir,
                args.browser,
            )
            emit(result)
            return 0 if result.get("ok") else 1
    except VideoKnowledgeError as error:
        emit({"ok": False, "error": str(error)})
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
