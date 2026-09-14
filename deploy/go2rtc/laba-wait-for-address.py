#!/usr/bin/python3
from __future__ import annotations

import errno
import ipaddress
import socket
import sys
import time


def address_is_available(address: str) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((address, 0))
        return True
    except OSError as error:
        if error.errno == errno.EADDRNOTAVAIL:
            return False
        raise
    finally:
        probe.close()


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: laba-wait-for-address.py <IPv4> <timeout-seconds>", file=sys.stderr)
        return 2

    try:
        address = ipaddress.ip_address(argv[1])
        timeout = float(argv[2])
    except ValueError as error:
        print(f"invalid argument: {error}", file=sys.stderr)
        return 2

    if address.version != 4 or address.is_unspecified or not 1 <= timeout <= 300:
        print("address must be a specific IPv4 and timeout must be within 1..300 seconds", file=sys.stderr)
        return 2

    text_address = str(address)
    deadline = time.monotonic() + timeout
    print(f"waiting for local IPv4 address {text_address}", flush=True)

    while True:
        if address_is_available(text_address):
            print(f"local IPv4 address {text_address} is ready", flush=True)
            return 0

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print(f"timed out waiting for local IPv4 address {text_address}", file=sys.stderr)
            return 1
        time.sleep(min(1.0, remaining))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
