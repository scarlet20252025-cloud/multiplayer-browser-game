#!/usr/bin/env python3
"""Read-only, dependency-free inventory of an extracted game archive.

This is a lexical/source inventory, not a compiler, emulator, or compatibility
test. It never imports or executes files from the inspected archive. Reports
and optional file manifests must be written outside the input directory.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import sys


SOURCE_EXTENSIONS = {".as", ".asasm", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".cpp", ".hpp", ".c", ".h", ".hx"}
TEXT_EXTENSIONS = SOURCE_EXTENSIONS | {".json", ".md", ".txt", ".py", ".xml", ".html", ".htm", ".css", ".yaml", ".yml", ".toml"}
ASSET_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp3", ".ogg", ".wav", ".flac", ".ttf", ".otf", ".woff", ".woff2"}
JS_EXTENSIONS = {".js", ".mjs", ".cjs"}
BUILD_NAMES = {"package.json", "tsconfig.json", "CMakeLists.txt", "pom.xml", "build.xml", "asconfig.json", "project.xml", "Makefile"}
KEY_NAMES = {"Main.as", "Game.as", "level.as", "Level.as", "Hero.as", "Input.as", "World.as", "WCK.as", "FireManHero.as", "IceManHero.as", "FireBoy.as", "WaterGirl.as", "b2Base.as", "b2World.as", "Conf.as"} | BUILD_NAMES

FEATURES = {
    "decompiler_pseudo_instructions": r"\u00a7\u00a7",
    "flash_imports": r"\bimport\s+flash\.",
    "flash_display_api": r"flash\.display\.|\bMovieClip\b|\bDisplayObject(?:Container)?\b",
    "flash_frame_events": r"\bENTER_FRAME\b|\bEXIT_FRAME\b|\bFRAME_CONSTRUCTED\b",
    "flash_keyboard_events": r"\bKeyboardEvent\b|\bKey\.isDown\b",
    "flash_display_hit_tests": r"\bhitTest(?:Object|Point)\b",
    "flash_timeline_state": r"\bcurrentFrame\b|\bgotoAnd(?:Play|Stop)\b|\baddFrameScript\b",
    "alchemy_cmodule": r"\bcmodule\.|\bCLibInit\b|\bdomainMemory\b|avm2\.intrinsics|\b(?:li8|li16|li32|lf32|lf64|si8|si16|si32|sf32|sf64)\s*\(",
    "box2d": r"\bBox2D(?:AS)?\b|\bb2World\b",
    "random": r"\bMath\.random\s*\(",
    "wall_clock_and_timers": r"\bgetTimer\s*\(|\bDate\.now\s*\(|\bnew\s+Date\b|\b(?:setTimeout|setInterval)\s*\(|\bTimerEvent\b|\bnew\s+Timer\s*\(",
    "runtime_frame_rate": r"\bframeRate\b",
    "local_persistence": r"\bSharedObject\b|\blocalStorage\b|\bsessionStorage\b",
    "external_interface": r"\bExternalInterface\b",
    "embed_metadata": r"\[\s*Embed\b",
}
COMPILED_FEATURES = {name: re.compile(pattern) for name, pattern in FEATURES.items()}


def group_for(relative: Path) -> str:
    """Recognize supplied game variants; retain meaningful generic fallbacks."""
    parts = relative.parts
    if parts and parts[0] == "01-shanyi-binary":
        variant = parts[1] if len(parts) > 1 else "root"
        return "shanyi/" + variant
    if parts and parts[0] == "02-fireboy-watergirl":
        if len(parts) > 2 and parts[1] == "decompiled":
            return "fireboy-watergirl/flash/" + parts[2]
        if len(parts) > 3 and parts[1:3] == ("html5-online", "games"):
            return "fireboy-watergirl/html5/" + parts[3]
        return "fireboy-watergirl/" + (parts[1] if len(parts) > 1 else "root")
    return parts[0] if len(parts) > 1 else "archive-root"


def blank_counts() -> dict:
    return {
        "files": 0,
        "source_files": 0,
        "bytes": 0,
        "extensions": Counter(),
        "runtime_files": {"swf": 0, "javascript": 0, "html": 0, "assets": 0, "abc_bytecode": 0},
        "features": {name: {"files": 0, "occurrences": 0, "examples": []} for name in FEATURES},
        "build_files": [],
    }


def inspect_counts(counts: dict, relative: str, data: bytes, matches: dict, examples_limit: int) -> None:
    path = Path(relative)
    suffix = path.suffix.lower()
    counts["files"] += 1
    counts["source_files"] += int(suffix in SOURCE_EXTENSIONS)
    counts["bytes"] += len(data)
    counts["extensions"][suffix or "<none>"] += 1
    for kind, applies in {
        "swf": suffix == ".swf",
        "javascript": suffix in JS_EXTENSIONS,
        "html": suffix in {".html", ".htm"},
        "assets": suffix in ASSET_EXTENSIONS,
        "abc_bytecode": suffix == ".abc",
    }.items():
        counts["runtime_files"][kind] += int(applies)
    if path.name in BUILD_NAMES:
        counts["build_files"].append(relative)
    for name, result in matches.items():
        if result["occurrences"]:
            feature = counts["features"][name]
            feature["files"] += 1
            feature["occurrences"] += result["occurrences"]
            if len(feature["examples"]) < examples_limit:
                feature["examples"].append({"path": relative, "first_line": result["first_line"]})


def resolve_root(root: Path) -> tuple[Path, Path]:
    supplied = root.resolve(strict=True)
    if not supplied.is_dir():
        raise ValueError("Input must be an extracted archive directory, not a ZIP file.")
    effective = supplied
    if not (effective / "01-shanyi-binary").exists() and not (effective / "02-fireboy-watergirl").exists():
        candidates = [p for p in effective.iterdir() if p.is_dir() and not p.is_symlink() and ((p / "01-shanyi-binary").is_dir() or (p / "02-fireboy-watergirl").is_dir())]
        if len(candidates) == 1:
            effective = candidates[0]
    return supplied, effective


def report_path(value: str | None, protected_root: Path) -> Path | None:
    if value is None or value == "-":
        return None
    path = Path(value).expanduser().resolve()
    if path.is_relative_to(protected_root):
        raise ValueError("Report output must be outside the inspected directory (read-only input).")
    return path


def audit(supplied_root: Path, root: Path, examples_limit: int) -> tuple[dict, list]:
    totals = blank_counts()
    groups: dict[str, dict] = {}
    manifest = []
    key_files = []
    skipped = []
    decode_errors = []
    replacement_character_files = []
    for current, directories, filenames in os.walk(root, followlinks=False):
        current_path = Path(current)
        for directory in sorted(directories):
            candidate = current_path / directory
            if candidate.is_symlink():
                skipped.append({"path": candidate.relative_to(root).as_posix(), "reason": "directory-symlink"})
        directories[:] = sorted(name for name in directories if name not in {".git", "node_modules", "__pycache__"} and not (current_path / name).is_symlink())
        for name in sorted(filenames):
            path = current_path / name
            relative = path.relative_to(root)
            relative_text = relative.as_posix()
            if path.is_symlink():
                skipped.append({"path": relative_text, "reason": "file-symlink"})
                continue
            try:
                data = path.read_bytes()
            except OSError as error:
                skipped.append({"path": relative_text, "reason": type(error).__name__})
                continue
            digest = hashlib.sha256(data).hexdigest()
            entry = {"path": relative_text, "bytes": len(data), "sha256": digest}
            manifest.append(entry)
            if path.name in KEY_NAMES:
                key_files.append(entry)
            matches = {}
            if path.suffix.lower() in TEXT_EXTENSIONS or path.name in BUILD_NAMES:
                try:
                    text = data.decode("utf-8-sig")
                except UnicodeDecodeError:
                    decode_errors.append(relative_text)
                else:
                    if "\ufffd" in text:
                        replacement_character_files.append(relative_text)
                    if path.suffix.lower() in SOURCE_EXTENSIONS:
                        for feature, pattern in COMPILED_FEATURES.items():
                            found = list(pattern.finditer(text))
                            matches[feature] = {"occurrences": len(found), "first_line": text.count("\n", 0, found[0].start()) + 1 if found else None}
            inspect_counts(totals, relative_text, data, matches, examples_limit)
            group = groups.setdefault(group_for(relative), blank_counts())
            inspect_counts(group, relative_text, data, matches, examples_limit)
    manifest.sort(key=lambda item: item["path"])
    key_files.sort(key=lambda item: item["path"])
    inventory_bytes = "".join(f"{item['path']}\0{item['bytes']}\0{item['sha256']}\n" for item in manifest).encode("utf-8")
    limitations = [
        "Static lexical audit only: no source was executed, compiled, rendered, or tested for multiplayer compatibility.",
        "Feature matches can occur in comments, imports, or unreachable code; they locate review targets, not confirmed runtime behavior.",
        "A source count or readable decompilation does not prove that a complete, buildable original project exists.",
        "Input symlinks are skipped; .git, node_modules and __pycache__ directories are excluded.",
    ]
    if not totals["runtime_files"]["swf"]:
        limitations.append("No SWF is present in this input; original Flash playback and binary-patch tests require a separate runtime package.")
    if not totals["runtime_files"]["javascript"]:
        limitations.append("No JavaScript runtime file is present; HTML5 level JSON alone is not a playable HTML5 game.")
    if totals["features"]["decompiler_pseudo_instructions"]["files"]:
        limitations.append("Decompiler pseudo instructions are present; normal ActionScript recompilation is not established.")
    report = {
        "schema_version": 1,
        "analysis_type": "static-only",
        "supplied_root": str(supplied_root),
        "effective_root": str(root),
        "inventory_sha256": hashlib.sha256(inventory_bytes).hexdigest(),
        "totals": totals,
        "groups": dict(sorted(groups.items())),
        "key_files": key_files,
        "text_validation": {"encoding": "utf-8-sig", "extensions": sorted(TEXT_EXTENSIONS), "decode_error_files": decode_errors, "replacement_character_files": replacement_character_files},
        "skipped": skipped,
        "limitations": limitations,
    }
    return report, manifest


def write_json(value: object, path: Path | None) -> None:
    encoded = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if path is None:
        sys.stdout.write(encoded)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(encoded, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="Extracted archive directory (or its single enclosing directory)")
    parser.add_argument("--output", "-o", help="JSON report path outside the input; default: stdout")
    parser.add_argument("--manifest", help="Optional complete SHA-256 manifest path outside the input")
    parser.add_argument("--examples", type=int, default=5, help="Maximum example file/line locations per feature and group (default: 5)")
    args = parser.parse_args()
    try:
        if args.examples < 0:
            raise ValueError("--examples must be zero or positive.")
        supplied, root = resolve_root(args.root.expanduser())
        output = report_path(args.output, supplied)
        manifest_path = report_path(args.manifest, supplied)
        if args.manifest == "-":
            raise ValueError("--manifest needs a file path; stdout is reserved for the report.")
        if output is not None and output == manifest_path:
            raise ValueError("Report and manifest paths must be different.")
        report, manifest = audit(supplied, root, args.examples)
        write_json(report, output)
        if manifest_path is not None:
            write_json({"schema_version": 1, "inventory_sha256": report["inventory_sha256"], "files": manifest}, manifest_path)
        if output:
            print(f"Audited {report['totals']['files']} files; static report: {output}", file=sys.stderr)
        return 0
    except (OSError, ValueError) as error:
        print(f"audit_archive: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
