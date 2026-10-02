#!/usr/bin/env python3
"""Forced-command SSH receiver: lets a key deploy the office relay and nothing else.

Installed OUTSIDE the relay directory (a deploy rewrites that directory, so it must never be able to rewrite
this file) and bound to a key in ~deploy/.ssh/authorized_keys:

    restrict,command="/usr/bin/python3 /home/deploy/gg-office-relay-deploy/receive.py" ssh-ed25519 AAAA... name

The key may only replace the relay's application source (package.json, package-lock.json, tsconfig.json,
src/) and rebuild it. The Dockerfile, docker-compose.yml and .env stay as the box has them: those decide
what the container may mount, which networks it joins and whether it is privileged, and `deploy` is in the
docker group, so whoever controls them controls the host.

Commands (the remote command line, read from SSH_ORIGINAL_COMMAND):
    deploy   stdin = gzipped tar of exactly the files above; installs them, rebuilds, prints health
    status   docker compose ps + health
    logs     the relay container's last 200 log lines
"""
import fcntl
import io
import os
import shutil
import subprocess
import sys
import tarfile
import time

HOME = os.path.expanduser("~")
RELAY_DIR = os.path.join(HOME, "gg-office-relay")
STATE_DIR = os.path.join(HOME, "gg-office-relay-deploy")
AUDIT_LOG = os.path.join(STATE_DIR, "deploys.log")

SOURCE_FILES = ("package.json", "package-lock.json", "tsconfig.json")
SOURCE_DIR = "src"
MAX_UPLOAD_BYTES = 16 * 1024 * 1024
MAX_UNPACKED_BYTES = 64 * 1024 * 1024
MAX_MEMBERS = 2000

HEALTH_PROBE = "fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(console.log)"


class Refused(Exception):
    pass


def main():
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "").strip()
    handlers = {"deploy": deploy, "status": status, "logs": logs}
    handler = handlers.get(command)
    if handler is None:
        print(f"refused: this key can only run: {', '.join(handlers)} (got {command!r})", file=sys.stderr)
        audit(command, "refused-command")
        return 2
    try:
        code = handler()
    except Refused as refusal:
        print(f"refused: {refusal}", file=sys.stderr)
        audit(command, f"refused: {refusal}")
        return 2
    audit(command, "ok" if code == 0 else f"exit {code}")
    return code


def deploy():
    if not os.path.isfile(os.path.join(RELAY_DIR, ".env")):
        raise Refused(f"{RELAY_DIR}/.env is missing; the box owner sets JOIN_CODE and ADMIN_TOKEN there first")
    with exclusive_lock():
        staging = os.path.join(STATE_DIR, "incoming")
        previous = os.path.join(STATE_DIR, "previous")
        reset_dir(staging)
        unpack_upload(read_upload(), staging)
        reset_dir(previous)
        swap_source(RELAY_DIR, staging, keep_in=previous)
        code = compose("up", "-d", "--build")
        if code != 0:
            print("deploy failed: restoring the previous source on the box")
            swap_source(RELAY_DIR, previous, keep_in=staging)
            return code
        compose("ps")
        return health()


def status():
    compose("ps")
    return health()


def logs():
    return compose("logs", "--no-color", "--tail", "200", "relay")


def read_upload():
    data = sys.stdin.buffer.read(MAX_UPLOAD_BYTES + 1)
    if not data:
        raise Refused("deploy expects the source tarball on stdin")
    if len(data) > MAX_UPLOAD_BYTES:
        raise Refused(f"upload exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    return data


def unpack_upload(data, staging):
    try:
        archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    except tarfile.TarError as error:
        raise Refused(f"not a gzipped tar: {error}")
    with archive:
        members = archive.getmembers()
        check_members(members)
        archive.extractall(staging, members=members, filter="data")
    missing = [name for name in SOURCE_FILES if not os.path.isfile(os.path.join(staging, name))]
    if missing or not os.path.isdir(os.path.join(staging, SOURCE_DIR)):
        raise Refused(f"upload must contain {', '.join(SOURCE_FILES)} and {SOURCE_DIR}/ (missing: {missing or [SOURCE_DIR]})")


def check_members(members):
    if len(members) > MAX_MEMBERS:
        raise Refused(f"upload has more than {MAX_MEMBERS} entries")
    unpacked = 0
    for member in members:
        name = member.name[2:] if member.name.startswith("./") else member.name
        member.name = name
        if not (member.isfile() or member.isdir()):
            raise Refused(f"{name}: only regular files and directories are accepted")
        parts = name.split("/")
        if name.startswith("/") or ".." in parts or "\\" in name:
            raise Refused(f"{name}: path escapes the relay directory")
        allowed = (member.isfile() and name in SOURCE_FILES) or parts[0] == SOURCE_DIR
        if not allowed:
            raise Refused(f"{name}: only {', '.join(SOURCE_FILES)} and {SOURCE_DIR}/ may be deployed with this key "
                          "(Dockerfile, docker-compose.yml and .env are pinned on the box)")
        unpacked += member.size
        if unpacked > MAX_UNPACKED_BYTES:
            raise Refused(f"upload unpacks to more than {MAX_UNPACKED_BYTES // (1024 * 1024)} MB")


def swap_source(target, incoming, keep_in):
    """Move target's current source into keep_in, then incoming's source into target."""
    for name in SOURCE_FILES + (SOURCE_DIR,):
        if not os.path.lexists(os.path.join(incoming, name)):
            continue
        current = os.path.join(target, name)
        if os.path.lexists(current):
            os.rename(current, os.path.join(keep_in, name))
        os.rename(os.path.join(incoming, name), current)


def compose(*args):
    # An explicit -f also stops compose from auto-loading a docker-compose.override.yml.
    return run(["docker", "compose", "-f", os.path.join(RELAY_DIR, "docker-compose.yml"),
                "--project-directory", RELAY_DIR, *args])


def health():
    print("health:", flush=True)
    return run(["docker", "exec", "gg-office-relay", "node", "-e", HEALTH_PROBE])


def run(argv):
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": HOME, "LANG": "C.UTF-8"}
    return subprocess.run(argv, cwd=RELAY_DIR, env=env, stdin=subprocess.DEVNULL, stderr=subprocess.STDOUT).returncode


def reset_dir(path):
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path)


class exclusive_lock:
    def __enter__(self):
        self.handle = open(os.path.join(STATE_DIR, "deploy.lock"), "w")
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.handle.close()
            raise Refused("another relay deploy is running; try again when it finishes")
        return self

    def __exit__(self, *exc):
        self.handle.close()


def audit(command, outcome):
    client = os.environ.get("SSH_CLIENT", "?").split(" ")[0]
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    with open(AUDIT_LOG, "a") as log:
        log.write(f"{stamp} {client} {command or '-'} {outcome}\n")


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    os.makedirs(STATE_DIR, exist_ok=True)
    sys.exit(main())
