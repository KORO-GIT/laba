#!/usr/bin/python3
import glob
import os
import stat
import subprocess
import time

CONTROL_SOCKET = "/run/laba-wayvnc-web/wayvncctl.sock"
DISPLAY_GLOB = "/run/user/[0-9]*/wayland-[0-9]*"
WAYVNCCTL = "/usr/bin/wayvncctl"


def run_control(*arguments):
    try:
        result = subprocess.run(
            [WAYVNCCTL, f"--socket={CONTROL_SOCKET}", *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def wayland_displays():
    for path in sorted(glob.glob(DISPLAY_GLOB)):
        try:
            if stat.S_ISSOCK(os.stat(path).st_mode):
                yield path
        except (FileNotFoundError, PermissionError):
            continue


def attach_any_display():
    for display in wayland_displays():
        if run_control("attach", display):
            print(f"Attached browser WayVNC to {display}", flush=True)
            return True
    return False


def main():
    while True:
        if not run_control("output-list"):
            # wayvnc creates its control socket before all encoders and the
            # detached compositor state are ready. Attaching immediately can
            # trigger an upstream wayvnc race, so wait and verify once more.
            time.sleep(3)
            if run_control("output-list"):
                continue
            attach_any_display()
            time.sleep(3)
            continue
        time.sleep(10)


if __name__ == "__main__":
    main()
