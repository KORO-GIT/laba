#!/usr/bin/python3
"""Provision a new encrypted systemd credential without printing the secret."""

from __future__ import annotations

import os
import pwd
import secrets
import subprocess
from pathlib import Path


plain_path = Path("/tmp/laba-audio-agent-token")
encrypted_path = Path("/etc/credstore.encrypted/laba-audio-agent-token")
encrypted_temp_path = encrypted_path.with_name(f".{encrypted_path.name}.tmp")
token = secrets.token_urlsafe(48)

plain_path.write_text(f"{token}\n", encoding="utf-8")
os.chmod(plain_path, 0o600)
encrypted_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
encrypted_temp_path.unlink(missing_ok=True)
subprocess.run(
    [
        "/usr/bin/systemd-creds",
        "encrypt",
        "--name=AUDIO_AGENT_TOKEN",
        str(plain_path),
        str(encrypted_temp_path),
    ],
    check=True,
    stdin=subprocess.DEVNULL,
)
os.chmod(encrypted_temp_path, 0o600)
os.replace(encrypted_temp_path, encrypted_path)
portal_user = pwd.getpwnam("korob")
os.chown(plain_path, portal_user.pw_uid, portal_user.pw_gid)
print("Audio agent credential provisioned; copy the temporary token to the VPS, then delete it.")
