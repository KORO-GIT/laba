#!/usr/bin/python3
"""Adaptive double/triple-clap detector for the LABA USB webcam microphone."""

from __future__ import annotations

import array
import logging
import math
import os
import statistics
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Callable


LOGGER = logging.getLogger("laba-clap-detector")
SAMPLE_RATE = 16_000
FRAME_MILLISECONDS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MILLISECONDS // 1_000
FRAME_BYTES = FRAME_SAMPLES * 2
DEFAULT_SOURCE = "alsa_input.usb-046d_C270_HD_WEBCAM_200901010001-02.mono-fallback"
MIN_GESTURE_INTERVAL = 0.16
DEFAULT_MAX_GESTURE_INTERVAL_MS = 1_100
MIN_MAX_GESTURE_INTERVAL_MS = 350
MAX_MAX_GESTURE_INTERVAL_MS = 1_500
DEFAULT_SENSITIVITY = 70
MIN_SENSITIVITY = 30
MAX_SENSITIVITY = 80
MIN_CLAP_PEAK = 0.32
MIN_CLAP_RMS = 0.060
MAX_CLAP_ACTIVE_RATIO = 0.58


class AdaptiveClapDetector:
    """Detect short broadband impulse gestures without reacting to steady music."""

    def __init__(
        self,
        sensitivity: int = DEFAULT_SENSITIVITY,
        max_interval_ms: int = DEFAULT_MAX_GESTURE_INTERVAL_MS,
    ) -> None:
        self.noise_rms: deque[float] = deque(maxlen=150)
        self.noise_high: deque[float] = deque(maxlen=150)
        self.previous_sample = 0.0
        self.last_impulse_at = -10.0
        self.clap_times: list[float] = []
        self.cooldown_until = 0.0
        self.last_metrics: dict[str, float] = {}
        self.settings_lock = threading.Lock()
        self.sensitivity = DEFAULT_SENSITIVITY
        self.max_gesture_interval = DEFAULT_MAX_GESTURE_INTERVAL_MS / 1_000
        self.configure(sensitivity, max_interval_ms)

    def configure(self, sensitivity: int, max_interval_ms: int) -> None:
        normalized_sensitivity = max(MIN_SENSITIVITY, min(MAX_SENSITIVITY, int(sensitivity)))
        normalized_interval_ms = max(
            MIN_MAX_GESTURE_INTERVAL_MS,
            min(MAX_MAX_GESTURE_INTERVAL_MS, int(max_interval_ms)),
        )
        with self.settings_lock:
            changed = (
                self.sensitivity != normalized_sensitivity
                or self.max_gesture_interval != normalized_interval_ms / 1_000
            )
            self.sensitivity = normalized_sensitivity
            self.max_gesture_interval = normalized_interval_ms / 1_000
            if changed:
                self.clap_times.clear()

    def settings(self) -> tuple[int, float]:
        with self.settings_lock:
            return self.sensitivity, self.max_gesture_interval

    @staticmethod
    def _samples(pcm: bytes) -> list[float]:
        values = array.array("h")
        values.frombytes(pcm)
        if sys.byteorder != "little":
            values.byteswap()
        return [sample / 32768.0 for sample in values]

    def process(self, pcm: bytes, now: float) -> str | None:
        if len(pcm) != FRAME_BYTES:
            return None
        samples = self._samples(pcm)
        if not samples:
            return None

        square_sum = 0.0
        high_square_sum = 0.0
        peak = 0.0
        zero_crossings = 0
        active_samples = 0
        previous = self.previous_sample
        previous_positive = previous >= 0.0
        for sample in samples:
            absolute = abs(sample)
            peak = max(peak, absolute)
            square_sum += sample * sample
            high = sample - previous
            high_square_sum += high * high
            positive = sample >= 0.0
            if positive != previous_positive:
                zero_crossings += 1
            previous_positive = positive
            previous = sample
        self.previous_sample = previous

        rms = math.sqrt(square_sum / len(samples))
        high_rms = math.sqrt(high_square_sum / len(samples))
        crest = peak / max(rms, 1e-6)
        crossing_ratio = zero_crossings / len(samples)
        active_threshold = max(0.025, peak * 0.12)
        active_samples = sum(1 for sample in samples if abs(sample) >= active_threshold)
        active_ratio = active_samples / len(samples)
        high_ratio = high_rms / max(rms, 1e-6)

        baseline_rms = statistics.median(self.noise_rms) if self.noise_rms else rms
        baseline_high = statistics.median(self.noise_high) if self.noise_high else high_rms
        sensitivity, max_gesture_interval = self.settings()
        # 50 preserves the original acoustic thresholds. Higher values lower
        # amplitude/relative thresholds, while transient and spectrum checks
        # continue separating hand claps from electrical arcs and steady audio.
        threshold_scale = 1.0 + (50 - sensitivity) * 0.006
        max_active_ratio = max(
            0.46,
            min(0.72, MAX_CLAP_ACTIVE_RATIO + (sensitivity - 50) * 0.003),
        )
        self.last_metrics = {
            "peak": peak,
            "rms": rms,
            "highRms": high_rms,
            "baselineRms": baseline_rms,
            "baselineHigh": baseline_high,
            "crest": crest,
            "crossingRatio": crossing_ratio,
            "activeRatio": active_ratio,
            "highRatio": high_ratio,
            "sensitivity": float(sensitivity),
            "maxGestureInterval": max_gesture_interval,
        }
        warmed_up = len(self.noise_rms) >= 50
        broad_impulse = (
            warmed_up
            and now >= self.cooldown_until
            and now - self.last_impulse_at >= 0.12
            and peak >= max(0.22 * threshold_scale, baseline_rms * 5.0 * threshold_scale)
            and rms >= max(0.045 * threshold_scale, baseline_rms * 2.8 * threshold_scale)
            and high_rms >= max(0.040 * threshold_scale, baseline_high * 4.0 * threshold_scale)
            and crest >= 1.8
            and crossing_ratio >= 0.10
            # Electrical arcs are usually a very short, unusually HF-heavy
            # crack. A hand clap occupies more of the 20 ms acoustic frame.
            and active_ratio >= 0.12
            and high_ratio <= 1.75
        )

        # Rhythmic audio from the speakers and machinery can satisfy the broad
        # impulse thresholds, but it normally fills most of the 20 ms frame.
        # A hand clap recorded by the webcam is both stronger and shorter. Keep
        # the broad classifier for protecting the adaptive noise baseline, then
        # apply this stricter transient shape before forming a clap gesture.
        clap_impulse = (
            broad_impulse
            and peak >= max(MIN_CLAP_PEAK * threshold_scale, baseline_rms * 6.0 * threshold_scale)
            and rms >= max(MIN_CLAP_RMS * threshold_scale, baseline_rms * 3.0 * threshold_scale)
            and active_ratio <= max_active_ratio
            # At elevated sensitivity a wide event must still be physically
            # strong. This keeps the weak, frame-filling night interference
            # out while allowing a real clap with a longer acoustic tail.
            and (active_ratio <= MAX_CLAP_ACTIVE_RATIO or peak >= 0.30)
        )

        # Only quiet and ordinary frames shape the adaptive background. This
        # keeps a clap from immediately raising its own detection threshold.
        if not broad_impulse and rms <= max(0.18, baseline_rms * 3.0):
            self.noise_rms.append(rms)
            self.noise_high.append(high_rms)

        if len(self.clap_times) == 2 and now - self.clap_times[-1] > max_gesture_interval:
            self.clap_times.clear()
            self.cooldown_until = now + 2.0
            return "double-clap"
        if len(self.clap_times) == 1 and now - self.clap_times[0] > max_gesture_interval:
            self.clap_times.clear()
        if not clap_impulse:
            return None

        self.last_impulse_at = now
        if not self.clap_times:
            self.clap_times.append(now)
            return "clap"

        interval = now - self.clap_times[-1]
        self.last_metrics["gestureInterval"] = interval
        if interval < MIN_GESTURE_INTERVAL:
            return None
        if interval > max_gesture_interval:
            self.clap_times[:] = [now]
            return "clap"
        self.clap_times.append(now)
        if len(self.clap_times) == 2:
            return "clap-pair"

        self.clap_times.clear()
        self.cooldown_until = now + 2.0
        return "triple-clap"


