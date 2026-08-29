#!/usr/bin/python3
"""Pure normalization helpers for the LABA Starlink agent."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Iterable


MAX_SERIES_POINTS = 180


def normalize_router_status(downstream_routers: Any) -> dict[str, Any]:
    """Derive router availability from the dish response without extra probes."""
    raw_routers: list[Any]
    if isinstance(downstream_routers, dict):
        raw_routers = list(downstream_routers.values())
    elif isinstance(downstream_routers, list):
        raw_routers = downstream_routers
    else:
        raw_routers = []
    roles = [
        str(router.get("role") or "UNKNOWN").upper()
        for router in raw_routers
        if isinstance(router, dict)
    ]
    bypassed = "BYPASSED" in roles
    available = any(role not in {"", "UNKNOWN", "BYPASSED"} for role in roles) and not bypassed
    return {
        "available": available,
        "state": "BYPASSED" if bypassed else "ONLINE" if available else "NOT_DETECTED",
        "source": "DISH_TELEMETRY",
    }


def finite_number(value: Any, default: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def rounded(value: Any, digits: int = 2) -> float | None:
    number = finite_number(value)
    return round(number, digits) if number is not None else None


def _history_indices(history: dict[str, Any]) -> list[int]:
    drops = history.get("popPingDropRate")
    if not isinstance(drops, list) or not drops:
        return []
    capacity = len(drops)
    current = max(0, integer(history.get("current")))
    samples = min(capacity, current)
    if samples <= 0:
        return []
    start = current - samples
    start_offset = start % capacity
    end_offset = current % capacity
    if start_offset < end_offset:
        return list(range(start_offset, end_offset))
    return list(range(start_offset, capacity)) + list(range(0, end_offset))


def _ordered(history: dict[str, Any], key: str, indices: list[int]) -> list[float | None]:
    values = history.get(key)
    if not isinstance(values, list):
        return [None] * len(indices)
    return [finite_number(values[index]) if index < len(values) else None for index in indices]


def _mean(values: Iterable[float | None]) -> float | None:
    valid = [value for value in values if value is not None]
    return sum(valid) / len(valid) if valid else None


def _percentile(values: Iterable[float | None], percentile: float) -> float | None:
    valid = sorted(value for value in values if value is not None)
    if not valid:
        return None
    position = (len(valid) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return valid[lower]
    return valid[lower] + (valid[upper] - valid[lower]) * (position - lower)


def _downsample(values: list[float | None], max_points: int = MAX_SERIES_POINTS) -> list[float | None]:
    if len(values) <= max_points:
        return [rounded(value, 3) for value in values]
    bucket_size = math.ceil(len(values) / max_points)
    result: list[float | None] = []
    for start in range(0, len(values), bucket_size):
        result.append(rounded(_mean(values[start:start + bucket_size]), 3))
    return result


def _last(values: list[float | None]) -> float | None:
    return next((value for value in reversed(values) if value is not None), None)


def _timestamp_from_ns(value: Any) -> str | None:
    nanoseconds = finite_number(value)
    if nanoseconds is None or nanoseconds <= 0:
        return None
    try:
        return datetime.fromtimestamp(nanoseconds / 1_000_000_000, timezone.utc).isoformat(timespec="seconds")
    except (OSError, OverflowError, ValueError):
        return None


def normalize_history(history: dict[str, Any]) -> dict[str, Any]:
    indices = _history_indices(history)
    drops = _ordered(history, "popPingDropRate", indices)
    ping_raw = _ordered(history, "popPingLatencyMs", indices)
    pings = [
        value if value is not None and (drops[index] or 0) < 1 else None
        for index, value in enumerate(ping_raw)
    ]
    down_bps = _ordered(history, "downlinkThroughputBps", indices)
    up_bps = _ordered(history, "uplinkThroughputBps", indices)
    power_w = _ordered(history, "powerIn", indices)
    down_mbps = [value / 1_000_000 if value is not None else None for value in down_bps]
    up_mbps = [value / 1_000_000 if value is not None else None for value in up_bps]
    drops_percent = [value * 100 if value is not None else None for value in drops]

    events_raw = history.get("eventLog", {}).get("events", [])
    events: list[dict[str, Any]] = []
    if isinstance(events_raw, list):
        for event in events_raw[-30:]:
            if not isinstance(event, dict):
                continue
            events.append({
                "severity": str(event.get("severity") or "EVENT_SEVERITY_UNKNOWN"),
                "reason": str(event.get("reason") or "EVENT_REASON_UNKNOWN"),
                "startedAt": _timestamp_from_ns(event.get("startTimestampNs")),
                "durationSeconds": rounded((finite_number(event.get("durationNs"), 0) or 0) / 1_000_000_000, 2),
            })

    valid_ping = [value for value in pings if value is not None]
    valid_down = [value for value in down_mbps if value is not None]
    valid_up = [value for value in up_mbps if value is not None]
    valid_power = [value for value in power_w if value is not None]
    average_drop = _mean(drops_percent)
    return {
        "windowSeconds": len(indices),
        "sampleIntervalSeconds": 1,
        "endCounter": integer(history.get("current")),
        "ping": {
            "currentMs": rounded(_last(pings)),
            "averageMs": rounded(_mean(valid_ping)),
            "minimumMs": rounded(min(valid_ping) if valid_ping else None),
            "maximumMs": rounded(max(valid_ping) if valid_ping else None),
            "p95Ms": rounded(_percentile(valid_ping, 0.95)),
        },
        "loss": {
            "averagePercent": rounded(average_drop, 3),
            "affectedSeconds": rounded(sum(value or 0 for value in drops), 2),
            "fullOutageSeconds": sum(1 for value in drops if value is not None and value >= 1),
        },
        "download": {
            "currentMbps": rounded(_last(down_mbps), 3),
            "averageMbps": rounded(_mean(valid_down), 3),
            "maximumMbps": rounded(max(valid_down) if valid_down else None, 3),
            "usageMegabytes": rounded(sum(value or 0 for value in down_bps) / 8 / 1_000_000, 2),
        },
        "upload": {
            "currentMbps": rounded(_last(up_mbps), 3),
            "averageMbps": rounded(_mean(valid_up), 3),
            "maximumMbps": rounded(max(valid_up) if valid_up else None, 3),
            "usageMegabytes": rounded(sum(value or 0 for value in up_bps) / 8 / 1_000_000, 2),
        },
        "power": {
            "currentWatts": rounded(_last(power_w)),
            "averageWatts": rounded(_mean(valid_power)),
            "maximumWatts": rounded(max(valid_power) if valid_power else None),
        },
        "series": {
            "pingMs": _downsample(pings),
            "lossPercent": _downsample(drops_percent),
            "downloadMbps": _downsample(down_mbps),
            "uploadMbps": _downsample(up_mbps),
            "powerWatts": _downsample(power_w),
        },
        "events": events,
    }


def normalize_status(
    status_response: dict[str, Any],
    history_response: dict[str, Any],
    config_response: dict[str, Any],
    diagnostics_response: dict[str, Any],
) -> dict[str, Any]:
    status = status_response.get("dishGetStatus", {})
    device_info = status.get("deviceInfo", {})
    obstruction = status.get("obstructionStats", {})
    gps = status.get("gpsStats", {})
    alignment = status.get("alignmentStats", {})
    config = config_response.get("dishGetConfig", {}).get("dishConfig", {})
    diagnostics = diagnostics_response.get("dishGetDiagnostics", {})
    alerts = [key for key, value in status.get("alerts", {}).items() if value]
    ready_states = status.get("readyStates", {})
    disablement = str(status.get("disablementCode") or "UNKNOWN")
    connected = disablement == "OKAY" and bool(status.get("isSnrAboveNoiseFloor", False))
    router = normalize_router_status(status.get("downstreamRouters", {}))
    bypass = router["state"] == "BYPASSED"
    has_actuators = str(status.get("hasActuators") or alignment.get("hasActuators") or "UNKNOWN")
    history = normalize_history(history_response.get("dishGetHistory", {}))
    location = diagnostics.get("location", {})
    location_available = isinstance(location, dict) and "latitude" in location and "longitude" in location

    return {
        "version": 1,
        "collectedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "connected": connected,
        "state": "CONNECTED" if connected else disablement,
        "apiVersion": str(status_response.get("apiVersion") or ""),
        "device": {
            "id": device_info.get("id"),
            "hardwareVersion": device_info.get("hardwareVersion"),
            "softwareVersion": device_info.get("softwareVersion"),
            "countryCode": device_info.get("countryCode"),
            "uptimeSeconds": integer(status.get("deviceState", {}).get("uptimeS")),
            "bootCount": integer(device_info.get("bootcount")),
            "classOfService": status.get("classOfService"),
            "mobilityClass": status.get("mobilityClass"),
            "bypassMode": bypass,
        },
        "network": {
            "pingMs": rounded(status.get("popPingLatencyMs")),
            "downloadMbps": rounded((finite_number(status.get("downlinkThroughputBps"), 0) or 0) / 1_000_000, 3),
            "uploadMbps": rounded((finite_number(status.get("uplinkThroughputBps"), 0) or 0) / 1_000_000, 3),
            "ethernetMbps": integer(status.get("ethSpeedMbps")),
            "downloadRestrictedReason": status.get("dlBandwidthRestrictedReason"),
            "uploadRestrictedReason": status.get("ulBandwidthRestrictedReason"),
        },
        "router": router,
        "obstruction": {
            "fractionPercent": rounded((finite_number(obstruction.get("fractionObstructed"), 0) or 0) * 100, 3),
            "currentlyObstructed": bool(obstruction.get("currentlyObstructed", False)),
            "timeObstructedPercent": rounded((finite_number(obstruction.get("timeObstructed"), 0) or 0) * 100, 4),
            "validSeconds": integer(obstruction.get("validS")),
            "averageDurationSeconds": rounded(obstruction.get("avgProlongedObstructionDurationS")),
            "averageIntervalSeconds": rounded(obstruction.get("avgProlongedObstructionIntervalS")),
        },
        "orientation": {
            "azimuthDegrees": rounded(alignment.get("boresightAzimuthDeg", status.get("boresightAzimuthDeg"))),
            "elevationDegrees": rounded(alignment.get("boresightElevationDeg", status.get("boresightElevationDeg"))),
            "desiredAzimuthDegrees": rounded(alignment.get("desiredBoresightAzimuthDeg")),
            "desiredElevationDegrees": rounded(alignment.get("desiredBoresightElevationDeg")),
            "tiltDegrees": rounded(alignment.get("tiltAngleDeg")),
            "uncertaintyDegrees": rounded(alignment.get("attitudeUncertaintyDeg")),
        },
        "gps": {
            "satellites": integer(gps.get("gpsSats")),
            "valid": bool(gps.get("gpsValid", False)),
            "inhibited": bool(gps.get("inhibitGps", False)),
            "convergenceState": gps.get("pntFilterConvergenceState"),
            "locationAvailable": location_available,
        },
        "config": {
            "snowMeltMode": str(config.get("snowMeltMode") or "AUTO"),
            "powerSaveEnabled": bool(config.get("powerSaveMode", False)),
            "powerSaveStartMinutesUtc": integer(config.get("powerSaveStartMinutes")),
            "powerSaveDurationMinutes": integer(config.get("powerSaveDurationMinutes")),
            "softwareUpdateRebootHourUtc": integer(config.get("swupdateRebootHour"), 3),
            "softwareUpdateDeferred": bool(config.get("swupdateThreeDayDeferralEnabled", False)),
        },
        "health": {
            "alerts": alerts,
            "disablementCode": disablement,
            "softwareUpdateState": status.get("softwareUpdateState"),
            "hardwareSelfTest": diagnostics.get("hardwareSelfTest"),
            "hardwareSelfTestCodes": diagnostics.get("hardwareSelfTestCodes", []),
            "readyStates": ready_states,
        },
        "capabilities": {
            "reboot": True,
            "gpsInhibit": True,
            "powerSave": True,
            # Current Starlink policy accepts this setting only from the
            # account owner. Keep its value visible, but never advertise a
            # local write capability that will be rejected upstream.
            "snowMelt": False,
            "clearObstructionMap": True,
            "stow": has_actuators not in {"HAS_ACTUATORS_NO", "UNKNOWN", ""},
            "location": location_available,
        },
        "history": history,
    }


def normalize_obstruction_map(response: dict[str, Any]) -> dict[str, Any]:
    raw = response.get("dishGetObstructionMap", {})
    rows = max(0, integer(raw.get("numRows")))
    columns = max(0, integer(raw.get("numCols")))
    expected = rows * columns
    values = raw.get("snr", [])
    if not isinstance(values, list) or expected <= 0 or len(values) != expected or expected > 65_536:
        raise ValueError("Некоректна карта перешкод Starlink")
    snr = [rounded(value, 4) for value in values]
    return {
        "collectedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rows": rows,
        "columns": columns,
        "minimumElevationDegrees": rounded(raw.get("minElevationDeg")),
        "maximumThetaDegrees": rounded(raw.get("maxThetaDeg")),
        "snr": snr,
    }
