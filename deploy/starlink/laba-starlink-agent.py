#!/usr/bin/python3
"""Authenticated local Starlink telemetry and control agent for LABA."""

from __future__ import annotations

import hmac
import json
import logging
import os
import subprocess
import threading
import time
from collections import defaultdict, deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from laba_starlink_model import normalize_obstruction_map, normalize_status


LISTEN_ADDRESS = os.environ.get("LABA_STARLINK_LISTEN_ADDRESS", "100.69.168.10")
LISTEN_PORT = int(os.environ.get("LABA_STARLINK_LISTEN_PORT", "1986"))
ALLOWED_CLIENT_IP = os.environ.get("LABA_STARLINK_ALLOWED_CLIENT_IP", "100.68.61.33")
DISH_TARGET = os.environ.get("LABA_STARLINK_DISH_TARGET", "192.168.100.1:9200")
GRPCURL = Path(os.environ.get("LABA_STARLINK_GRPCURL", "/usr/local/lib/laba-starlink/grpcurl"))
GRPC_SERVICE = "SpaceX.API.Device.Device/Handle"
MAX_BODY_BYTES = 16 * 1024
MAX_GRPC_OUTPUT_BYTES = 4 * 1024 * 1024
STATUS_CACHE_SECONDS = 5
MAP_CACHE_SECONDS = 300

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOGGER = logging.getLogger("laba-starlink-agent")
COMMAND_LOCK = threading.Lock()
CACHE_LOCK = threading.Lock()
RATE_LOCK = threading.Lock()
RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)
STATUS_CACHE: tuple[float, dict[str, Any]] | None = None
MAP_CACHE: tuple[float, dict[str, Any]] | None = None


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


AUTH_TOKEN = credential("STARLINK_AGENT_TOKEN")


