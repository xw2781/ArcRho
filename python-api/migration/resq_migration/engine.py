"""In-process bridge from the ResQ migration to the ArcRho data-engine.

For dataset types flagged ``Generated=true`` (and whose instance name equals the
dataset type), the migration asks the data-engine to compute the dataset CSV
directly instead of copying values out of ResQ. This keeps the migrated cache
identical to what the live ArcRho app would generate.

The data-engine only ever writes the CSV; the migration is responsible for the
canonical sidecar. The processing provenance recorded in that sidecar is obtained
from the authoritative ``app_server`` helper so the ``config_hash`` matches exactly
what the app computes when it validates cache freshness. Re-implementing that hash
here would be fragile, so we import the real function instead.

Both dependencies are imported lazily (only when a generated dataset is actually
encountered) so the migration still runs for projects with no generated datasets
even if the data-engine / app_server dependencies are not installed.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# .../python-api/migration/resq_migration/engine.py -> ArcRho repo root
_MIGRATION_PKG_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _MIGRATION_PKG_DIR.parents[2]
_DATA_ENGINE_SRC = _REPO_ROOT / "data-engine" / "src"
_FRONTEND_ROOT = _REPO_ROOT / "frontend"

_DEFAULT_SERVER_ROOT = r"E:\ArcRho Server"


class EngineGenerationError(RuntimeError):
    """Raised when the data-engine cannot generate a requested dataset."""


def _prepend_sys_path(path: Path) -> None:
    text = str(path)
    if text not in sys.path:
        sys.path.insert(0, text)


def _ensure_engine_importable(server_root: object) -> None:
    """Point the data-engine at the migration's server root and expose its package."""
    root = str(server_root).strip() if server_root else ""
    if not root:
        root = os.environ.get("ARCRHO_ROOT", _DEFAULT_SERVER_ROOT)
    # The data-engine resolves project config/source tables from ARCRHO_ROOT.
    os.environ["ARCRHO_ROOT"] = root
    os.environ.setdefault("ARCRHO_DEPLOY_ROOT", root)
    _prepend_sys_path(_DATA_ENGINE_SRC)


def _ensure_provenance_importable() -> None:
    _prepend_sys_path(_FRONTEND_ROOT)


def generate_engine_csv(
    *,
    project_name: str,
    rc_path: str,
    dataset_type: str,
    data_path: str | os.PathLike,
    origin_length: int,
    development_length: int,
    is_vector: bool,
    server_root: object = None,
    cumulative: bool = True,
    calendar: bool = False,
) -> None:
    """Generate one dataset CSV via the in-process data-engine.

    Writes only the CSV to ``data_path``. Raises :class:`EngineGenerationError`
    if the engine cannot be imported, the request fails, or no output is produced.
    """
    _ensure_engine_importable(server_root)
    try:
        from arcrho_engine.data_processing import UDF_ADASTri
    except Exception as exc:  # pragma: no cover - import/environment failure
        raise EngineGenerationError(
            f"Could not import the ArcRho data-engine (checked {_DATA_ENGINE_SRC}): {exc}"
        ) from exc

    arg = {
        "Function": "ArcRhoVec" if is_vector else "ArcRhoTri",
        "ProjectName": project_name,
        "Path": rc_path,
        "DatasetName": dataset_type,
        "OriginLength": int(origin_length),
        "DevelopmentLength": int(development_length),
        "Cumulative": bool(cumulative),
        "Calendar": bool(calendar),
        "DataPath": str(data_path),
    }

    target = Path(data_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        UDF_ADASTri(arg)
    except Exception as exc:
        raise EngineGenerationError(
            f"Data-engine failed to generate [{dataset_type}] for [{rc_path}]: {exc}"
        ) from exc
    if not target.is_file():
        raise EngineGenerationError(
            f"Data-engine did not produce an output CSV for [{dataset_type}] at {target}."
        )


def get_engine_processing_provenance(project_name: str) -> dict:
    """Return the authoritative processing provenance dict for ``project_name``.

    The returned dict (``config_hash``/``algorithm_version``/``rules_format``/
    ``rules_revision``) is recorded in the engine-generated sidecar so the app
    treats the migrated cache as fresh.
    """
    _ensure_provenance_importable()
    try:
        from app_server.services.data_processing_rules_service import (
            get_processing_provenance,
        )
    except Exception as exc:  # pragma: no cover - import/environment failure
        raise EngineGenerationError(
            f"Could not import the processing-provenance helper from app_server "
            f"(checked {_FRONTEND_ROOT}): {exc}"
        ) from exc

    try:
        provenance = get_processing_provenance(project_name)
    except Exception as exc:
        raise EngineGenerationError(
            f"Failed to compute processing provenance for [{project_name}]: {exc}"
        ) from exc

    if not isinstance(provenance, dict) or not str(provenance.get("config_hash") or "").strip():
        raise EngineGenerationError(
            f"Processing provenance for [{project_name}] is missing a config hash."
        )
    return provenance
