"""Load an existing web release from the browser's provider bridge."""

import asyncio
import base64
import hashlib
import json
import os
import platform
import re
import sys
import time
from pathlib import Path
from sync_client import main as run_session


MANIFEST = "manifests/glorton_manifest.json"
PORTRAIT_PATH = re.compile(r"assets/web/([a-f0-9]{24}\.png)")
PNG_HEADER = b"\x89PNG\r\n\x1a\n"
MAX_PORTRAIT_BYTES = 16_384
SOURCE = {
    "src/assets.py": (2555, "acab45af294fefa7ab740bb81ded38c2c5518d87b41e378497c019fd9393b1bd"),
    "src/audio.py": (3294, "1b6920471353cd1939fd5dba805d6bed07ac8805b321d8878d86a05c23f8a9af"),
    "src/display.py": (3944, "681d68e0043549eb98c8616e6f6c31ae488e15ed2495fccac4aa18cafe9356bd"),
    "src/menu.py": (74926, "c9e8382fedc4efd2432eaaeb5544720ea9543009a0b557ad1e0abacfde0e8f7b"),
    "src/mobile_controls.py": (12744, "f4a417276a7f3f31b585c96a4ab2f7b8f6781826d11541b38b1287d4cd3a28f4"),
    "src/roster_web_deployment.py": (1972, "1497cc8b518e50fff4c5e9aefad44157a99e7a196d4d63bcfada7d742f14801c"),
    "src/runtime.py": (243419, "932f66e8e75ca39bc68a331849d68ba3377e78cf9dca7c3c6e11286b9bcf0896"),
    "src/simulation.py": (33781, "0b7333607a35237cbc91119aca83f86469ee863f93cf8b0f14ccdcfb3ae51956"),
    "src/v5_web_deployment.py": (9796, "78fc1e3b45cdd37123a400ebbda0fd517a206cead655c8d83a28a9105f2a995b"),
    "src/visual_check.py": (5606, "c510bd3fcb1e7019caca1908049d57f041e9ae9cc756f82429fd422196c02e48"),
    "online/__init__.py": (129, "316a41ceb99706924e0774610bc0163510760b1686c2ddefc0ef6cef5b199146"),
    "online/ai_config.py": (1485, "70d80ea8db5ce29fca2caf8840ad7892658f6dfd8147d0b698353762d4aa090a"),
    "online/client.py": (26420, "35f5fe8fac80019cda3f8c0cbc44b977e0bc9976293ac3cc7ab8d554d0e9b597"),
    "online/protocol.py": (3811, "fa9acbece440e342d7e7a7d75b6203863e4c6c42c60c77273198205d774d628d"),
}


def matches_source(relative, content):
    size, digest = SOURCE[relative]
    return len(content) == size and hashlib.sha256(content).hexdigest() == digest


async def mount_archive(window, archive_url, mount):
    mount.mkdir()
    config = {
        "io": "url",
        "type": "mount",
        "mount": {"point": mount.as_posix(), "path": "/"},
        "path": f"/ => {mount.as_posix()}",
    }
    track = window.MM.prepare(archive_url, json.dumps(config))
    deadline = time.monotonic() + 45
    while not track.ready:
        if time.monotonic() >= deadline:
            raise ValueError("Provider archive mount timed out")
        await asyncio.sleep(.08)
    roots = [mount, mount / "assets"]
    roots.extend(path for path in mount.iterdir() if path.name != "assets" and path.is_dir())
    for root in roots:
        for assets in (root / "assets", root):
            if (assets / MANIFEST).is_file():
                with (assets / MANIFEST).open(encoding="utf-8") as file:
                    manifest = json.load(file)
                if not manifest:
                    raise ValueError("Provider asset manifest is empty")
                return root, assets, manifest
    raise ValueError("Provider asset manifest is missing")


def role_portraits(assets, manifest):
    menu = manifest["menu"]
    previews = menu["selection_previews"]
    portraits = {}
    for fighter in menu["player_select"]["fighters"][:6]:
        colors = previews.get(fighter, {}).get("colors", {})
        poses = []
        for color in range(1, 5):
            frames = colors.get(str(color), {}).get("frames", [])
            match = PORTRAIT_PATH.fullmatch(frames[0].get("image", "")) if frames else None
            data = b""
            if match:
                try:
                    with (assets / "web" / match[1]).open("rb") as file:
                        data = file.read(MAX_PORTRAIT_BYTES + 1)
                except OSError:
                    pass
            if data.startswith(PNG_HEADER) and len(data) <= MAX_PORTRAIT_BYTES:
                poses.append("data:image/png;base64," + base64.b64encode(data).decode("ascii"))
            else:
                poses.append(None)
        if any(poses):
            portraits[fighter] = poses
    return portraits


async def prepare_source(bridge, release, runtime):
    pending = {}
    files = {}
    for relative, (size, _) in SOURCE.items():
        path = release / relative
        if path.is_file() and path.stat().st_size == size:
            content = path.read_bytes()
            if matches_source(relative, content):
                files[relative] = content
                continue
        pending[relative] = bridge.requestSource(relative)

    if pending:
        bridge.report("source", "")
    deadline = time.monotonic() + 22
    while pending:
        for relative, handle in list(pending.items()):
            raw = str(bridge.pollSource(handle))
            if not raw:
                continue
            result = json.loads(raw)
            content = result.get("text", "").encode("utf-8")
            if not matches_source(relative, content):
                raise ValueError(f"Failed to verify provider source {relative}")
            files[relative] = content
            del pending[relative]
        if pending:
            if time.monotonic() >= deadline:
                raise ValueError("Provider source fetch timed out")
            await asyncio.sleep(.05)

    for relative, content in files.items():
        dest = runtime / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)


async def main():
    window = platform.window
    bridge = window.GlortonProvider
    previous = ""
    attempt = 0
    while True:
        archive_url = str(bridge.archiveUrl())
        if not archive_url.startswith("blob:") or archive_url == previous:
            await asyncio.sleep(.12)
            continue
        previous = archive_url
        attempt += 1
        mount = Path(f"/tmp/glorton-provider-archive-{attempt}")
        try:
            bridge.report("mounting", "")
            release, assets, manifest = await mount_archive(window, archive_url, mount)
        except (OSError, ValueError) as error:
            print(f"Glorton archive: {error}", flush=True)
            bridge.report("invalid", "")
            continue

        try:
            bridge.setRolePortraits(json.dumps(role_portraits(assets, manifest)))
        except Exception as error:
            print(f"Glorton portraits: {error}", flush=True)
        finally:
            del manifest

        runtime = Path(f"/tmp/glorton-provider-runtime-{attempt}")
        try:
            runtime.mkdir()
            await prepare_source(bridge, release, runtime)
            os.symlink(assets, runtime / "assets")
        except (OSError, ValueError) as error:
            print(f"Glorton startup: {error}", flush=True)
            bridge.report("error", "")
            continue
        sys.path.insert(0, str(runtime))
        bridge.report("ready", "")
        try:
            await run_session()
        except Exception as error:
            bridge.report("error", "")
            print(f"Glorton session: {error}", flush=True)
            raise
        return
