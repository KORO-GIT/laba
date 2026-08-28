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


class AdaptiveClapDetector:
    """Detect short broadband impulse gestures without reacting to steady music."""

    def __init__(self) -> None:
        self.noise_rms: deque[float] = deque(maxlen=150)
        self.noise_high: deque[float] = deque(maxlen=150)
        self.previous_sample = 0.0
        self.last_impulse_at = -10.0
        self.clap_times: list[float] = []
        self.cooldown_until = 0.0
        self.last_metrics: dict[str, float] = {}

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

        baseline_rms = statistics.median(self.noise_rms) if self.noise_rms else rms
        baseline_high = statistics.median(self.noise_high) if self.noise_high else high_rms
        self.last_metrics = {
            "peak": peak,
            "rms": rms,
            "highRms": high_rms,
            "baselineRms": baseline_rms,
            "baselineHigh": baseline_high,
            "crest": crest,
            "crossingRatio": crossing_ratio,
        }
        warmed_up = len(self.noise_rms) >= 50
        impulse = (
            warmed_up
            and now >= self.cooldown_until
            and now - self.last_impulse_at >= 0.12
            and peak >= max(0.22, baseline_rms * 5.0)
            and rms >= max(0.045, baseline_rms * 2.8)
            and high_rms >= max(0.040, baseline_high * 4.0)
            and crest >= 1.8
            and crossing_ratio >= 0.10
        )

        # Only quiet and ordinary frames shape the adaptive background. This
        # keeps a clap from immediately raising its own detection threshold.
        if not impulse and rms <= max(0.18, baseline_rms * 3.0):
            self.noise_rms.append(rms)
            self.noise_high.append(high_rms)

        if len(self.clap_times) == 2 and now - self.clap_times[-1] > 0.90:
            self.clap_times.clear()
            self.cooldown_until = now + 2.0
            return "double-clap"
        if len(self.clap_times) == 1 and now - self.clap_times[0] > 0.90:
            self.clap_times.clear()
        if not impulse:
            return None

        self.last_impulse_at = now
        if not self.clap_times:
            self.clap_times.append(now)
            return "clap"

        interval = now - self.clap_times[-1]
        if interval < 0.16:
            return None
        if interval > 0.90:
            self.clap_times[:] = [now]
            return "clap"
        self.clap_times.append(now)
        if len(self.clap_times) == 2:
            return "clap-pair"

        self.clap_times.clear()
        self.cooldown_until = now + 2.0
        return "triple-clap"


class ClapListener:
    def __init__(self, on_double_clap: Callable[[], None], on_triple_clap: Callable[[], None]) -> None:
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
        self.thread: threading.Thread | None = None

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
                "error": self.error,
            }

    def start(self) -> None:
        if not self.enabled or self.thread:
            return
        self.thread = threading.Thread(target=self._run, name="laba-clap-listener", daemon=True)
        self.thread.start()

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

        detector = AdaptiveClapDetector()
        self._set_state(listening=True, error=None)
        while True:
            pcm = process.stdout.read(FRAME_BYTES)
            if len(pcm) != FRAME_BYTES:
                break
            event = detector.process(pcm, time.monotonic())
            if event in {"clap", "clap-pair"}:
                with self.lock:
                    self.last_clap_at = self._timestamp()
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
            try:
                self._record_once()
            except Exception as error:
                message = str(error)[:300]
                LOGGER.warning("Clap listener unavailable: %s", message)
                self._set_state(listening=False, error=message)
                time.sleep(5)
