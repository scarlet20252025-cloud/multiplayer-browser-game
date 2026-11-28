"""Build the browser renderer with provider loading or a private installed release."""

import argparse
from collections import deque
from hashlib import sha256
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


PROJECT = Path(__file__).resolve().parents[1]
ADAPTER = PROJECT / "adapters/glorton-browser"
PROVIDER = PROJECT / "public/glorton-online/provider-loader.mjs"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider-only", action="store_true", help="Build the shell using browser-supplied resources")
    parser.add_argument("release", type=Path, nargs="?", help="Existing release with installed runtime assets")
    parser.add_argument("output", type=Path, help="New directory for the web build")
    args = parser.parse_args()
    output = args.output.resolve()
    if args.provider_only == (args.release is not None):
        parser.error("Pass a release path for a private build or use --provider-only")
    release = args.release.resolve() if args.release else None
    if release:
        for file in ("src/runtime.py", "online/client.py", "assets/manifests/glorton_manifest.json"):
            if not (release / file).is_file():
                parser.error(f"Missing installed release file: {file}")
    if output.exists():
        parser.error("Choose a new output directory")

    with TemporaryDirectory(prefix="glorton-local-render-") as temp:
        stage = Path(temp) / "app"
        stage.mkdir()
        entry = "sync_client"
        if release:
            for name in ("src", "online", "assets"):
                shutil.copytree(release / name, stage / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            entry = "provider_bootstrap"
            shutil.copyfile(ADAPTER / "provider_bootstrap.py", stage / "provider_bootstrap.py")
        for filename in ("sync_client.py", "render_scene.py", "stage_budget.py"):
            shutil.copyfile(ADAPTER / filename, stage / filename)
        (stage / "main.py").write_text(
            f"import asyncio\nimport pygame\nfrom {entry} import main\n\nasyncio.run(main())\n", encoding="utf-8"
        )
        log_path = Path(temp) / "pygbag.log"
        with log_path.open("wb") as log:
            result = subprocess.run(
                [sys.executable, "-m", "pygbag", "--build", "--no_opt", "--ume_block", "0",
                 "--title", "The Fight for Glorton", "--app_name", "glorton-local", str(stage)],
                stdout=log, stderr=subprocess.STDOUT,
            )
        if result.returncode:
            with log_path.open(encoding="utf-8", errors="replace") as log:
                sys.stderr.writelines(deque(log, maxlen=24))
            raise SystemExit(result.returncode)
        web = stage / "build" / "web"
        if not (web / "index.html").is_file() or not any(web.glob("*.apk")):
            raise RuntimeError("Pygbag did not produce a runnable package")
        if args.provider_only:
            shutil.copyfile(PROVIDER, web / PROVIDER.name)
            index = web / "index.html"
            html = index.read_text(encoding="utf-8")
            apk = web / "app.apk"
            source_anchor = 'apk = "app.apk"'
            if "</body>" not in html or source_anchor not in html or not apk.is_file():
                raise RuntimeError("Unexpected Pygbag page layout")
            archive_version = sha256(apk.read_bytes()).hexdigest()[:12]
            loader_version = sha256(PROVIDER.read_bytes()).hexdigest()[:12]
            html = html.replace(source_anchor, f'apk = "app.apk?v={archive_version}"', 1)
            loader = f'<script type="module" src="./provider-loader.mjs?v={loader_version}"></script>'
            index.write_text(html.replace("</body>", f"{loader}\n</body>", 1), encoding="utf-8")
        shutil.copytree(web, output)
    kind = "Provider shell" if args.provider_only else "Private local rendering"
    print(f"{kind} build: {output}")


if __name__ == "__main__":
    main()
