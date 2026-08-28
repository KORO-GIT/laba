#!/usr/bin/python3
"""Deterministic checks for Starlink history and status normalization."""

from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / "deploy" / "starlink" / "laba_starlink_model.py"
SPEC = importlib.util.spec_from_file_location("laba_starlink_model", MODEL_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load Starlink model")
MODEL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODEL)


history = {
    "current": "7",
    "popPingDropRate": [0.0, 0.5, 1.0, 0.0, 0.0],
    "popPingLatencyMs": [20.0, 30.0, 999.0, 40.0, 10.0],
    "downlinkThroughputBps": [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000],
    "uplinkThroughputBps": [100_000, 200_000, 300_000, 400_000, 500_000],
    "powerIn": [20, 21, 22, 23, 24],
}
normalized_history = MODEL.normalize_history(history)
assert normalized_history["windowSeconds"] == 5
assert normalized_history["series"]["pingMs"] == [None, 40.0, 10.0, 20.0, 30.0]
assert normalized_history["ping"]["averageMs"] == 25.0
assert normalized_history["loss"]["fullOutageSeconds"] == 1
assert normalized_history["download"]["currentMbps"] == 2.0
assert normalized_history["power"]["averageWatts"] == 22.0

status = MODEL.normalize_status(
    {
        "apiVersion": "42",
        "dishGetStatus": {
            "deviceInfo": {
                "id": "ut-test", "hardwareVersion": "mini1", "softwareVersion": "2026.1",
                "countryCode": "UA", "bootcount": 3,
            },
            "deviceState": {"uptimeS": "1234"},
            "disablementCode": "OKAY",
            "isSnrAboveNoiseFloor": True,
            "popPingLatencyMs": 24.5,
            "downlinkThroughputBps": 12_500_000,
            "uplinkThroughputBps": 2_500_000,
            "ethSpeedMbps": 1000,
            "obstructionStats": {"fractionObstructed": 0.0125},
            "gpsStats": {"gpsSats": 7, "inhibitGps": True},
            "hasActuators": "HAS_ACTUATORS_NO",
            "downstreamRouters": {"router": {"role": "BYPASSED"}},
        },
    },
    {"dishGetHistory": history},
    {"dishGetConfig": {"dishConfig": {"snowMeltMode": "ALWAYS_OFF"}}},
    {"dishGetDiagnostics": {"hardwareSelfTest": "PASSED", "location": {}}},
)
assert status["connected"] is True
assert status["device"]["bypassMode"] is True
assert status["network"]["downloadMbps"] == 12.5
assert status["gps"]["inhibited"] is True
assert status["capabilities"]["stow"] is False
assert status["config"]["snowMeltMode"] == "ALWAYS_OFF"

obstruction = MODEL.normalize_obstruction_map({
    "dishGetObstructionMap": {"numRows": 2, "numCols": 2, "snr": [-1, 0, 0.5, 1]},
})
assert obstruction["rows"] == 2 and obstruction["columns"] == 2
assert obstruction["snr"] == [-1.0, 0.0, 0.5, 1.0]

print("Starlink model tests passed")
