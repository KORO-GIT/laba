#!/usr/bin/python3
"""Deterministic checks for persistent LABA clap configuration."""

from __future__ import annotations

import importlib.util
import os
import stat
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "deploy" / "audio" / "laba-audio-agent.py"


with tempfile.TemporaryDirectory() as temporary_directory:
    temporary = Path(temporary_directory)
    (temporary / "AUDIO_AGENT_TOKEN").write_text("t" * 48, encoding="utf-8")
    config_path = temporary / "state" / "clap-config.json"
    os.environ["CREDENTIALS_DIRECTORY"] = str(temporary)
    os.environ["LABA_CLAP_CONFIG_PATH"] = str(config_path)
    sys.path.insert(0, str(MODULE_PATH.parent))

    spec = importlib.util.spec_from_file_location("laba_audio_agent", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load audio agent")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    expected = {"enabled": False, "sensitivity": 76, "maxIntervalMs": 1_250}
    assert module.normalized_clap_config(expected) == expected
    module.save_clap_config(expected)
    assert module.load_clap_config() == expected
    if os.name == "posix":
        assert stat.S_IMODE(config_path.stat().st_mode) == 0o600

    for invalid in (
        {"enabled": 1, "sensitivity": 70, "maxIntervalMs": 1_100},
        {"enabled": True, "sensitivity": 81, "maxIntervalMs": 1_100},
        {"enabled": True, "sensitivity": 70, "maxIntervalMs": 1_501},
    ):
        try:
            module.normalized_clap_config(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Invalid clap config accepted: {invalid}")

print("Audio agent config tests passed")
