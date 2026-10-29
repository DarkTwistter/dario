#!/usr/bin/env python3
"""Preserve compatible browser directories; archive newer/unknown formats before a Stable downgrade."""
import argparse
import contextlib
import datetime
import errno
import fcntl
import os
from pathlib import Path
import re
import socket
import stat


def version(value):
    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", value.strip()):
        raise ValueError("Expected a four-part Chrome version")
    return tuple(map(int, value.strip().split(".")))


def prepare(root, target):
    target_version = version(target)
    if root.is_symlink():
        raise RuntimeError("Profile root must not be a symlink")
    if not root.exists():
        return []
    plans = []
    with contextlib.ExitStack() as stack:
        for profile in sorted(root.iterdir()):
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", profile.name):
                continue
            if profile.is_symlink():
                raise RuntimeError("Profile directory must not be a symlink: " + profile.name)
            browser = profile / "browser"
            if browser.is_symlink():
                raise RuntimeError("Browser directory must not be a symlink: " + profile.name)
            if not browser.exists():
                continue
            if not browser.is_dir() or browser.is_symlink():
                raise RuntimeError("Browser directory must be a regular directory: " + profile.name)
            lock_path = profile / "browser.lock"
            flags = os.O_RDWR | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
            try:
                fd = os.open(lock_path, flags | os.O_CREAT | os.O_EXCL, 0o600)
                if os.geteuid() == 0:
                    owner = profile.stat()
                    os.fchown(fd, owner.st_uid, owner.st_gid)
            except FileExistsError:
                fd = os.open(lock_path, flags)
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                os.close(fd)
                raise RuntimeError("Browser lock must be a regular file: " + profile.name)
            lock = stack.enter_context(os.fdopen(fd, "r+b"))
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("Close the active profile browser before switching: " + profile.name)
            singleton = browser / "SingletonLock"
            if singleton.is_symlink():
                match = re.fullmatch(r"(.*)-(\d+)", os.readlink(singleton))
                if not match or match[1] != socket.gethostname() or int(match[2]) <= 0:
                    raise RuntimeError("Cannot verify Chromium owner: " + profile.name)
                try:
                    os.kill(int(match[2]), 0)
                except OSError as error:
                    if error.errno != errno.ESRCH:
                        raise RuntimeError("Cannot verify Chromium owner: " + profile.name)
                else:
                    raise RuntimeError("Close the profile browser in VNC: " + profile.name)
            elif singleton.exists():
                raise RuntimeError("Cannot verify Chromium lock: " + profile.name)
            marker = browser / "Last Version"
            try:
                if marker.is_symlink() or not marker.is_file() or marker.stat().st_size > 256:
                    raise ValueError("Invalid version marker")
                previous = version(marker.read_text())
            except (OSError, ValueError):
                previous = None
            if previous is None or previous > target_version:
                plans.append(browser)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        archives = []
        for browser in plans:
            backup = browser.with_name("browser-before-stable-" + stamp)
            browser.rename(backup)
            archives.append(backup)
            print("Archived incompatible/unknown browser data: " + str(backup))
        return archives


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("profiles", type=Path)
    parser.add_argument("chrome_version")
    args = parser.parse_args()
    try:
        prepare(args.profiles, args.chrome_version)
    except (RuntimeError, ValueError, OSError) as error:
        parser.exit(1, str(error) + "\n")
