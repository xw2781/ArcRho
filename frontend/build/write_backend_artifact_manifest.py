"""Write an immutable identity for one collected PyInstaller backend bundle."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import uuid
from pathlib import Path
from typing import Any, Dict


MANIFEST_FILE_NAME = "backend-artifact.json"
MANIFEST_FORMAT = "arcrho-backend-artifact-v1"


def _file_digest(path: Path) -> tuple[int, bytes]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.digest()


def build_manifest(bundle_dir: Path) -> Dict[str, Any]:
    root = bundle_dir.resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Backend bundle directory not found: {root}")
    files = sorted(
        (
            path
            for path in root.rglob("*")
            if path.is_file()
            and path.name != MANIFEST_FILE_NAME
            and not (
                path.name.startswith(f"{MANIFEST_FILE_NAME}.")
                and path.name.endswith(".tmp")
            )
        ),
        key=lambda path: path.relative_to(root).as_posix().casefold(),
    )
    if not files:
        raise ValueError(f"Backend bundle contains no files: {root}")

    aggregate = hashlib.sha256()
    total_size = 0
    for path in files:
        relative_path = path.relative_to(root).as_posix()
        size, file_digest = _file_digest(path)
        total_size += size
        aggregate.update(relative_path.encode("utf-8"))
        aggregate.update(b"\0")
        aggregate.update(str(size).encode("ascii"))
        aggregate.update(b"\0")
        aggregate.update(file_digest)

    return {
        "format": MANIFEST_FORMAT,
        "artifact_id": f"sha256:{aggregate.hexdigest()}",
        "file_count": len(files),
        "total_size": total_size,
    }


def write_manifest(bundle_dir: Path) -> Path:
    root = bundle_dir.resolve()
    manifest = build_manifest(root)
    output_path = root / MANIFEST_FILE_NAME
    temporary_path = root / f"{MANIFEST_FILE_NAME}.{uuid.uuid4()}.tmp"
    with temporary_path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    os.replace(temporary_path, output_path)
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle_dir", type=Path)
    args = parser.parse_args()
    output_path = write_manifest(args.bundle_dir)
    print(f"Backend artifact manifest written: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
