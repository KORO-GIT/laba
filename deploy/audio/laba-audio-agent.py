#!/usr/bin/python3
"""Small authenticated Bluetooth/PipeWire control plane for LABA."""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import subprocess
import threading
import time
from collections import defaultdict, deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


LISTEN_ADDRESS = os.environ.get("LABA_AUDIO_LISTEN_ADDRESS", "100.69.168.10")
LISTEN_PORT = int(os.environ.get("LABA_AUDIO_LISTEN_PORT", "1985"))
ALLOWED_CLIENT_IP = os.environ.get("LABA_AUDIO_ALLOWED_CLIENT_IP", "100.68.61.33")
COMMAND_TIMEOUT = 12
MAX_BODY_BYTES = 16 * 1024
MAC_PATTERN = re.compile(r"^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$")
ANSI_PATTERN = re.compile(r"\x1b\[[0-9;]*m")
BLUETOOTH_ACTIONS = {"pair", "trust", "untrust", "connect", "disconnect", "remove"}
PLAYER_ACTIONS = {"play", "pause", "play-pause", "next", "previous", "stop"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOGGER = logging.getLogger("laba-audio-agent")
COMMAND_LOCK = threading.Lock()
SCAN_LOCK = threading.Lock()
SCAN_PROCESS: subprocess.Popen[bytes] | None = None
RATE_LOCK = threading.Lock()
RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)


class AgentError(RuntimeError):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_GATEWAY):
        super().__init__(message)
        self.status = status


def credential(name: str) -> str:
    credentials_directory = os.environ.get("CREDENTIALS_DIRECTORY")
    if not credentials_directory:
        raise RuntimeError("Systemd credentials directory is unavailable")
    value = (Path(credentials_directory) / name).read_text(encoding="utf-8").strip()
    if len(value) < 32:
        raise RuntimeError(f"Credential {name} is too short")
    return value


AUTH_TOKEN = credential("AUDIO_AGENT_TOKEN")


def clean_output(value: str) -> str:
    return ANSI_PATTERN.sub("", value).replace("\r", "").strip()


