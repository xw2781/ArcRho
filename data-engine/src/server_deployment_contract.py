"""Versioned contracts for ArcRho Server release payloads and receipts."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from utils import SERVER_COMPONENT_ROLES, component_app_name


PAYLOAD_SCHEMA_VERSION = 1
RECEIPT_SCHEMA_VERSION = 1
PRODUCT_NAME = "ArcRho Server Components"
MANIFEST_FILE_NAME = "payload-manifest.json"
INSTALL_METADATA_RELATIVE_DIR = Path("apps") / ".arcrho-server-installer"
RECEIPT_FILE_NAME = "install-receipt.json"
DEPLOYMENT_LOCK_FILE_NAME = "deployment.lock"
SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$"
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class DeploymentContractError(ValueError):
    pass


@dataclass(frozen=True)
class ComponentDefinition:
    role: str
    app_name: str

    @property
    def relative_destination(self) -> str:
        return f"apps/{self.app_name}"


SERVER_COMPONENTS = tuple(
    ComponentDefinition(role, component_app_name(role))
    for role in SERVER_COMPONENT_ROLES
)
COMPONENT_BY_ROLE = {component.role: component for component in SERVER_COMPONENTS}


def parse_semver(value: Any) -> tuple[int, int, int, tuple[Any, ...]]:
    text = str(value or "").strip()
    match = SEMVER_PATTERN.fullmatch(text)
    if not match:
        raise DeploymentContractError(f"Invalid semantic version: {text!r}")
    prerelease = match.group(4)
    if prerelease is None:
        prerelease_key: tuple[Any, ...] = (1,)
    else:
        identifiers: list[tuple[int, Any]] = []
        for identifier in prerelease.split("."):
            identifiers.append(
                (0, int(identifier)) if identifier.isdigit() else (1, identifier)
            )
        prerelease_key = (0, *identifiers)
    return int(match.group(1)), int(match.group(2)), int(match.group(3)), prerelease_key


def compare_versions(left: Any, right: Any) -> int:
    left_key = parse_semver(left)
    right_key = parse_semver(right)
    return (left_key > right_key) - (left_key < right_key)


def _safe_relative_path(value: Any, label: str) -> str:
    text = str(value or "").replace("\\", "/").strip()
    path = PurePosixPath(text)
    if (
        not text
        or path.is_absolute()
        or any(part in ("", ".", "..") for part in path.parts)
        or any(":" in part for part in path.parts)
    ):
        raise DeploymentContractError(f"{label} is not a safe relative path: {value!r}")
    return path.as_posix()


def _normalize_files(files: Any, destination: str) -> list[dict[str, Any]]:
    if not isinstance(files, list) or not files:
        raise DeploymentContractError(f"Component {destination!r} has no files.")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in files:
        if not isinstance(item, dict):
            raise DeploymentContractError("Manifest file entries must be objects.")
        relative_path = _safe_relative_path(item.get("path"), "Manifest file path")
        canonical = relative_path.casefold()
        if canonical in seen:
            raise DeploymentContractError(
                f"Manifest file path is duplicated: {relative_path}"
            )
        seen.add(canonical)
        sha256 = str(item.get("sha256") or "").strip().lower()
        if not SHA256_PATTERN.fullmatch(sha256):
            raise DeploymentContractError(
                f"Manifest file hash is invalid for {relative_path}."
            )
        size = item.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise DeploymentContractError(
                f"Manifest file size is invalid for {relative_path}."
            )
        normalized.append({"path": relative_path, "size": size, "sha256": sha256})
    normalized.sort(key=lambda item: item["path"].casefold())
    return normalized


def normalize_manifest(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise DeploymentContractError("Payload manifest must be a JSON object.")
    if payload.get("schema_version") != PAYLOAD_SCHEMA_VERSION:
        raise DeploymentContractError(
            f"Unsupported payload schema version {payload.get('schema_version')!r}."
        )
    if payload.get("product") != PRODUCT_NAME:
        raise DeploymentContractError(
            f"Unexpected payload product {payload.get('product')!r}."
        )
    product_version = str(payload.get("product_version") or "").strip()
    parse_semver(product_version)
    raw_components = payload.get("components")
    if not isinstance(raw_components, list):
        raise DeploymentContractError("Payload manifest components must be a list.")
    normalized_components: list[dict[str, Any]] = []
    seen_roles: set[str] = set()
    for item in raw_components:
        if not isinstance(item, dict):
            raise DeploymentContractError("Manifest component entries must be objects.")
        role = str(item.get("role") or "").strip().lower()
        definition = COMPONENT_BY_ROLE.get(role)
        if definition is None or role in seen_roles:
            raise DeploymentContractError(f"Unknown or duplicate component role: {role!r}")
        seen_roles.add(role)
        app_name = str(item.get("app_name") or "").strip()
        destination = _safe_relative_path(
            item.get("relative_destination"), "Component destination"
        )
        if app_name != definition.app_name or destination != definition.relative_destination:
            raise DeploymentContractError(
                f"Component {role!r} does not match the canonical component inventory."
            )
        normalized_components.append(
            {
                "role": role,
                "app_name": app_name,
                "relative_destination": destination,
                "files": _normalize_files(item.get("files"), destination),
            }
        )
    expected_roles = set(COMPONENT_BY_ROLE)
    if seen_roles != expected_roles:
        missing = ", ".join(sorted(expected_roles - seen_roles))
        raise DeploymentContractError(f"Payload manifest is missing component(s): {missing}")
    normalized_components.sort(
        key=lambda item: tuple(COMPONENT_BY_ROLE).index(item["role"])
    )
    return {
        "schema_version": PAYLOAD_SCHEMA_VERSION,
        "product": PRODUCT_NAME,
        "product_version": product_version,
        "components": normalized_components,
    }


def build_manifest(
    product_version: str,
    component_roots: Iterable[tuple[ComponentDefinition, Path]],
) -> dict[str, Any]:
    parse_semver(product_version)
    components: list[dict[str, Any]] = []
    for definition, root in component_roots:
        if not root.is_dir():
            raise FileNotFoundError(f"Staged component folder not found: {root}")
        files = []
        for path in sorted(
            (candidate for candidate in root.rglob("*") if candidate.is_file()),
            key=lambda candidate: candidate.relative_to(root).as_posix().casefold(),
        ):
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            files.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "size": path.stat().st_size,
                    "sha256": digest.hexdigest(),
                }
            )
        components.append(
            {
                "role": definition.role,
                "app_name": definition.app_name,
                "relative_destination": definition.relative_destination,
                "files": files,
            }
        )
    return normalize_manifest(
        {
            "schema_version": PAYLOAD_SCHEMA_VERSION,
            "product": PRODUCT_NAME,
            "product_version": product_version,
            "components": components,
        }
    )


def component_hashes(manifest: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    normalized = normalize_manifest(manifest)
    return {
        component["role"]: [dict(item) for item in component["files"]]
        for component in normalized["components"]
    }


def build_receipt(
    manifest: dict[str, Any],
    *,
    installation_id: str,
    workspace_root: str,
    installed_at: str,
) -> dict[str, Any]:
    normalized = normalize_manifest(manifest)
    if not str(installation_id).strip():
        raise DeploymentContractError("Installation ID is required.")
    return {
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "installation_id": str(installation_id).strip(),
        "workspace_root": str(workspace_root),
        "installed_version": normalized["product_version"],
        "installed_at": str(installed_at),
        "components": component_hashes(normalized),
    }


def normalize_receipt(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise DeploymentContractError("Install receipt must be a JSON object.")
    if payload.get("schema_version") != RECEIPT_SCHEMA_VERSION:
        raise DeploymentContractError(
            f"Unsupported receipt schema version {payload.get('schema_version')!r}."
        )
    version = str(payload.get("installed_version") or "").strip()
    parse_semver(version)
    installation_id = str(payload.get("installation_id") or "").strip()
    workspace_root = str(payload.get("workspace_root") or "").strip()
    installed_at = str(payload.get("installed_at") or "").strip()
    components = payload.get("components")
    if not installation_id or not workspace_root or not installed_at:
        raise DeploymentContractError("Install receipt identity fields are incomplete.")
    if not isinstance(components, dict) or set(components) != set(COMPONENT_BY_ROLE):
        raise DeploymentContractError("Install receipt component inventory is incomplete.")
    normalized_components = {
        role: _normalize_files(components[role], role) for role in COMPONENT_BY_ROLE
    }
    return {
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "installation_id": installation_id,
        "workspace_root": workspace_root,
        "installed_version": version,
        "installed_at": installed_at,
        "components": normalized_components,
    }