def grpc_request(payload: dict[str, Any], timeout: int = 12) -> dict[str, Any]:
    if not GRPCURL.is_file():
        raise AgentError("grpcurl для Starlink не встановлено", HTTPStatus.SERVICE_UNAVAILABLE)
    arguments = [
        str(GRPCURL),
        "-plaintext",
        "-max-time", str(timeout),
        "-d", json.dumps(payload, separators=(",", ":")),
        DISH_TARGET,
        GRPC_SERVICE,
    ]
    try:
        completed = subprocess.run(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout + 2,
            check=False,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired as error:
        raise AgentError("Тарілка Starlink не відповіла вчасно", HTTPStatus.GATEWAY_TIMEOUT) from error
    output = completed.stdout
    if len(output) > MAX_GRPC_OUTPUT_BYTES:
        raise AgentError("Відповідь Starlink перевищила безпечний розмір")
    text = output.decode("utf-8", "replace").strip()
    if completed.returncode != 0:
        LOGGER.warning("Starlink gRPC request failed with status %s", completed.returncode)
        message = next((line.strip() for line in reversed(text.splitlines()) if line.strip()), "")
        raise AgentError(message or "Помилка локального API Starlink")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise AgentError("Starlink повернув некоректну відповідь") from error
    if not isinstance(parsed, dict):
        raise AgentError("Starlink повернув неочікувану відповідь")
    return parsed


def invalidate_caches() -> None:
    global STATUS_CACHE, MAP_CACHE
    with CACHE_LOCK:
        STATUS_CACHE = None
        MAP_CACHE = None


def collect_status(force: bool = False) -> dict[str, Any]:
    global STATUS_CACHE
    now = time.monotonic()
    with CACHE_LOCK:
        if not force and STATUS_CACHE and now - STATUS_CACHE[0] < STATUS_CACHE_SECONDS:
            return STATUS_CACHE[1]
    with COMMAND_LOCK:
        status = grpc_request({"get_status": {}})
        history = grpc_request({"get_history": {}})
        config = grpc_request({"dish_get_config": {}})
        diagnostics = grpc_request({"get_diagnostics": {}})
        normalized = normalize_status(status, history, config, diagnostics)
    with CACHE_LOCK:
        STATUS_CACHE = (time.monotonic(), normalized)
    return normalized


def collect_obstruction_map(force: bool = False) -> dict[str, Any]:
    global MAP_CACHE
    now = time.monotonic()
    with CACHE_LOCK:
        if not force and MAP_CACHE and now - MAP_CACHE[0] < MAP_CACHE_SECONDS:
            return MAP_CACHE[1]
    with COMMAND_LOCK:
        normalized = normalize_obstruction_map(grpc_request({"dish_get_obstruction_map": {}}, timeout=15))
    with CACHE_LOCK:
        MAP_CACHE = (time.monotonic(), normalized)
    return normalized


def execute_control(payload: dict[str, Any]) -> None:
    with COMMAND_LOCK:
        grpc_request(payload)
    invalidate_caches()


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
    server_version = "LABAStarlinkAgent/1"
    sys_version = ""

    def log_message(self, format_string: str, *arguments: object) -> None:
        LOGGER.info("%s %s", self.client_address[0], format_string % arguments)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
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
        expected = f"Bearer {AUTH_TOKEN}"
        if not hmac.compare_digest(self.headers.get("Authorization", ""), expected):
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Невірна авторизація"})
            return False
        return True

    def read_json(self) -> dict[str, Any]:
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

    @staticmethod
    def require_boolean(body: dict[str, Any], key: str) -> bool:
        value = body.get(key)
        if not isinstance(value, bool):
            raise AgentError(f"Поле {key} має бути boolean", HTTPStatus.BAD_REQUEST)
        return value

    def dispatch(self) -> dict[str, Any]:
        path = urlparse(self.path).path
        if self.command == "GET" and path == "/v1/status":
            return collect_status()
        if self.command == "GET" and path == "/v1/obstruction-map":
            return collect_obstruction_map()
        if self.command != "POST":
            raise AgentError("Шлях не знайдено", HTTPStatus.NOT_FOUND)

        body = self.read_json()
        if path == "/v1/reboot":
            if not self.require_boolean(body, "confirm"):
                raise AgentError("Потрібне підтвердження перезавантаження", HTTPStatus.BAD_REQUEST)
            execute_control({"reboot": {}})
            return {"ok": True, "action": "reboot"}
        if path == "/v1/gps":
            inhibited = self.require_boolean(body, "inhibited")
            execute_control({"dish_inhibit_gps": {"inhibit_gps": inhibited}})
            return collect_status(force=True)
        if path == "/v1/power-save":
            enabled = self.require_boolean(body, "enabled")
            start = body.get("startMinutesUtc", 0)
            duration = body.get("durationMinutes", 1)
            if not isinstance(start, int) or not 0 <= start < 1440:
                raise AgentError("Некоректний час початку сну", HTTPStatus.BAD_REQUEST)
            if not isinstance(duration, int) or not 1 <= duration <= 1440:
                raise AgentError("Некоректна тривалість сну", HTTPStatus.BAD_REQUEST)
            execute_control({"dish_power_save": {
                "power_save_start_minutes": start,
                "power_save_duration_minutes": duration,
                "enable_power_save": enabled,
            }})
            return collect_status(force=True)
        if path == "/v1/snow-melt":
            raise AgentError(
                "Змінювати підігрів може лише власник акаунта у застосунку Starlink",
                HTTPStatus.FORBIDDEN,
            )
        if path == "/v1/clear-obstruction-map":
            if not self.require_boolean(body, "confirm"):
                raise AgentError("Потрібне підтвердження очищення карти", HTTPStatus.BAD_REQUEST)
            execute_control({"dish_clear_obstruction_map": {}})
            return {"ok": True, "action": "clear-obstruction-map"}
        if path in {"/v1/stow", "/v1/unstow"}:
            capabilities = collect_status().get("capabilities", {})
            if not capabilities.get("stow"):
                raise AgentError("Ця модель Starlink не має приводів", HTTPStatus.CONFLICT)
            execute_control({"dish_stow": {"unstow": path.endswith("unstow")}})
            return {"ok": True, "action": path.rsplit("/", 1)[-1]}
        raise AgentError("Шлях не знайдено", HTTPStatus.NOT_FOUND)

    def handle_request(self) -> None:
        if not self.authenticate():
            return
        try:
            self.send_json(HTTPStatus.OK, self.dispatch())
        except AgentError as error:
            self.send_json(error.status, {"error": str(error)})
        except Exception:
            LOGGER.exception("Unhandled Starlink agent error")
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Внутрішня помилка Starlink-агента"})

    def do_GET(self) -> None:  # noqa: N802
        self.handle_request()

    def do_POST(self) -> None:  # noqa: N802
        self.handle_request()


def main() -> None:
    server = ThreadingHTTPServer((LISTEN_ADDRESS, LISTEN_PORT), RequestHandler)
    server.daemon_threads = True
    LOGGER.info("LABA Starlink agent listening on %s:%s; dish %s", LISTEN_ADDRESS, LISTEN_PORT, DISH_TARGET)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
