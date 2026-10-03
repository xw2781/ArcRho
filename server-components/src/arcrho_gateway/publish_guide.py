"""Publish guide source independently of the frozen Gateway executable."""

from pathlib import Path

from arcrho_gateway.user_guide import GUIDE_DIRECTORY, GUIDE_SOURCE
from build_runtime import stage_deploy, swap_deploy


def publish_guide(server_root: Path, source: Path = GUIDE_SOURCE) -> Path:
    """Use the deployment tooling's staged mirror and rollback."""
    if not (source / "index.html").is_file():
        raise FileNotFoundError(f"User Guide index not found: {source / 'index.html'}")
    stage_deploy(source, server_root, GUIDE_DIRECTORY)
    swap_deploy(server_root, GUIDE_DIRECTORY)
    return server_root / GUIDE_DIRECTORY
