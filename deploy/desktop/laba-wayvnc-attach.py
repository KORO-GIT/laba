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


def socket_identity(path):
    try:
        metadata = os.stat(path)
        if stat.S_ISSOCK(metadata.st_mode):
            return metadata.st_dev, metadata.st_ino
    except (FileNotFoundError, PermissionError):
        pass
    return None


def main():
    attached_control = None

    while True:
        control = socket_identity(CONTROL_SOCKET)
        if control is None:
            attached_control = None
            time.sleep(2)
            continue

        if control != attached_control:
            # wayvnc 0.9.1 on Raspberry Pi can segfault when output-list is
            # queried before a detached instance is attached. It also creates
            # the control socket before startup is fully settled, so never
            # probe output-list here and give the new process time to settle.
            time.sleep(10)
            if socket_identity(CONTROL_SOCKET) != control:
                continue
            if attach_any_display():
                attached_control = control
            else:
                time.sleep(3)
                continue

        time.sleep(10)


if __name__ == "__main__":
    main()
