#!/usr/bin/env python3
"""Open a local browser for Bilibili login and export API cookies.

This script launches Chrome/Edge with a local debugging port, waits until the
user logs in to Bilibili, reads cookies through the Chrome DevTools Protocol,
and writes a cookie header to the local secret file used by video-knowledge.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_PORT = 9223
LOGIN_URL = "https://passport.bilibili.com/login"
CHECK_URL = "https://www.bilibili.com/"
REQUIRED_COOKIE_NAMES = {"SESSDATA", "bili_jct", "DedeUserID"}
PREFERRED_COOKIE_ORDER = [
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
    "b_nut",
    "CURRENT_FNVAL",
    "rpdid",
]


class BrowserLoginError(RuntimeError):
    pass


WSL_POWERSHELL_CANDIDATES = [
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    "/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe",
]


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def is_wsl() -> bool:
    if sys.platform != "linux":
        return False
    try:
        return "microsoft" in Path("/proc/version").read_text(encoding="utf-8", errors="ignore").lower()
    except OSError:
        return False


def default_secret_path() -> Path:
    value = os.environ.get("BILIBILI_COOKIE_FILE")
    if value:
        return Path(value).expanduser()

    secret_dir = os.environ.get("VIDEO_KNOWLEDGE_SECRET_DIR")
    if secret_dir:
        return Path(secret_dir).expanduser() / "bilibili.cookie.txt"

    if is_wsl():
        windows_user = os.environ.get("USERNAME") or os.environ.get("USER") or "Public"
        return Path(f"/mnt/c/Users/{windows_user}/.video-knowledge/secrets/bilibili.cookie.txt")

    return Path.home() / ".video-knowledge" / "secrets" / "bilibili.cookie.txt"


def default_profile_dir() -> Path:
    value = os.environ.get("BILIBILI_LOGIN_PROFILE_DIR")
    if value:
        return Path(value).expanduser()

    secret_dir = os.environ.get("VIDEO_KNOWLEDGE_SECRET_DIR")
    if secret_dir:
        return Path(secret_dir).expanduser() / "bilibili-browser-profile"

    if is_wsl():
        windows_user = os.environ.get("USERNAME") or os.environ.get("USER") or "Public"
        return Path(f"/mnt/c/Users/{windows_user}/.video-knowledge/secrets/bilibili-browser-profile")

    return Path.home() / ".video-knowledge" / "secrets" / "bilibili-browser-profile"


def windows_path(path: Path) -> str:
    text = str(path)
    if is_wsl() and text.startswith("/mnt/") and len(text) > 6:
        drive = text[5].upper()
        rest = text[6:].replace("/", "\\")
        return f"{drive}:\\{rest}"
    return text


def find_windows_browser(explicit: str | None = None) -> str:
    if explicit:
        return explicit

    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]

    if is_wsl():
        candidates = [f"/mnt/c/{candidate[3:].replace(chr(92), '/')}" for candidate in candidates]

    for candidate in candidates:
        if Path(candidate).exists():
            return candidate

    raise BrowserLoginError("Chrome or Edge was not found.")


def find_wsl_powershell() -> str | None:
    for command in ("powershell.exe", "powershell"):
        resolved = shutil.which(command)
        if resolved:
            return resolved

    for candidate in WSL_POWERSHELL_CANDIDATES:
        if Path(candidate).exists():
            return candidate

    return None


def powershell_single_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_wsl_launch_script(browser: str, args: list[str]) -> str:
    browser_args = ",\n".join(f"  {powershell_single_quote(arg)}" for arg in args[1:])
    return "\n".join([
        "$ErrorActionPreference = 'Stop'",
        f"$browser = {powershell_single_quote(windows_path(Path(browser)))}",
        "$browserArgs = @(",
        browser_args,
        ")",
        "$process = Start-Process -FilePath $browser -ArgumentList $browserArgs -PassThru",
        "[pscustomobject]@{ Id = $process.Id; Path = $browser; ArgumentCount = $browserArgs.Count } | ConvertTo-Json -Compress",
    ])


def launch_wsl_browser(browser: str, args: list[str]) -> dict[str, Any]:
    powershell = find_wsl_powershell()

    if powershell:
        script = build_wsl_launch_script(browser, args)
        encoded_script = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        command = [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded_script,
        ]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=15)
        if completed.returncode != 0:
            raise BrowserLoginError(
                "Cannot launch Windows browser through PowerShell: "
                f"{completed.stderr.strip() or completed.stdout.strip() or 'unknown error'}"
            )

        launch_info: dict[str, Any] = {}
        stdout = completed.stdout.strip()
        if stdout:
            try:
                parsed = json.loads(stdout)
                if isinstance(parsed, dict):
                    launch_info = parsed
            except json.JSONDecodeError:
                launch_info = {"stdout": stdout}
        return {"launchedVia": powershell, "browser": browser, "process": launch_info}

    try:
        process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"launchedVia": "direct-windows-exe", "pid": process.pid, "browser": browser}
    except OSError as error:
        raise BrowserLoginError(
            "Cannot launch a Windows browser from WSL. Tried powershell.exe, "
            f"{', '.join(WSL_POWERSHELL_CANDIDATES)}, and direct browser execution. "
            "Enable WSL Windows interop or set --browser to a reachable Chrome/Edge path."
        ) from error


def launch_browser(browser: str, profile_dir: Path, port: int) -> dict[str, Any]:
    profile_dir.mkdir(parents=True, exist_ok=True)
    args = [
        browser,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={windows_path(profile_dir)}",
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        LOGIN_URL,
    ]

    if is_wsl():
        args.insert(2, "--remote-debugging-address=0.0.0.0")
        launched = launch_wsl_browser(browser, args)
        return {**launched, "profileDir": str(profile_dir), "port": port}

    process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"pid": process.pid, "browser": browser, "profileDir": str(profile_dir), "port": port}


def http_json(url: str, timeout: float = 2) -> Any:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise BrowserLoginError(f"Cannot read {url}: {error}") from error


def devtools_host_candidates() -> list[str]:
    hosts: list[str] = []
    configured = os.environ.get("BILIBILI_DEVTOOLS_HOST") or os.environ.get("CHROME_DEVTOOLS_HOST")

    if configured:
        hosts.extend(host.strip() for host in configured.split(",") if host.strip())

    if is_wsl():
        try:
            for line in Path("/etc/resolv.conf").read_text(encoding="utf-8", errors="ignore").splitlines():
                parts = line.strip().split()
                if len(parts) >= 2 and parts[0] == "nameserver":
                    hosts.append(parts[1])
        except OSError:
            pass

        try:
            route = subprocess.check_output(["ip", "route", "show", "default"], text=True, timeout=2)
            parts = route.split()
            if "via" in parts:
                hosts.append(parts[parts.index("via") + 1])
        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
            pass

    hosts.extend(["127.0.0.1", "localhost"])

    unique_hosts: list[str] = []
    seen: set[str] = set()
    for host in hosts:
        if host and host not in seen:
            unique_hosts.append(host)
            seen.add(host)
    return unique_hosts


def wait_for_devtools(port: int, timeout: float) -> dict[str, Any]:
    deadline = time.time() + timeout
    errors: dict[str, str] = {}
    hosts = devtools_host_candidates()

    while time.time() < deadline:
        for host in hosts:
            try:
                return {
                    "host": host,
                    "version": http_json(f"http://{host}:{port}/json/version"),
                    "triedHosts": hosts,
                }
            except BrowserLoginError as error:
                errors[host] = str(error)
        time.sleep(0.5)

    raise BrowserLoginError(f"Browser DevTools endpoint did not become ready on port {port}. Tried hosts: {errors}")


def list_targets(port: int, host: str) -> list[dict[str, Any]]:
    targets = http_json(f"http://{host}:{port}/json")
    if not isinstance(targets, list):
        raise BrowserLoginError("DevTools target list returned an unexpected shape.")
    return [target for target in targets if isinstance(target, dict)]


def rewrite_ws_url_host(ws_url: str, host: str) -> str:
    parsed = urllib.parse.urlparse(ws_url)

    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        return ws_url

    netloc = f"{host}:{parsed.port}" if parsed.port else host
    if ":" in host and not host.startswith("["):
        netloc = f"[{host}]:{parsed.port}" if parsed.port else f"[{host}]"
    return urllib.parse.urlunparse((
        parsed.scheme,
        netloc,
        parsed.path,
        parsed.params,
        parsed.query,
        parsed.fragment,
    ))


def choose_target(port: int, host: str) -> str:
    targets = list_targets(port, host)
    for target in targets:
        url = str(target.get("url", ""))
        ws_url = target.get("webSocketDebuggerUrl")
        if isinstance(ws_url, str) and ("bilibili.com" in url or target.get("type") == "page"):
            return rewrite_ws_url_host(ws_url, host)
    raise BrowserLoginError("No debuggable browser page was found.")


def read_until(sock: socket.socket, marker: bytes) -> bytes:
    data = bytearray()
    while marker not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data.extend(chunk)
    return bytes(data)


def read_exact(sock: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise BrowserLoginError("WebSocket connection closed unexpectedly.")
        data.extend(chunk)
    return bytes(data)


def send_ws_text(sock: socket.socket, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    header = bytearray([0x81])
    length = len(body)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.extend([0x80 | 126, (length >> 8) & 0xFF, length & 0xFF])
    else:
        header.append(0x80 | 127)
        header.extend(length.to_bytes(8, "big"))

    mask = secrets.token_bytes(4)
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(body))
    sock.sendall(bytes(header) + mask + masked)


def read_ws_text(sock: socket.socket) -> dict[str, Any]:
    while True:
        first, second = read_exact(sock, 2)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = int.from_bytes(read_exact(sock, 2), "big")
        elif length == 127:
            length = int.from_bytes(read_exact(sock, 8), "big")

        mask = read_exact(sock, 4) if masked else b""
        payload = read_exact(sock, length)
        if masked:
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))

        if opcode == 0x8:
            raise BrowserLoginError("WebSocket closed by browser.")
        if opcode == 0x9:
            continue
        if opcode != 0x1:
            continue

        parsed = json.loads(payload.decode("utf-8"))
        if isinstance(parsed, dict):
            return parsed


def cdp_command(ws_url: str, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(ws_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "wss" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    raw_sock = socket.create_connection((host, port), timeout=5)
    sock: socket.socket
    if parsed.scheme == "wss":
        sock = ssl.create_default_context().wrap_socket(raw_sock, server_hostname=host)
    else:
        sock = raw_sock

    try:
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(handshake.encode("ascii"))
        response = read_until(sock, b"\r\n\r\n")
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise BrowserLoginError(f"WebSocket handshake failed: {response[:120]!r}")

        command_id = 1
        send_ws_text(sock, {"id": command_id, "method": method, "params": params or {}})
        while True:
            message = read_ws_text(sock)
            if message.get("id") == command_id:
                if "error" in message:
                    raise BrowserLoginError(f"CDP command {method} failed: {message['error']}")
                return message.get("result", {})
    finally:
        sock.close()


def cookie_domain_matches(cookie: dict[str, Any]) -> bool:
    domain = str(cookie.get("domain", "")).lower()
    return "bilibili.com" in domain


def build_cookie_header(cookies: list[dict[str, Any]]) -> str:
    values: dict[str, str] = {}
    for cookie in cookies:
        if not cookie_domain_matches(cookie):
            continue
        name = cookie.get("name")
        value = cookie.get("value")
        if isinstance(name, str) and isinstance(value, str) and value:
            values[name] = value

    ordered_names = [name for name in PREFERRED_COOKIE_ORDER if name in values]
    ordered_names.extend(sorted(name for name in values if name not in set(ordered_names)))
    return "; ".join(f"{name}={values[name]}" for name in ordered_names)


def missing_required_cookie_names(cookie_header: str) -> list[str]:
    present = {part.split("=", 1)[0].strip() for part in cookie_header.split(";") if "=" in part}
    return sorted(REQUIRED_COOKIE_NAMES - present)


def get_bilibili_cookies(port: int, host: str) -> str:
    ws_url = choose_target(port, host)
    result = cdp_command(ws_url, "Network.getAllCookies")
    cookies = result.get("cookies")
    if not isinstance(cookies, list):
        raise BrowserLoginError("CDP did not return a cookie list.")
    return build_cookie_header([cookie for cookie in cookies if isinstance(cookie, dict)])


def wait_for_login_cookie(port: int, host: str, timeout: float) -> str:
    deadline = time.time() + timeout
    last_missing: list[str] = sorted(REQUIRED_COOKIE_NAMES)

    while time.time() < deadline:
        try:
            header = get_bilibili_cookies(port, host)
            last_missing = missing_required_cookie_names(header)
            if not last_missing:
                return header
        except BrowserLoginError:
            pass
        time.sleep(2)

    raise BrowserLoginError(f"Bilibili login was not detected before timeout. Missing cookies: {last_missing}")


def write_cookie_file(path: Path, cookie_header: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(cookie_header.strip() + "\n", encoding="utf-8")


def run_self_test() -> dict[str, Any]:
    sample = [
        {"domain": ".bilibili.com", "name": "bili_jct", "value": "csrf"},
        {"domain": ".example.com", "name": "SESSDATA", "value": "wrong"},
        {"domain": ".bilibili.com", "name": "SESSDATA", "value": "session"},
        {"domain": ".bilibili.com", "name": "DedeUserID", "value": "42"},
    ]
    header = build_cookie_header(sample)
    missing = missing_required_cookie_names(header)
    if missing:
        raise BrowserLoginError(f"Self-test failed; missing cookies: {missing}")
    if "wrong" in header or not header.startswith("SESSDATA=session; bili_jct=csrf; DedeUserID=42"):
        raise BrowserLoginError(f"Self-test failed; unexpected header: {header}")
    return {"ok": True, "cookieHeaderPreview": header}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Launch browser login and save Bilibili cookies locally.")
    parser.add_argument("--browser", help="Chrome/Edge executable path")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--cookie-file", type=Path, default=default_secret_path())
    parser.add_argument("--profile-dir", type=Path, default=default_profile_dir())
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.self_test:
            emit(run_self_test())
            return 0

        browser = find_windows_browser(args.browser)
        cookie_file = args.cookie_file.expanduser()
        profile_dir = args.profile_dir.expanduser()

        if args.dry_run:
            emit({
                "ok": True,
                "dryRun": True,
                "browser": browser,
                "profileDir": str(profile_dir),
                "cookieFile": str(cookie_file),
                "port": args.port,
                "devtoolsHosts": devtools_host_candidates(),
                "loginUrl": LOGIN_URL,
            })
            return 0

        launched = launch_browser(browser, profile_dir, args.port)
        devtools = wait_for_devtools(args.port, timeout=20)
        cookie_header = wait_for_login_cookie(args.port, devtools["host"], timeout=args.timeout)
        write_cookie_file(cookie_file, cookie_header)

        emit({
            "ok": True,
            "cookieFile": str(cookie_file),
            "profileDir": str(profile_dir),
            "browser": browser,
            "devtools": devtools,
            "cookieNames": [part.split("=", 1)[0].strip() for part in cookie_header.split(";") if "=" in part],
            "launched": launched,
            "nextCommand": "python {baseDir}/scripts/video_knowledge.py sync-bilibili-favorites --limit 200",
        })
        return 0
    except BrowserLoginError as error:
        emit({"ok": False, "error": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
