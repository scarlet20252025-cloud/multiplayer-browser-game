#!/usr/bin/env python3
"""Read-only provenance audit for a privately held six-game HTML5 ZIP.

No executable game code is run, rewritten, extracted or published.
Successful ZIP inspection does not mean gameplay/netplay passed.
"""
import argparse
import hashlib
import json
import re
import stat
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

MAX_ENTRIES = 20000
MAX_ENTRY_BYTES = 128 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
KNOWN_CANDIDATE_SHA256 = "337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677"
GAME_JS = re.compile(r"(?:^|/)games/([1-6])-[^/]+/js/game\.js$", re.IGNORECASE)


class UnsafeArchive(ValueError):
    pass


def file_sha256(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_path(raw):
    if not isinstance(raw, str) or not raw or raw.startswith("/") or "\\" in raw or "\x00" in raw or ":" in raw.split("/")[0]:
        raise UnsafeArchive("Unsafe or absolute entry path")
    path = raw.rstrip("/")
    components = path.split("/")
    if any(component in {"", ".", ".."} for component in components):
        raise UnsafeArchive("Noncanonical or traversal entry path")
    if len(components) > 40 or len(raw) > 1024 or str(PurePosixPath(path)) != path:
        raise UnsafeArchive("Entry path exceeds limits or is noncanonical")
    return path


def inspect(archive_path):
    archive_path = Path(archive_path)
    result = {
        "schemaVersion": 1,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "ZIP-only read-only provenance; no game executed",
        "archive": {"bytes": archive_path.stat().st_size, "sha256": file_sha256(archive_path)},
        "gameplayVerified": False,
        "netplayVerified": False,
        "files": [],
        "games": {},
        "missingScriptVersions": [],
    }
    seen = set()
    total = 0
    with zipfile.ZipFile(archive_path) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            raise UnsafeArchive("Too many archive entries")
        for info in infos:
            name = safe_path(info.filename)
            folded = name.casefold()
            if folded in seen:
                raise UnsafeArchive("Duplicate or case-conflicting entry")
            seen.add(folded)
            if stat.S_IFMT(info.external_attr >> 16) == stat.S_IFLNK:
                raise UnsafeArchive("Symlink entry not allowed")
            if info.flag_bits & 1:
                raise UnsafeArchive("Encrypted entry not allowed")
            if info.is_dir():
                continue
            total += info.file_size
            if info.file_size > MAX_ENTRY_BYTES or total > MAX_TOTAL_BYTES:
                raise UnsafeArchive("Entry or uncompressed total exceeds quota")
            match = GAME_JS.search(name)
            chunks = [] if match else None
            digest = hashlib.sha256()
            count = 0
            with zf.open(info) as stream:
                while True:
                    block = stream.read(1024 * 1024)
                    if not block:
                        break
                    count += len(block)
                    if count > MAX_ENTRY_BYTES:
                        raise UnsafeArchive("Entry expanded beyond quota")
                    digest.update(block)
                    if chunks is not None:
                        chunks.append(block)
            if count != info.file_size:
                raise UnsafeArchive("Entry length does not match ZIP metadata")
            row = {"relativePath": name, "bytes": count, "sha256": digest.hexdigest(),
                   "kind": "game-script" if match else "other"}
            result["files"].append(row)
            if match:
                version = match.group(1)
                if version in result["games"]:
                    raise UnsafeArchive("Multiple primary scripts for version " + version)
                try:
                    content = b"".join(chunks).decode("utf-8")
                except UnicodeDecodeError as error:
                    raise UnsafeArchive("Game script must be valid UTF-8") from error
                lines = content.replace("\r\n", "\n").replace("\r", "\n")
                result["games"][version] = {
                    "version": int(version), "path": name, "bytes": count, "sha256": row["sha256"],
                    "normalizedLineEndingsSha256": hashlib.sha256(lines.encode("utf-8")).hexdigest(),
                    "lineCount": len(lines.splitlines()), "crlfCount": content.count("\r\n"),
                    "knownResearchCandidateSha256": KNOWN_CANDIDATE_SHA256 if version == "1" else None,
                    "identicalToResearchCandidate": row["sha256"] == KNOWN_CANDIDATE_SHA256 if version == "1" else None,
                    "anchorCounts": {
                        "(o = new h.Game(m)),": content.count("(o = new h.Game(m)),"),
                        "prohibitJump": content.count("prohibitJump"),
                        "togglePause": content.count("togglePause"),
                        "MechManager": content.count("MechManager"),
                    } if version == "1" else {},
                }
    result["archive"]["fileCount"] = len(result["files"])
    result["archive"]["totalUncompressedFileBytes"] = total
    result["missingScriptVersions"] = [v for v in "123456" if v not in result["games"]]
    result["status"] = "inspected" if not result["missingScriptVersions"] else "partial"
    result["notes"] = [
        "Hashes are computed from exact original bytes.",
        "Different hash from pinned candidate means version identity is unverified, not necessarily an error.",
        "ZIP analysis cannot establish original gameplay or two-player netplay.",
        "Do not upload the original package or third-party game assets to the public repository.",
    ]
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("--out", default="local/html5-upload-audit.json")
    args = parser.parse_args(argv)
    try:
        result = inspect(args.archive)
        destination = Path(args.out)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, UnsafeArchive) as error:
        print(f"HTML5_ZIP_AUDIT_FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    print(json.dumps({
        "status": result["status"], "archiveSha256": result["archive"]["sha256"],
        "fileCount": result["archive"]["fileCount"], "versions": sorted(result["games"]),
        "firstGameSha256": result["games"].get("1", {}).get("sha256"),
        "report": str(destination), "gameplayVerified": False,
    }, ensure_ascii=False))
    return 0 if result["status"] == "inspected" else 1


if __name__ == "__main__":
    raise SystemExit(main())