def run_command(arguments: list[str], timeout: int = COMMAND_TIMEOUT, check: bool = True) -> str:
    try:
        completed = subprocess.run(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired as error:
        raise AgentError("Команда аудіосистеми перевищила час очікування") from error
    output = clean_output(completed.stdout[-32_768:])
    if check and completed.returncode != 0:
        LOGGER.warning("Command failed: %s (%s)", arguments[0], completed.returncode)
        raise AgentError(output or "Команда аудіосистеми завершилася помилкою")
    return output


def parse_key_values(output: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in output.splitlines():
        if ":" not in line:
            continue
        key, value = line.strip().split(":", 1)
        result[key.strip()] = value.strip()
    return result


def parse_bool(value: str | None) -> bool:
    return str(value).strip().lower() == "yes"


def normalize_mac(value: str) -> str:
    mac = unquote(value).strip().upper().replace("-", ":")
    if not MAC_PATTERN.fullmatch(mac):
        raise AgentError("Некоректна Bluetooth-адреса", HTTPStatus.BAD_REQUEST)
    return mac


def bluetooth_adapter() -> dict[str, object]:
    output = run_command(["/usr/bin/bluetoothctl", "show"], check=False)
    if "Controller " not in output:
        return {"available": False, "powered": False, "discovering": False, "pairable": False}
    first_line = next((line.strip() for line in output.splitlines() if line.strip().startswith("Controller ")), "")
    values = parse_key_values(output)
    address = first_line.split()[1] if len(first_line.split()) >= 2 else ""
    return {
        "available": True,
        "address": address,
        "name": values.get("Alias") or values.get("Name") or "Raspberry Pi",
        "powered": parse_bool(values.get("Powered")),
        "discovering": parse_bool(values.get("Discovering")),
        "pairable": parse_bool(values.get("Pairable")),
    }


def bluetooth_devices() -> list[dict[str, object]]:
    output = run_command(["/usr/bin/bluetoothctl", "devices"], check=False)
    discovered: dict[str, str] = {}
    for line in output.splitlines():
        match = re.match(r"^Device\s+([0-9A-Fa-f:]{17})\s+(.+)$", line.strip())
        if match:
            discovered[match.group(1).upper()] = match.group(2).strip()

    devices: list[dict[str, object]] = []
    for address, fallback_name in list(discovered.items())[:64]:
        info = run_command(["/usr/bin/bluetoothctl", "info", address], check=False)
        values = parse_key_values(info)
        uuids = [line.strip() for line in info.splitlines() if line.strip().startswith("UUID:")]
        devices.append({
            "address": address,
            "name": values.get("Alias") or values.get("Name") or fallback_name or address,
            "icon": values.get("Icon") or "audio-card",
            "paired": parse_bool(values.get("Paired")),
            "bonded": parse_bool(values.get("Bonded")),
            "trusted": parse_bool(values.get("Trusted")),
            "connected": parse_bool(values.get("Connected")),
            "audio": any("Audio Sink" in uuid or "0000110b" in uuid.lower() for uuid in uuids),
        })
    devices.sort(key=lambda item: (not item["connected"], not item["paired"], str(item["name"]).lower()))
    return devices


def pipewire_status() -> dict[str, object]:
    output = run_command(["/usr/bin/wpctl", "status", "-n"], check=False)
    available = "PipeWire" in output and "Audio" in output
    sinks: list[dict[str, object]] = []
    in_sinks = False
    for raw_line in output.splitlines():
        line = raw_line.rstrip()
        if "Sinks:" in line:
            in_sinks = True
            continue
        if in_sinks and ("Sources:" in line or "Filters:" in line or line.strip() == "Video"):
            in_sinks = False
        if not in_sinks:
            continue
        match = re.match(r"^[\s│├└─]*(\*)?\s*(\d+)\.\s+(.+?)(?:\s+\[vol:.*)?$", line)
        if not match:
            continue
        sinks.append({
            "id": int(match.group(2)),
            "name": match.group(3).strip(),
            "default": bool(match.group(1)),
        })

    volume_output = run_command(["/usr/bin/wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"], check=False)
    volume_match = re.search(r"Volume:\s*([0-9.]+)", volume_output)
    return {
        "available": available,
        "sinks": sinks,
        "defaultSinkId": next((sink["id"] for sink in sinks if sink["default"]), None),
        "volume": round(float(volume_match.group(1)) * 100) if volume_match else None,
        "muted": "[MUTED]" in volume_output,
    }


def player_status() -> dict[str, object]:
    if not Path("/usr/bin/playerctl").exists():
        return {"available": False, "status": "Stopped", "player": None, "title": None, "artist": None}
    template = "{{playerName}}\t{{status}}\t{{xesam:title}}\t{{xesam:artist}}"
    output = run_command(["/usr/bin/playerctl", "-a", "metadata", "--format", template], check=False)
    line = next((item for item in output.splitlines() if item.strip()), "")
    if not line:
        return {"available": False, "status": "Stopped", "player": None, "title": None, "artist": None}
    parts = (line.split("\t") + ["", "", "", ""])[:4]
    return {
        "available": True,
        "player": parts[0] or None,
        "status": parts[1] or "Stopped",
        "title": parts[2] or None,
        "artist": parts[3] or None,
    }


def full_status() -> dict[str, object]:
    with COMMAND_LOCK:
        return {
            "version": 1,
            "adapter": bluetooth_adapter(),
            "devices": bluetooth_devices(),
            "audio": pipewire_status(),
            "player": player_status(),
        }


def set_power(enabled: bool) -> None:
    global SCAN_PROCESS
    if not enabled:
        with SCAN_LOCK:
            if SCAN_PROCESS and SCAN_PROCESS.poll() is None:
                SCAN_PROCESS.terminate()
            SCAN_PROCESS = None
    with COMMAND_LOCK:
        output = run_command(["/usr/bin/bluetoothctl", "power", "on" if enabled else "off"])
    if "blocked" in output.lower():
        raise AgentError("Bluetooth заблоковано rfkill; потрібне втручання адміністратора")


def start_scan(seconds: int) -> None:
    global SCAN_PROCESS
    seconds = max(5, min(30, seconds))
    adapter = bluetooth_adapter()
    if not adapter.get("powered"):
        raise AgentError("Спочатку увімкніть Bluetooth", HTTPStatus.CONFLICT)
    with SCAN_LOCK:
        if SCAN_PROCESS and SCAN_PROCESS.poll() is None:
            SCAN_PROCESS.terminate()
        SCAN_PROCESS = subprocess.Popen(
            ["/usr/bin/bluetoothctl", "--timeout", str(seconds), "scan", "on"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=os.environ.copy(),
        )


def stop_scan() -> None:
    global SCAN_PROCESS
    with SCAN_LOCK:
        if SCAN_PROCESS and SCAN_PROCESS.poll() is None:
            SCAN_PROCESS.terminate()
        SCAN_PROCESS = None
    run_command(["/usr/bin/bluetoothctl", "scan", "off"], check=False)


def device_action(address: str, action: str) -> None:
    if action not in BLUETOOTH_ACTIONS:
        raise AgentError("Непідтримувана дія Bluetooth", HTTPStatus.BAD_REQUEST)
    mac = normalize_mac(address)
    with COMMAND_LOCK:
        if action == "pair":
            run_command(
                ["/usr/bin/bluetoothctl", "--timeout", "35", "--agent", "NoInputNoOutput", "pair", mac],
                timeout=40,
            )
            run_command(["/usr/bin/bluetoothctl", "trust", mac])
            run_command(["/usr/bin/bluetoothctl", "connect", mac], timeout=25)
            return
        run_command(["/usr/bin/bluetoothctl", action, mac], timeout=25)


def set_volume(percent: int) -> None:
    percent = max(0, min(100, percent))
    run_command(["/usr/bin/wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", f"{percent / 100:.2f}"])


def set_mute(enabled: bool) -> None:
    run_command(["/usr/bin/wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1" if enabled else "0"])


def set_default_sink(node_id: int) -> None:
    if node_id < 1 or node_id > 1_000_000:
        raise AgentError("Некоректний ідентифікатор аудіовиходу", HTTPStatus.BAD_REQUEST)
    run_command(["/usr/bin/wpctl", "set-default", str(node_id)])


def player_action(action: str) -> None:
    if action not in PLAYER_ACTIONS:
        raise AgentError("Непідтримувана команда програвача", HTTPStatus.BAD_REQUEST)
    if not Path("/usr/bin/playerctl").exists():
        raise AgentError("На Raspberry Pi ще не встановлено сумісний програвач", HTTPStatus.CONFLICT)
    run_command(["/usr/bin/playerctl", "--all-players", action])


def rate_allowed(address: str) -> bool:
    now = time.monotonic()
    with RATE_LOCK:
        bucket = RATE_BUCKETS[address]
        while bucket and bucket[0] < now - 60:
            bucket.popleft()
        if len(bucket) >= 180:
            return False
        bucket.append(now)
        return True


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "LABAAudioAgent/1"
    sys_version = ""

    def log_message(self, format_string: str, *arguments: object) -> None:
        LOGGER.info("%s %s", self.client_address[0], format_string % arguments)

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.end_headers()
        self.wfile.write(body)

    def authenticate(self) -> bool:
        client_ip = self.client_address[0]
        if client_ip != ALLOWED_CLIENT_IP:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "Клієнт не дозволений"})
            return False
        if not rate_allowed(client_ip):
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Забагато запитів"})
            return False
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {AUTH_TOKEN}"
        if not hmac.compare_digest(authorization, expected):
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Невірна авторизація"})
            return False
        return True

    def read_json(self) -> dict[str, object]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise AgentError("Некоректна довжина запиту", HTTPStatus.BAD_REQUEST) from error
        if length < 0 or length > MAX_BODY_BYTES:
            raise AgentError("Запит завеликий", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        if not length:
            return {}
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AgentError("Некоректний JSON", HTTPStatus.BAD_REQUEST) from error
        if not isinstance(value, dict):
            raise AgentError("Очікується JSON-об’єкт", HTTPStatus.BAD_REQUEST)
        return value

    def dispatch(self) -> dict[str, object]:
        path = urlparse(self.path).path
        if self.command == "GET" and path == "/v1/status":
            return full_status()
        if self.command != "POST":
            raise AgentError("Шлях не знайдено", HTTPStatus.NOT_FOUND)

        body = self.read_json()
        if path == "/v1/bluetooth/power":
            enabled = body.get("enabled")
            if not isinstance(enabled, bool):
                raise AgentError("Поле enabled має бути boolean", HTTPStatus.BAD_REQUEST)
            set_power(enabled)
        elif path == "/v1/bluetooth/scan":
            enabled = body.get("enabled")
            if not isinstance(enabled, bool):
                raise AgentError("Поле enabled має бути boolean", HTTPStatus.BAD_REQUEST)
            if enabled:
                seconds = body.get("seconds", 15)
                if not isinstance(seconds, int):
                    raise AgentError("Поле seconds має бути integer", HTTPStatus.BAD_REQUEST)
                start_scan(seconds)
            else:
                stop_scan()
        elif path.startswith("/v1/bluetooth/devices/"):
            parts = path.split("/")
            if len(parts) != 6:
                raise AgentError("Шлях не знайдено", HTTPStatus.NOT_FOUND)
            device_action(parts[4], parts[5])
        elif path == "/v1/audio/volume":
            percent = body.get("percent")
            if not isinstance(percent, int):
                raise AgentError("Поле percent має бути integer", HTTPStatus.BAD_REQUEST)
            set_volume(percent)
        elif path == "/v1/audio/mute":
            enabled = body.get("enabled")
            if not isinstance(enabled, bool):
                raise AgentError("Поле enabled має бути boolean", HTTPStatus.BAD_REQUEST)
            set_mute(enabled)
        elif path == "/v1/audio/default-sink":
            node_id = body.get("nodeId")
            if not isinstance(node_id, int):
                raise AgentError("Поле nodeId має бути integer", HTTPStatus.BAD_REQUEST)
            set_default_sink(node_id)
        elif path == "/v1/player/action":
            action = body.get("action")
            if not isinstance(action, str):
                raise AgentError("Поле action має бути string", HTTPStatus.BAD_REQUEST)
            player_action(action)
        else:
            raise AgentError("Шлях не знайдено", HTTPStatus.NOT_FOUND)
        return full_status()

    def handle_request(self) -> None:
        if not self.authenticate():
            return
        try:
            self.send_json(HTTPStatus.OK, self.dispatch())
        except AgentError as error:
            self.send_json(error.status, {"error": str(error)})
        except Exception:
            LOGGER.exception("Unhandled request error")
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Внутрішня помилка аудіоагента"})

    def do_GET(self) -> None:  # noqa: N802
        self.handle_request()

    def do_POST(self) -> None:  # noqa: N802
        self.handle_request()


def main() -> None:
    server = ThreadingHTTPServer((LISTEN_ADDRESS, LISTEN_PORT), RequestHandler)
    server.daemon_threads = True
    LOGGER.info("LABA audio agent listening on %s:%s", LISTEN_ADDRESS, LISTEN_PORT)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
