#!/usr/bin/env python3
"""Check committable repository text without walking dependencies or game assets.

Git supplies tracked files plus untracked, non-ignored candidates. Known binary
formats and private/generated directories are excluded before opening a file.
Symlinks are never followed. Unknown formats containing NUL bytes are treated as
binary; known text formats must decode as UTF-8 and contain neither NUL nor the
Unicode replacement character (U+FFFD).
"""

from __future__ import annotations

import os
from pathlib import Path
import stat
import subprocess
import sys


EXCLUDED_DIRECTORIES = frozenset({
    ".git", "node_modules", "local", "private-games", "__pycache__", "upload", "uploads",
})
BINARY_SUFFIXES = frozenset({
    ".7z", ".avif", ".bin", ".bmp", ".bz2", ".class", ".db", ".dll", ".dylib", ".eot",
    ".exe", ".flac", ".gif", ".gz", ".icns", ".ico", ".jar", ".jpeg", ".jpg",
    ".mov", ".mp3", ".mp4", ".oga", ".ogg", ".ogv", ".otf", ".pdf", ".png",
    ".pyc", ".pyo", ".rar", ".so", ".sqlite", ".sqlite3", ".swc", ".swf",
    ".tar", ".tif", ".tiff", ".ttf", ".wasm", ".wav", ".webm", ".webp",
    ".woff", ".woff2", ".xz", ".zip", ".zst",
})
TEXT_SUFFIXES = frozenset({
    ".as", ".bat", ".c", ".cfg", ".cjs", ".cmd", ".conf", ".cpp", ".css",
    ".csv", ".env", ".h", ".hpp", ".htm", ".html", ".ini", ".java", ".js",
    ".json", ".jsonc", ".jsonl", ".jsx", ".lock", ".map", ".md", ".mjs",
    ".ps1", ".py", ".rb", ".rs", ".sh", ".sql", ".svg", ".text", ".toml",
    ".ts", ".tsv", ".tsx", ".txt", ".xml", ".yaml", ".yml",
})
TEXT_NAMES = frozenset({
    ".dockerignore", ".editorconfig", ".gitattributes", ".gitignore", ".npmrc",
    ".nvmrc", "CMakeLists.txt", "Dockerfile", "LICENSE", "Makefile", "NOTICE",
})


def git_output(root: Path, *arguments: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(root), *arguments], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout


def check_repository(root: Path) -> tuple[int, int, list[str]]:
    """Return (checked text files, skipped candidates, validation failures)."""
    root = root.resolve()
    actual_root = Path(os.fsdecode(git_output(root, "rev-parse", "--show-toplevel")).strip()).resolve()
    if actual_root != root:
        raise ValueError(f"Expected repository root {root}, received {actual_root}")

    names = set(git_output(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split(b"\0"))
    checked = 0
    skipped = 0
    failures: list[str] = []
    for raw_name in sorted(names - {b""}):
        relative = Path(os.fsdecode(raw_name))
        if relative.is_absolute() or ".." in relative.parts:
            failures.append(f"{relative}: path is outside the repository")
            continue
        if any(part in EXCLUDED_DIRECTORIES for part in relative.parts[:-1]) or relative.suffix.lower() in BINARY_SUFFIXES:
            skipped += 1
            continue
        path = root / relative
        try:
            mode = path.lstat().st_mode
            if not stat.S_ISREG(mode):
                # Git stores a symlink's target string, not the target's content.
                skipped += 1
                continue
            if not path.resolve().is_relative_to(root):
                failures.append(f"{relative}: refusing to read a path outside the repository")
                continue
            data = path.read_bytes()
        except FileNotFoundError:
            # A tracked file deleted in the working tree is not committed text.
            skipped += 1
            continue
        except OSError as error:
            failures.append(f"{relative}: cannot read file: {error}")
            continue

        known_text = relative.suffix.lower() in TEXT_SUFFIXES or relative.name in TEXT_NAMES or relative.name.startswith(".env")
        if b"\0" in data and not known_text:
            skipped += 1
            continue
        checked += 1
        try:
            text = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            line = data[:error.start].count(b"\n") + 1
            failures.append(f"{relative}:{line}: invalid UTF-8 at byte {error.start}: {error.reason}")
            continue
        if "\0" in text:
            failures.append(f"{relative}: NUL byte in a text file; check its encoding")
        replacement = text.find("\ufffd")
        if replacement != -1:
            line = text.count("\n", 0, replacement) + 1
            column = replacement - text.rfind("\n", 0, replacement)
            failures.append(f"{relative}:{line}:{column}: unexpected U+FFFD replacement character")
    return checked, skipped, failures


def main() -> int:
    try:
        checked, skipped, failures = check_repository(Path(__file__).resolve().parent.parent)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"UTF-8 check could not run: {error}", file=sys.stderr)
        return 2
    if failures:
        print(f"UTF-8 check failed ({checked} text files checked, {skipped} candidates skipped):", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print(f"UTF-8 check passed: {checked} text files; {skipped} binary, excluded, deleted or symlink candidates skipped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
