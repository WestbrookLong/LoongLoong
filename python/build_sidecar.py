from __future__ import annotations

import shutil
import subprocess
import sys
import os
from importlib.util import find_spec
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "release" / "agent-sidecar"
WORK = ROOT / "release" / ".pyinstaller-agent"


def main() -> None:
    try:
        import PyInstaller  # noqa: F401
    except ImportError as exc:
        raise SystemExit("PyInstaller is required: python -m pip install pyinstaller") from exc
    shutil.rmtree(DIST, ignore_errors=True)
    shutil.rmtree(WORK, ignore_errors=True)
    playwright_spec = find_spec("playwright")
    if not playwright_spec or not playwright_spec.submodule_search_locations:
        raise SystemExit("Playwright is required: python -m pip install -r python/requirements-agent.txt")
    playwright_dir = Path(next(iter(playwright_spec.submodule_search_locations)))
    command = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
        "--name", "pet-agent", "--distpath", str(DIST), "--workpath", str(WORK),
        "--specpath", str(WORK),
        "--add-data", f"{playwright_dir / 'driver'}{os.pathsep}playwright/driver",
        str(ROOT / "python" / "pet_agent" / "sidecar.py"),
    ]
    subprocess.run(command, cwd=ROOT, check=True)
    print(DIST / ("pet-agent.exe" if sys.platform == "win32" else "pet-agent"))


if __name__ == "__main__":
    main()
