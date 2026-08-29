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
        random_source.gauss(0.0, 0.55 if burst and index < 100 else 0.008)
        for index in range(MODULE.FRAME_SAMPLES)
    ]


def weak_impulse_samples(random_source: random.Random, burst: bool) -> list[float]:
    return [
        random_source.gauss(0.0, 0.10 if burst and index < 100 else 0.008)
        for index in range(MODULE.FRAME_SAMPLES)
    ]


def electric_arc_samples(random_source: random.Random, burst: bool) -> list[float]:
    return [
        (0.65 if index % 2 == 0 else -0.65) if burst and index < 40 else random_source.gauss(0.0, 0.008)
        for index in range(MODULE.FRAME_SAMPLES)
    ]


def sustained_rhythmic_beat_samples(random_source: random.Random, burst: bool) -> list[float]:
    """Match the wide, weak bursts found in the 2026-08-29 false-trigger logs."""
    return [
        random_source.gauss(0.0, 0.070 if burst else 0.008)
        for _ in range(MODULE.FRAME_SAMPLES)
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


def test_fast_human_double_clap_triggers() -> None:
    detector = MODULE.AdaptiveClapDetector()
    random_source = random.Random(31)
    events: list[str] = []
    for frame_number in range(250):
        now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
        burst = 2.00 <= now < 2.02 or 2.24 <= now < 2.26
        event = detector.process(pcm_frame(impulse_samples(random_source, burst)), now)
        if event:
            events.append(event)
    assert events == ["clap", "clap-pair", "double-clap"], events


def test_slow_human_double_clap_triggers() -> None:
    detector = MODULE.AdaptiveClapDetector()
    random_source = random.Random(37)
    events: list[str] = []
    for frame_number in range(280):
        now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
        burst = 2.00 <= now < 2.02 or 2.86 <= now < 2.88
        event = detector.process(pcm_frame(impulse_samples(random_source, burst)), now)
        if event:
            events.append(event)
    assert events == ["clap", "clap-pair", "double-clap"], events


def test_sensitivity_controls_weak_claps() -> None:
    results: dict[int, list[str]] = {}
    for sensitivity in (30, MODULE.MAX_SENSITIVITY):
        detector = MODULE.AdaptiveClapDetector(sensitivity=sensitivity)
        random_source = random.Random(101)
        events: list[str] = []
        for frame_number in range(250):
            now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
            burst = 2.00 <= now < 2.02 or 2.40 <= now < 2.42
            event = detector.process(pcm_frame(weak_impulse_samples(random_source, burst)), now)
            if event:
                events.append(event)
        results[sensitivity] = events
    assert results[30] == [], results
    assert results[MODULE.MAX_SENSITIVITY] == ["clap", "clap-pair", "double-clap"], results


def test_configurable_slow_interval_triggers() -> None:
    detector = MODULE.AdaptiveClapDetector(max_interval_ms=1_300)
    random_source = random.Random(41)
    events: list[str] = []
    for frame_number in range(300):
        now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
        burst = 2.00 <= now < 2.02 or 3.20 <= now < 3.22
        event = detector.process(pcm_frame(impulse_samples(random_source, burst)), now)
        if event:
            events.append(event)
    assert events == ["clap", "clap-pair", "double-clap"], events


def test_electric_arc_pair_is_rejected() -> None:
    detector = MODULE.AdaptiveClapDetector()
    random_source = random.Random(19)
    events: list[str] = []
    for frame_number in range(250):
        now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
        burst = 2.00 <= now < 2.02 or 2.42 <= now < 2.44
        event = detector.process(pcm_frame(electric_arc_samples(random_source, burst)), now)
        if event:
            events.append(event)
    assert events == [], events


def test_sustained_rhythmic_pair_is_rejected() -> None:
    detector = MODULE.AdaptiveClapDetector()
    random_source = random.Random(29)
    events: list[str] = []
    rejected_metrics: list[dict[str, float]] = []
    for frame_number in range(250):
        now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
        burst = 2.00 <= now < 2.02 or 2.38 <= now < 2.40
        event = detector.process(pcm_frame(sustained_rhythmic_beat_samples(random_source, burst)), now)
        if burst:
            rejected_metrics.append(dict(detector.last_metrics))
        if event:
            events.append(event)
    assert events == [], events
    assert all(metrics["activeRatio"] > MODULE.MAX_CLAP_ACTIVE_RATIO for metrics in rejected_metrics)


def test_high_sensitivity_still_rejects_interference() -> None:
    for sample_factory in (electric_arc_samples, sustained_rhythmic_beat_samples):
        for seed in (18, 42, 43, 44, 54, 73):
            detector = MODULE.AdaptiveClapDetector(sensitivity=MODULE.MAX_SENSITIVITY)
            random_source = random.Random(seed)
            events: list[str] = []
            for frame_number in range(250):
                now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
                burst = 2.00 <= now < 2.02 or 2.38 <= now < 2.40
                event = detector.process(pcm_frame(sample_factory(random_source, burst)), now)
                if event:
                    events.append(event)
            assert events == [], (sample_factory.__name__, seed, events)


def test_too_fast_pair_is_not_a_gesture() -> None:
    detector = MODULE.AdaptiveClapDetector()
    random_source = random.Random(23)
    events: list[str] = []
    for frame_number in range(250):
        now = frame_number * MODULE.FRAME_MILLISECONDS / 1000
        burst = 2.00 <= now < 2.02 or 2.14 <= now < 2.16
        event = detector.process(pcm_frame(impulse_samples(random_source, burst)), now)
        if event:
            events.append(event)
    assert "double-clap" not in events and "triple-clap" not in events, events


def test_listener_exposes_live_configuration() -> None:
    listener = MODULE.ClapListener(lambda: None, lambda: None)
    listener.configure(76, 1_250)
    listener.set_enabled(False)
    status = listener.status()
    assert status["enabled"] is False
    assert status["config"] == {
        "sensitivity": 76,
        "maxIntervalMs": 1_250,
        "minIntervalMs": round(MODULE.MIN_GESTURE_INTERVAL * 1_000),
    }


test_music_does_not_trigger()
test_double_clap_triggers_once()
test_triple_clap_supersedes_double_clap()
test_fast_human_double_clap_triggers()
test_slow_human_double_clap_triggers()
test_sensitivity_controls_weak_claps()
test_configurable_slow_interval_triggers()
test_electric_arc_pair_is_rejected()
test_sustained_rhythmic_pair_is_rejected()
test_high_sensitivity_still_rejects_interference()
test_too_fast_pair_is_not_a_gesture()
test_listener_exposes_live_configuration()
print("Clap detector tests passed")
