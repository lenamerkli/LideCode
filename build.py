#!/usr/bin/env python3
"""Build script for LideCode.

Compiles the TypeScript sources and assembles a deployable tree under
``/opt/LideCode`` — the location the server and ``chat.ts`` expect at runtime.

The resulting layout:

    /opt/LideCode/
    ├── docker/          # Docker build context (DOCKERFILE, app.py, ...)
    ├── dist/            # Compiled JavaScript
    ├── node_modules/    # Production dependencies
    ├── package.json
    ├── package-lock.json
    └── .env
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
# Override with LIDECODE_TARGET_DIR to deploy elsewhere (useful for testing).
TARGET_DIR = Path(os.environ.get("LIDECODE_TARGET_DIR", "/opt/LideCode"))

DIST_DIR = PROJECT_ROOT / "dist"
DOCKER_DIR = PROJECT_ROOT / "src" / "docker"
ENV_FILE = PROJECT_ROOT / ".env"
PACKAGE_JSON = PROJECT_ROOT / "package.json"
PACKAGE_LOCK = PROJECT_ROOT / "package-lock.json"

# Files/directories that should never be copied into the deploy tree.
DOCKER_IGNORES = shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo")


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print(f"+ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, check=True)


def ensure_dependencies() -> None:
    if (PROJECT_ROOT / "node_modules").is_dir():
        return
    print("node_modules missing; installing dependencies...")
    run(["npm", "ci"], cwd=PROJECT_ROOT)


def compile_project() -> None:
    print("Compiling TypeScript sources...")
    run(["npx", "tsc"], cwd=PROJECT_ROOT)


def prepare_target() -> None:
    print(f"Preparing target directory: {TARGET_DIR}")
    TARGET_DIR.mkdir(parents=True, exist_ok=True)

    # Docker build context (chat.ts builds the image from here).
    docker_target = TARGET_DIR / "docker"
    if docker_target.exists():
        shutil.rmtree(docker_target)
    shutil.copytree(DOCKER_DIR, docker_target, ignore=DOCKER_IGNORES)

    # Compiled JavaScript.
    dist_target = TARGET_DIR / "dist"
    if dist_target.exists():
        shutil.rmtree(dist_target)
    shutil.copytree(DIST_DIR, dist_target)

    # Static web interface.
    public_target = TARGET_DIR / "public"
    if public_target.exists():
        shutil.rmtree(public_target)
    shutil.copytree(PROJECT_ROOT / "public", public_target)

    # Node manifest files (needed by `npm ci` below).
    shutil.copy2(PACKAGE_JSON, TARGET_DIR / "package.json")
    shutil.copy2(PACKAGE_LOCK, TARGET_DIR / "package-lock.json")

    # Environment configuration (loaded by dotenv at runtime).
    if ENV_FILE.is_file():
        shutil.copy2(ENV_FILE, TARGET_DIR / ".env")
    else:
        print("warning: .env not found; skipping.")


def install_production_dependencies() -> None:
    print("Installing production dependencies...")
    run(["npm", "ci", "--omit=dev"], cwd=TARGET_DIR)


def main() -> None:
    ensure_dependencies()
    compile_project()
    prepare_target()
    install_production_dependencies()
    print(f"Build complete: {TARGET_DIR}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(
            f"error: command failed with exit code {exc.returncode}: "
            f"{' '.join(exc.cmd)}",
            file=sys.stderr,
        )
        sys.exit(1)
    except PermissionError as exc:
        print(
            f"error: permission denied ({exc}). Writing to /opt usually "
            "requires root/sudo.",
            file=sys.stderr,
        )
        sys.exit(1)