class ClapListener:
    def __init__(
        self,
        on_double_clap: Callable[[], None],
        on_triple_clap: Callable[[], None],
        sensitivity: int = DEFAULT_SENSITIVITY,
        max_interval_ms: int = DEFAULT_MAX_GESTURE_INTERVAL_MS,
    ) -> None:
        self.on_double_clap = on_double_clap
        self.on_triple_clap = on_triple_clap
        self.source = os.environ.get("LABA_CLAP_SOURCE", DEFAULT_SOURCE)
        self.enabled = os.environ.get("LABA_CLAP_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
        self.lock = threading.Lock()
        self.listening = False
        self.error: str | None = None
        self.last_clap_at: str | None = None
        self.last_gesture_at: str | None = None
        self.last_gesture: str | None = None
        self.trigger_count = 0
        self.double_clap_count = 0
        self.triple_clap_count = 0
        self.recent_candidates: deque[dict[str, object]] = deque(maxlen=3)
        self.thread: threading.Thread | None = None
        self.sensitivity = max(MIN_SENSITIVITY, min(MAX_SENSITIVITY, int(sensitivity)))
        self.max_interval_ms = max(
            MIN_MAX_GESTURE_INTERVAL_MS,
            min(MAX_MAX_GESTURE_INTERVAL_MS, int(max_interval_ms)),
        )
        self.detector: AdaptiveClapDetector | None = None

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def status(self) -> dict[str, object]:
        with self.lock:
            return {
                "enabled": self.enabled,
                "listening": self.listening,
                "source": "Webcam C270 Mono",
                "lastClapAt": self.last_clap_at,
                "lastGestureAt": self.last_gesture_at,
                "lastGesture": self.last_gesture,
                "triggerCount": self.trigger_count,
                "doubleClapCount": self.double_clap_count,
                "tripleClapCount": self.triple_clap_count,
                "recentCandidates": list(self.recent_candidates),
                "config": {
                    "sensitivity": self.sensitivity,
                    "maxIntervalMs": self.max_interval_ms,
                    "minIntervalMs": round(MIN_GESTURE_INTERVAL * 1_000),
                },
                "limits": {
                    "sensitivity": {"min": MIN_SENSITIVITY, "max": MAX_SENSITIVITY},
                    "maxIntervalMs": {
                        "min": MIN_MAX_GESTURE_INTERVAL_MS,
                        "max": MAX_MAX_GESTURE_INTERVAL_MS,
                    },
                },
                "error": self.error,
            }

    def configure(self, sensitivity: int, max_interval_ms: int) -> None:
        normalized_sensitivity = max(MIN_SENSITIVITY, min(MAX_SENSITIVITY, int(sensitivity)))
        normalized_interval_ms = max(
            MIN_MAX_GESTURE_INTERVAL_MS,
            min(MAX_MAX_GESTURE_INTERVAL_MS, int(max_interval_ms)),
        )
        with self.lock:
            self.sensitivity = normalized_sensitivity
            self.max_interval_ms = normalized_interval_ms
            detector = self.detector
        if detector:
            detector.configure(normalized_sensitivity, normalized_interval_ms)

    def start(self) -> None:
        if self.thread:
            return
        self.thread = threading.Thread(target=self._run, name="laba-clap-listener", daemon=True)
        self.thread.start()

    def set_enabled(self, enabled: bool) -> None:
        with self.lock:
            self.enabled = bool(enabled)

    def _set_state(self, *, listening: bool, error: str | None) -> None:
        with self.lock:
            self.listening = listening
            self.error = error

    @staticmethod
    def _run_action(callback: Callable[[], None], success_message: str, error_message: str) -> None:
        try:
            callback()
            LOGGER.info(success_message)
        except Exception:
            LOGGER.exception(error_message)

    def _dispatch_action(self, callback: Callable[[], None], success_message: str, error_message: str) -> None:
        # Keep consuming microphone frames while a greeting is playing. Otherwise
        # pw-record can buffer the speaker output and feed it back as stale input.
        threading.Thread(
            target=self._run_action,
            args=(callback, success_message, error_message),
            name="laba-clap-action",
            daemon=True,
        ).start()

    def _record_once(self) -> None:
        command = [
            "/usr/bin/pw-record",
            "--target", self.source,
            "--rate", str(SAMPLE_RATE),
            "--channels", "1",
            "--format", "s16",
            "--raw", "-",
        ]
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=os.environ.copy(),
        )
        if process.stdout is None:
            process.kill()
            raise RuntimeError("pw-record stdout is unavailable")

        with self.lock:
            detector = AdaptiveClapDetector(self.sensitivity, self.max_interval_ms)
            self.detector = detector
        self._set_state(listening=True, error=None)
        while True:
            with self.lock:
                enabled = self.enabled
            if not enabled:
                process.terminate()
                process.wait(timeout=3)
                self._set_state(listening=False, error=None)
                return
            pcm = process.stdout.read(FRAME_BYTES)
            if len(pcm) != FRAME_BYTES:
                break
            event = detector.process(pcm, time.monotonic())
            if event in {"clap", "clap-pair"}:
                candidate_at = self._timestamp()
                metrics = {key: round(value, 4) for key, value in detector.last_metrics.items()}
                with self.lock:
                    self.last_clap_at = candidate_at
                    self.recent_candidates.append({
                        "kind": event,
                        "at": candidate_at,
                        "metrics": metrics,
                    })
                LOGGER.info("Clap candidate %s: %s", event, metrics)
            elif event == "double-clap":
                with self.lock:
                    self.last_clap_at = self._timestamp()
                    self.last_gesture_at = self.last_clap_at
                    self.last_gesture = "play-pause"
                    self.trigger_count += 1
                    self.double_clap_count += 1
                self._dispatch_action(
                    self.on_double_clap,
                    "Double clap detected: play/pause sent to MPRIS",
                    "Double clap action failed",
                )
            elif event == "triple-clap":
                with self.lock:
                    self.last_clap_at = self._timestamp()
                    self.last_gesture_at = self.last_clap_at
                    self.last_gesture = "greeting"
                    self.trigger_count += 1
                    self.triple_clap_count += 1
                self._dispatch_action(
                    self.on_triple_clap,
                    "Triple clap detected: Ukrainian greeting played",
                    "Triple clap action failed",
                )

        return_code = process.wait(timeout=3)
        error_output = b""
        if process.stderr is not None:
            error_output = process.stderr.read(4096)
        message = error_output.decode("utf-8", "replace").strip()
        raise RuntimeError(message or f"pw-record exited with status {return_code}")

    def _run(self) -> None:
        while True:
            with self.lock:
                enabled = self.enabled
            if not enabled:
                self._set_state(listening=False, error=None)
                time.sleep(0.5)
                continue
            try:
                self._record_once()
            except Exception as error:
                message = str(error)[:300]
                LOGGER.warning("Clap listener unavailable: %s", message)
                self._set_state(listening=False, error=message)
                time.sleep(5)
