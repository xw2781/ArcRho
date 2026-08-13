"""Build the offline ArcRho Server Components companion installer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


INSTALLER_DIR = Path(__file__).resolve().parent
DATA_ENGINE_ROOT = INSTALLER_DIR.parent
REPOSITORY_ROOT = DATA_ENGINE_ROOT.parent
SOURCE_ROOT = DATA_ENGINE_ROOT / "src"
API_SOURCE = REPOSITORY_ROOT / "python-api" / "src"
FRONTEND_ROOT = REPOSITORY_ROOT / "frontend"
NODE_EXE = FRONTEND_ROOT / "node-portable" / "node.exe"
OUTPUT_ROOT = INSTALLER_DIR / "out"
CACHE_ROOT = OUTPUT_ROOT / ".build-cache"
PAYLOAD_DIR_NAME = "payload"
DEPLOYER_BUILD_SCRIPT = SOURCE_ROOT / "arcrho_server_deployer" / "build_exe.py"
DEPLOYER_EXE = (
    DATA_ENGINE_ROOT
    / "builds"
    / "arcrho_server_deployer"
    / "dist"
    / "ArcRho Server Deployer.exe"
)

for path in (SOURCE_ROOT, API_SOURCE):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.io import persisted_json_text  # noqa: E402
from build_runtime import require_python_310  # noqa: E402
from server_deployment_contract import (  # noqa: E402
    MANIFEST_FILE_NAME,
    SERVER_COMPONENTS,
    build_manifest,
)


def run(command: list[object], *, env: dict[str, str] | None = None) -> None:
    print("\n>>>", " ".join(map(str, command)))
    subprocess.run(list(map(str, command)), check=True, env=env)


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def release_environment() -> dict[str, str]:
    environment = os.environ.copy()
    temporary = CACHE_ROOT / "tmp"
    pyinstaller_cache = CACHE_ROOT / "pyinstaller"
    electron_builder_cache = CACHE_ROOT / "electron-builder"
    pip_cache = CACHE_ROOT / "pip"
    for path in (temporary, pyinstaller_cache, electron_builder_cache, pip_cache):
        path.mkdir(parents=True, exist_ok=True)
    environment.update(
        {
            "TEMP": str(temporary),
            "TMP": str(temporary),
            "PYINSTALLER_CONFIG_DIR": str(pyinstaller_cache),
            "ELECTRON_BUILDER_CACHE": str(electron_builder_cache),
            "PIP_CACHE_DIR": str(pip_cache),
        }
    )
    return environment


def frontend_version() -> str:
    package = json.loads((FRONTEND_ROOT / "package.json").read_text(encoding="utf-8"))
    return str(package["version"]).strip()


def component_dist_dir(role: str, app_name: str) -> Path:
    return DATA_ENGINE_ROOT / "builds" / f"arcrho_{role}" / "dist" / app_name


def payload_copy_ignore(directory: str, names: list[str]) -> set[str]:
    """Exclude build/source caches and migration validation output from releases."""

    ignored = {
        name
        for name in names
        if name.casefold() in {"__pycache__", ".pytest_cache"}
    }
    current = Path(directory)
    if (
        current.name.casefold() == "validation"
        and current.parent.name.casefold() == "migration"
    ):
        ignored.update(name for name in names if name.casefold() == "results")
    return ignored


def build_components() -> None:
    environment = release_environment()
    environment["ARCRHO_STAGE_ONLY"] = "1"
    for component in SERVER_COMPONENTS:
        script = SOURCE_ROOT / f"arcrho_{component.role}" / "build_exe.py"
        run([sys.executable, script], env=environment)


def stage_payload(release_dir: Path, version: str) -> tuple[Path, dict]:
    payload = release_dir / PAYLOAD_DIR_NAME
    apps = payload / "apps"
    apps.mkdir(parents=True, exist_ok=True)
    component_roots = []
    for component in SERVER_COMPONENTS:
        source = component_dist_dir(component.role, component.app_name)
        executable = source / f"{component.app_name}.exe"
        if not executable.is_file():
            raise FileNotFoundError(f"Built component executable is missing: {executable}")
        destination = apps / component.app_name
        shutil.copytree(source, destination, ignore=payload_copy_ignore)
        component_roots.append((component, destination))
    manifest = build_manifest(version, component_roots)
    (payload / MANIFEST_FILE_NAME).write_text(
        persisted_json_text(manifest), encoding="utf-8"
    )
    return payload, manifest


def validate_payload(payload: Path, manifest: dict) -> None:
    expected_roles = {component.role for component in SERVER_COMPONENTS}
    actual_roles = {component["role"] for component in manifest["components"]}
    if actual_roles != expected_roles:
        raise RuntimeError("Staged payload does not contain the canonical component set.")
    for component in manifest["components"]:
        root = payload / Path(component["relative_destination"])
        expected = {entry["path"]: entry for entry in component["files"]}
        actual = {
            path.relative_to(root).as_posix(): path
            for path in root.rglob("*")
            if path.is_file()
        }
        if set(actual) != set(expected):
            raise RuntimeError(
                f"Staged payload inventory differs for {component['app_name']}."
            )
        for relative_path, path in actual.items():
            entry = expected[relative_path]
            if (
                path.stat().st_size != entry["size"]
                or hash_file(path) != entry["sha256"]
            ):
                raise RuntimeError(f"Staged payload checksum is invalid: {path}")


def build_installer(release_dir: Path, payload: Path, version: str) -> Path:
    if not NODE_EXE.is_file():
        raise FileNotFoundError(f"Bundled Node runtime was not found: {NODE_EXE}")
    output = release_dir / f"ArcRho-Server-Setup-{version}.exe"
    run(
        [
            NODE_EXE,
            INSTALLER_DIR / "build_nsis_installer.js",
            "--script",
            INSTALLER_DIR / "server_installer.nsi",
            "--output",
            output,
            "--payload",
            payload,
            "--deployer",
            DEPLOYER_EXE,
            "--version",
            version,
        ],
        env=release_environment(),
    )
    if not output.is_file() or output.read_bytes()[:2] != b"MZ":
        raise RuntimeError(f"NSIS did not produce a valid Windows installer: {output}")
    digest = hash_file(output)
    output.with_suffix(output.suffix + ".sha256").write_text(
        f"{digest}  {output.name}\n", encoding="ascii"
    )
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build ArcRho Server Components and its offline NSIS installer."
    )
    parser.add_argument(
        "--version",
        help="Semantic version; must match frontend/package.json when supplied.",
    )
    parser.add_argument("--reuse-component-builds", action="store_true")
    parser.add_argument("--reuse-deployer-build", action="store_true")
    parser.add_argument("--stage-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    require_python_310()
    args = parse_args()
    current_version = frontend_version()
    version = args.version or current_version
    if version != current_version:
        raise ValueError(
            f"Server installer version {version} must match ArcRho frontend version {current_version}."
        )
    release_dir = OUTPUT_ROOT / version
    shutil.rmtree(release_dir, ignore_errors=True)
    release_dir.mkdir(parents=True)
    if not args.reuse_component_builds:
        build_components()
    if not args.reuse_deployer_build:
        run([sys.executable, DEPLOYER_BUILD_SCRIPT], env=release_environment())
    if not DEPLOYER_EXE.is_file():
        raise FileNotFoundError(f"Deployment helper is missing: {DEPLOYER_EXE}")
    payload, manifest = stage_payload(release_dir, version)
    validate_payload(payload, manifest)
    if args.stage_only:
        print(f"\nRelease payload staged: {payload}")
        return 0
    installer = build_installer(release_dir, payload, version)
    print(f"\nArcRho Server installer built: {installer}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.returncode)
