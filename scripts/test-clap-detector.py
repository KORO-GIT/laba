#!/usr/bin/python3
"""Deterministic checks for the adaptive LABA clap detector."""

from __future__ import annotations

import array
import importlib.util
import math
import random
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "deploy" / "audio" / "laba_clap_detector.py"
SPEC = importlib.util.spec_from_file_location("laba_clap_detector", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load clap detector")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def pcm_frame(samples: list[float]) -> bytes:
    return array.array("h", (round(max(-1.0, min(1.0, sample)) * 32767) for sample in samples)).tobytes()


def test_music_does_not_trigger() -> None:
    detector = MODULE.AdaptiveClapDetector()
    events: list[str] = []
    phase = 0
    for frame_number in range(400):
        envelope = 0.08 + (0.03 if frame_number % 25 < 4 else 0.0)
        samples = []
        for _ in range(MODULE.FRAME_SAMPLES):
            sample = envelope * (math.sin(phase * 2 * math.pi * 440 / MODULE.SAMPLE_RATE)
                                 + 0.35 * math.sin(phase * 2 * math.pi * 880 / MODULE.SAMPLE_RATE))
            samples.append(sample)
            phase += 1
        event = detector.process(pcm_frame(samples), frame_number * MODULE.FRAME_MILLISECONDS / 1000)
        if event:
            events.append(event)
    assert events == [], events


def impulse_samples(random_source: random.Random, burst: bool) -> list[float]:
    return [
        random_source.gauss(0.0, 0.55 if burst and index < 60 else 0.008)
        for index in range(MODULE.FRAME_SAMPLES)
    ]


def test_double_clap_triggers_once() -> None:
    detector = MODULE.AdaptiveClapDetector()
    random_source = random.Random(7)
    events: list[str] = []
    for frame_number in range(250):
        now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
        burst = 2.00 <= now < 2.02 or 2.42 <= now < 2.44
        event = detector.process(pcm_frame(impulse_samples(random_source, burst)), now)
        if event:
            events.append(event)
    assert events == ["clap", "clap-pair", "double-clap"], events


def test_triple_clap_supersedes_double_clap() -> None:
    detector = MODULE.AdaptiveClapDetector()
    random_source = random.Random(11)
    events: list[str] = []
    for frame_number in range(300):
        now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
        burst = any(start <= now < start + 0.02 for start in (2.00, 2.42, 2.84))
        event = detector.process(pcm_frame(impulse_samples(random_source, burst)), now)
        if event:
            events.append(event)
    assert events == ["clap", "clap-pair", "triple-clap"], events


test_music_does_not_trigger()
test_double_clap_triggers_once()
test_triple_clap_supersedes_double_clap()
print("Clap detector tests passed")
