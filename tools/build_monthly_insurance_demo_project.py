"""Build a complete ArcRho monthly insurance demo project.

The builder deliberately goes through the running ArcRho app's canonical HTTP
routes.  It does not author project JSON, dataset sidecars, or reserving-class
indexes itself.  ArcRho therefore owns project registration, source import,
field mapping, XLSX mirrors, aggregate path expansion, Engine requests,
sidecars, dependency graphs, audit entries, and per-reserving-class indexes.

The default build creates seven coherent portfolio aggregate bottom nodes and
materializes a representative set of raw and calculated dataset instances in
every node.  A target project must not already exist; partial new projects are
removed automatically if a build fails unless ``--keep-partial`` is supplied.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import urlencode


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
if str(PYTHON_API_SRC) not in sys.path:
    sys.path.insert(0, str(PYTHON_API_SRC))

from arcrho_api.ui import _base_url, _request_json  # noqa: E402


DEFAULT_PROJECT_NAME = "ArcRho_Monthly_Insurance_Demo"
DEFAULT_REGISTRY_FOLDER = "Demos"
DEFAULT_SOURCE_CSV = (
    REPOSITORY_ROOT / "demo-data" / "monthly_detailed_insurance_demo.csv"
)
EXPECTED_ACCIDENT_START = 201601
EXPECTED_ACCIDENT_END = 202512
EXPECTED_ACCIDENT_MONTHS = 120
DEVELOPMENT_END = 202605

SOURCE_HEADERS = (
    "LineOfBusiness",
    "StateCode",
    "ChannelCode",
    "Coverage",
    "AccidentMonth",
    "EvaluationMonth",
    "GrossPaidLoss",
    "PaidClaimExpense",
    "SalvageRecovery",
    "SubrogationRecovery",
    "CaseReserveChange",
    "NetPaidLoss",
    "GrossReportedLoss",
    "NetReportedLoss",
    "ClosedClaimsWithPayment",
    "ClosedClaimsWithoutPayment",
    "ReportedClaims",
    "EarnedPremium",
    "EarnedCoverageExposure",
)


@dataclass(frozen=True)
class DatasetType:
    name: str
    data_format: str
    category: str
    calculated: bool = False
    formula: str = ""
    materialize: bool = False

    def ui_row(self) -> list[Any]:
        return [
            self.name,
            self.data_format,
            self.category,
            self.calculated,
            self.formula if self.calculated else "",
        ]


@dataclass(frozen=True)
class DemoCsvProfile:
    path: Path
    row_count: int
    accident_month_count: int
    accident_start: int
    accident_end: int


RAW_DATASET_TYPES = (
    DatasetType("Gross Paid Loss", "Triangle", "D Gross Loss", materialize=True),
    DatasetType("Paid Claim Expense", "Triangle", "G Claim Expense", materialize=True),
    DatasetType("Salvage Recovery", "Triangle", "E1 Salvage"),
    DatasetType("Subrogation Recovery", "Triangle", "E2 Subrogation"),
    # The source column is an incremental movement. ArcRho's cumulative
    # triangle is therefore the outstanding case reserve at each age.
    DatasetType("Case Reserve", "Triangle", "D Gross Loss", materialize=True),
    DatasetType("Net Paid Loss", "Triangle", "F Net Loss"),
    DatasetType("Gross Reported Loss", "Triangle", "D Gross Loss", materialize=True),
    DatasetType("Net Reported Loss", "Triangle", "F Net Loss", materialize=True),
    DatasetType(
        "Closed Claims With Payment",
        "Triangle",
        "C Claim Count",
        materialize=True,
    ),
    DatasetType(
        "Closed Claims Without Payment",
        "Triangle",
        "C Claim Count",
        materialize=True,
    ),
    DatasetType("Reported Claims", "Triangle", "C Claim Count", materialize=True),
    DatasetType("Earned Premium", "Vector", "A Premium", materialize=True),
    DatasetType(
        "Earned Coverage Exposure",
        "Vector",
        "B Exposure",
        materialize=True,
    ),
)

CALCULATED_DATASET_TYPES = (
    DatasetType(
        "Total Recovery",
        "Triangle",
        "E Recovery",
        True,
        '"Salvage Recovery" + "Subrogation Recovery"',
    ),
    DatasetType(
        "Total Closed Claims",
        "Triangle",
        "C Claim Count",
        True,
        '"Closed Claims With Payment" + "Closed Claims Without Payment"',
    ),
    DatasetType(
        "Open Claims",
        "Triangle",
        "C Claim Count",
        True,
        '"Reported Claims" - "Total Closed Claims"',
        True,
    ),
    DatasetType(
        "Gross Claim Cost",
        "Triangle",
        "D Gross Loss",
        True,
        '"Gross Reported Loss" + "Paid Claim Expense"',
        True,
    ),
    DatasetType(
        "Net Claim Cost",
        "Triangle",
        "F Net Loss",
        True,
        '"Net Reported Loss" + "Paid Claim Expense"',
    ),
    DatasetType(
        "Reported Closure Ratio",
        "Triangle",
        "X Diagnostics",
        True,
        '"Total Closed Claims" / "Reported Claims"',
    ),
    DatasetType(
        "Net Reported Loss Ratio",
        "Triangle",
        "X Diagnostics",
        True,
        '"Net Reported Loss" / "Earned Premium"',
        True,
    ),
    DatasetType(
        "Reported Claim Frequency",
        "Triangle",
        "X Diagnostics",
        True,
        '"Reported Claims" / "Earned Coverage Exposure" * 1000',
        True,
    ),
)

ALL_DATASET_TYPES = RAW_DATASET_TYPES + CALCULATED_DATASET_TYPES

SOURCE_DATASET_MAPPING = (
    ("GrossPaidLoss", "Gross Paid Loss"),
    ("PaidClaimExpense", "Paid Claim Expense"),
    ("SalvageRecovery", "Salvage Recovery"),
    ("SubrogationRecovery", "Subrogation Recovery"),
    ("CaseReserveChange", "Case Reserve"),
    ("NetPaidLoss", "Net Paid Loss"),
    ("GrossReportedLoss", "Gross Reported Loss"),
    ("NetReportedLoss", "Net Reported Loss"),
    ("ClosedClaimsWithPayment", "Closed Claims With Payment"),
    ("ClosedClaimsWithoutPayment", "Closed Claims Without Payment"),
    ("ReportedClaims", "Reported Claims"),
    ("EarnedPremium", "Earned Premium"),
    ("EarnedCoverageExposure", "Earned Coverage Exposure"),
)

FIELD_MAPPING_ROWS = (
    {"field_name": "LineOfBusiness", "significance": "Reserving Class", "level": 1},
    {"field_name": "StateCode", "significance": "Reserving Class", "level": 2},
    {"field_name": "ChannelCode", "significance": "Reserving Class", "level": 3},
    {"field_name": "Coverage", "significance": "Reserving Class", "level": 4},
    {"field_name": "AccidentMonth", "significance": "Origin Date"},
    {"field_name": "EvaluationMonth", "significance": "Development Date"},
    *(
        {
            "field_name": field_name,
            "significance": "Dataset",
            "dataset_type": dataset_type,
        }
        for field_name, dataset_type in SOURCE_DATASET_MAPPING
    ),
)

# Only aggregate formulas live here. ArcRho derives and merges the atomic rows
# from the imported source table, then resolves these formulas to quoted Source
# expressions and writes the JSON/XLSX pair through its canonical service.
AGGREGATE_RC_TYPE_ROWS = (
    ["All Auto", "1", '"Personal Auto" + "Commercial Auto"'],
    ["All Lines", "1", '"Personal Auto" + "Commercial Auto" + Homeowners'],
    ["All States", "2", "CA + TX + OH"],
    ["All Channels", "3", "CH01 + CH02 + CH03"],
    [
        "Personal Auto Total",
        "4",
        '"Bodily Injury Liability" + "Property Damage Liability" + Collision + Comprehensive',
    ],
    [
        "Commercial Auto Total",
        "4",
        '"Auto Liability" + "Physical Damage"',
    ],
    [
        "Homeowners Total",
        "4",
        '"Dwelling Property" + "Personal Property" + "Premises Liability"',
    ],
    [
        "All Auto Coverages",
        "4",
        '"Personal Auto Total" + "Commercial Auto Total"',
    ],
    [
        "All Coverages",
        "4",
        '"All Auto Coverages" + "Homeowners Total"',
    ],
    [
        "Liability Coverages",
        "4",
        '"Bodily Injury Liability" + "Property Damage Liability" + "Auto Liability" + "Premises Liability"',
    ],
    [
        "Property and Physical Damage",
        "4",
        'Collision + Comprehensive + "Physical Damage" + "Dwelling Property" + "Personal Property"',
    ],
)

# These are the coherent portfolio aggregate leaves the demo intentionally
# exposes. Every configured leaf receives the same representative dataset suite.
AGGREGATE_BOTTOM_PATHS = (
    r"Personal Auto\All States\All Channels\Personal Auto Total",
    r"Commercial Auto\All States\All Channels\Commercial Auto Total",
    r"Homeowners\All States\All Channels\Homeowners Total",
    r"All Auto\All States\All Channels\All Auto Coverages",
    r"All Lines\All States\All Channels\All Coverages",
    r"All Lines\All States\All Channels\Liability Coverages",
    r"All Lines\All States\All Channels\Property and Physical Damage",
)


class ArcRhoAppClient:
    def __init__(self, app_url: str | None = None) -> None:
        self.app_url = str(app_url or "").strip() or None

    @property
    def base_url(self) -> str:
        return _base_url(self.app_url)

    def get(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        timeout_sec: float = 10.0,
    ) -> dict[str, Any]:
        endpoint = path
        if params:
            endpoint = f"{path}?{urlencode(params)}"
        return _request_json(
            endpoint,
            method="GET",
            timeout_sec=timeout_sec,
            app_url=self.app_url,
        )

    def post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        timeout_sec: float = 30.0,
    ) -> dict[str, Any]:
        return _request_json(
            path,
            method="POST",
            payload=payload,
            timeout_sec=timeout_sec,
            app_url=self.app_url,
        )


def inspect_demo_csv(path: Path) -> DemoCsvProfile:
    source_path = path.expanduser().resolve()
    if not source_path.is_file():
        raise FileNotFoundError(f"Demo source CSV was not found: {source_path}")

    row_count = 0
    accident_months: set[int] = set()
    with source_path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        actual_headers = tuple(reader.fieldnames or ())
        if actual_headers != SOURCE_HEADERS:
            raise ValueError(
                "Demo source headers do not match the Engine-ready contract. "
                f"Expected {list(SOURCE_HEADERS)}, received {list(actual_headers)}."
            )
        for row in reader:
            row_count += 1
            accident_months.add(int(row["AccidentMonth"]))

    if not accident_months:
        raise ValueError(f"Demo source CSV has no data rows: {source_path}")
    profile = DemoCsvProfile(
        path=source_path,
        row_count=row_count,
        accident_month_count=len(accident_months),
        accident_start=min(accident_months),
        accident_end=max(accident_months),
    )
    if (
        profile.accident_month_count != EXPECTED_ACCIDENT_MONTHS
        or profile.accident_start != EXPECTED_ACCIDENT_START
        or profile.accident_end != EXPECTED_ACCIDENT_END
    ):
        raise ValueError(
            "Demo source must contain exactly 120 accident months from "
            f"{EXPECTED_ACCIDENT_START} through {EXPECTED_ACCIDENT_END}; got "
            f"{profile.accident_month_count} months from {profile.accident_start} "
            f"through {profile.accident_end}."
        )
    return profile


def validate_builder_configuration() -> None:
    if any(not header.isidentifier() for header in SOURCE_HEADERS):
        raise AssertionError("Every demo source header must be a valid Engine identifier.")

    dataset_names = [item.name for item in ALL_DATASET_TYPES]
    if len(dataset_names) != len(set(dataset_names)):
        raise AssertionError("Dataset Type names must be unique.")
    known_names = set(dataset_names)
    for item in CALCULATED_DATASET_TYPES:
        components = re.findall(r'"([^"]+)"', item.formula)
        unresolved = [name for name in components if name not in known_names]
        if unresolved:
            raise AssertionError(
                f"Calculated Dataset Type '{item.name}' has unresolved components: {unresolved}"
            )

    mapped_types = {dataset_type for _field, dataset_type in SOURCE_DATASET_MAPPING}
    if not mapped_types.issubset(known_names):
        raise AssertionError("Field Mapping references an undefined Dataset Type.")

    aggregate_names_by_level: dict[str, set[str]] = {}
    for name, level, _formula in AGGREGATE_RC_TYPE_ROWS:
        aggregate_names_by_level.setdefault(level, set()).add(name)
    for path in AGGREGATE_BOTTOM_PATHS:
        parts = path.split("\\")
        if len(parts) != 4:
            raise AssertionError(f"Aggregate bottom path is not four levels deep: {path}")
        if parts[-1] not in aggregate_names_by_level.get("4", set()):
            raise AssertionError(f"Aggregate bottom path does not end in an aggregate type: {path}")


def _project_name_from_registry_path(value: str) -> str:
    parts = [part for part in re.split(r"[\\/]", str(value or "")) if part]
    return parts[-1] if parts else ""


def _require_new_project(
    client: ArcRhoAppClient,
    projects_dir: Path,
    project_name: str,
) -> dict[str, Any]:
    try:
        disk_names = {entry.name.casefold() for entry in projects_dir.iterdir() if entry.is_dir()}
    except OSError as exc:
        raise RuntimeError(f"Cannot enumerate configured projects folder {projects_dir}: {exc}") from exc
    if project_name.casefold() in disk_names:
        raise FileExistsError(f"Target ArcRho project already exists: {projects_dir / project_name}")

    registry = client.get("/project_settings/project_map", timeout_sec=15)
    registered_names = {
        _project_name_from_registry_path(value).casefold()
        for value in registry.get("project_paths", [])
    }
    if project_name.casefold() in registered_names:
        raise FileExistsError(f"Target project is already registered: {project_name}")
    return registry


def _configure_project(
    client: ArcRhoAppClient,
    project_name: str,
    source_csv: Path,
) -> None:
    client.post(
        "/source_table/profile",
        {
            "project_name": project_name,
            "source_type": "csv",
            "csv_path": str(source_csv),
        },
        timeout_sec=30,
    )
    client.post(
        "/source_table/refresh",
        {"project_name": project_name, "force": True},
        timeout_sec=180,
    )
    client.post(
        "/general_settings",
        {
            "project_name": project_name,
            "origin_start_date": str(EXPECTED_ACCIDENT_START),
            "origin_end_date": str(EXPECTED_ACCIDENT_END),
            "development_end_date": str(DEVELOPMENT_END),
            "auto_generated": False,
        },
        timeout_sec=30,
    )
    client.post(
        "/field_mapping",
        {"project_name": project_name, "rows": list(FIELD_MAPPING_ROWS)},
        timeout_sec=180,
    )
    client.post(
        "/dataset_types",
        {
            "project_name": project_name,
            "columns": ["Name", "Data Format", "Category", "Calculated", "Formula"],
            "rows": [item.ui_row() for item in RAW_DATASET_TYPES],
        },
        timeout_sec=60,
    )
    client.post(
        "/reserving_class_types",
        {
            "project_name": project_name,
            "columns": ["Name", "Level", "Formula"],
            "rows": [list(row) for row in AGGREGATE_RC_TYPE_ROWS],
        },
        timeout_sec=60,
    )


def verify_aggregate_bottom_paths(
    client: ArcRhoAppClient,
    project_name: str,
    expected_paths: Sequence[str] = AGGREGATE_BOTTOM_PATHS,
) -> tuple[str, ...]:
    # Child discovery is path-dependent. Query each unique prefix once and
    # reuse it across every expected leaf rather than re-reading the same
    # network-drive caches once per target path.
    children_by_prefix: dict[str, dict[str, dict[str, Any]]] = {}
    verified: list[str] = []
    first_request = True

    for expected_path in expected_paths:
        prefix = ""
        for segment in expected_path.split("\\"):
            if prefix not in children_by_prefix:
                response = client.get(
                    "/reserving_class_path_tree/children",
                    params={
                        "project_name": project_name,
                        "prefix": prefix,
                        "force": first_request,
                    },
                    timeout_sec=180,
                )
                first_request = False
                children = response.get("children", [])
                children_by_prefix[prefix] = {
                    str(item.get("name") or ""): item
                    for item in children
                    if isinstance(item, dict) and str(item.get("name") or "")
                }
            child = children_by_prefix[prefix].get(segment)
            if child is None:
                available = sorted(children_by_prefix[prefix])
                raise RuntimeError(
                    f"Aggregate RC path is unavailable at '{prefix or '<root>'}': "
                    f"expected '{segment}', available={available}"
                )
            prefix = str(child.get("path") or "").strip()
        if prefix != expected_path:
            raise RuntimeError(
                f"ArcRho returned unexpected aggregate path '{prefix}' for '{expected_path}'."
            )
        verified.append(prefix)
    return tuple(verified)


def _dataset_request_payload(
    project_name: str,
    reserving_class: str,
    dataset_type: DatasetType,
    request_timeout: float,
) -> tuple[str, dict[str, Any]]:
    common = {
        "Path": reserving_class,
        "ProjectName": project_name,
        "InstanceName": dataset_type.name,
        "DatasetTypeName": dataset_type.name,
        "Cumulative": True,
        "Calendar": False,
        "LocalOnly": False,
        "AllowDerived": True,
        "WriteSidecar": True,
        "timeout_sec": request_timeout,
    }
    if dataset_type.data_format.casefold() == "vector":
        return "/arcrho/vec", {
            **common,
            "VectorName": dataset_type.name,
            "PeriodLength": 12,
        }
    return "/arcrho/tri", {
        **common,
        "TriangleName": dataset_type.name,
        "OriginLength": 12,
        "DevelopmentLength": 12,
    }


def _materialize_one_path(
    client: ArcRhoAppClient,
    project_name: str,
    reserving_class: str,
    dataset_types: Sequence[DatasetType],
    request_timeout: float,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    # Writes for one reserving class stay serial. Parallelism is only across
    # independent RC folders, matching ArcRho's per-target lock discipline.
    for dataset_type in dataset_types:
        endpoint, payload = _dataset_request_payload(
            project_name,
            reserving_class,
            dataset_type,
            request_timeout,
        )
        response = client.post(
            endpoint,
            payload,
            timeout_sec=request_timeout + 20,
        )
        if not response.get("ok"):
            raise RuntimeError(
                f"Dataset materialization failed for {reserving_class} / "
                f"{dataset_type.name}: {response}"
            )
        results.append(
            {
                "reserving_class": reserving_class,
                "dataset_type": dataset_type.name,
                "data_format": dataset_type.data_format,
                "data_path": str(response.get("data_path") or ""),
                "requested": bool(response.get("need_request")),
            }
        )
    return results


def materialize_dataset_phase(
    client: ArcRhoAppClient,
    project_name: str,
    reserving_classes: Sequence[str],
    dataset_types: Sequence[DatasetType],
    *,
    max_workers: int,
    request_timeout: float,
    label: str,
) -> list[dict[str, Any]]:
    if not dataset_types:
        return []
    worker_count = max(1, min(int(max_workers), len(reserving_classes)))
    results_by_path: dict[str, list[dict[str, Any]]] = {}
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = {
            executor.submit(
                _materialize_one_path,
                client,
                project_name,
                reserving_class,
                dataset_types,
                request_timeout,
            ): reserving_class
            for reserving_class in reserving_classes
        }
        completed = 0
        for future in as_completed(futures):
            reserving_class = futures[future]
            try:
                results_by_path[reserving_class] = future.result()
            except Exception as exc:
                errors.append(f"{reserving_class}: {exc}")
            completed += 1
            print(
                f"{label}: completed {completed}/{len(reserving_classes)} RC paths "
                f"({reserving_class})",
                flush=True,
            )
    if errors:
        raise RuntimeError(f"{label} failed: {'; '.join(errors)}")
    return [
        item
        for reserving_class in reserving_classes
        for item in results_by_path.get(reserving_class, [])
    ]


def _save_all_dataset_types(client: ArcRhoAppClient, project_name: str) -> None:
    client.post(
        "/dataset_types",
        {
            "project_name": project_name,
            "columns": ["Name", "Data Format", "Category", "Calculated", "Formula"],
            "rows": [item.ui_row() for item in ALL_DATASET_TYPES],
        },
        timeout_sec=90,
    )


def _register_project(
    client: ArcRhoAppClient,
    project_name: str,
    registry_folder: str,
) -> None:
    registry = client.get("/project_settings/project_map", timeout_sec=15)
    folders = [str(value) for value in registry.get("folders", []) if str(value).strip()]
    project_paths = [
        str(value) for value in registry.get("project_paths", []) if str(value).strip()
    ]
    folder = str(registry_folder or DEFAULT_REGISTRY_FOLDER).strip("\\/ ")
    if folder and folder.casefold() not in {value.casefold() for value in folders}:
        folders.append(folder)
    full_path = f"{folder}\\{project_name}" if folder else project_name
    if project_name.casefold() not in {
        _project_name_from_registry_path(value).casefold() for value in project_paths
    }:
        project_paths.append(full_path)
    client.post(
        "/project_settings/project_map",
        {
            "folders": folders,
            "project_paths": project_paths,
            "file_mtime": registry.get("mtime"),
        },
        timeout_sec=30,
    )


def _configured_workspace(client: ArcRhoAppClient) -> tuple[Path, Path]:
    health = client.get("/app/health", timeout_sec=5)
    if not health.get("ok") or str(health.get("app") or "").casefold() != "arcrho":
        raise RuntimeError(f"The discovered endpoint is not a healthy ArcRho app: {health}")
    workspace = client.get("/workspace_paths", timeout_sec=5)
    config = workspace.get("config") if isinstance(workspace.get("config"), dict) else {}
    root_text = str(config.get("workspace_root") or "").strip()
    paths = config.get("paths") if isinstance(config.get("paths"), dict) else {}
    projects_segment = str(paths.get("projects_dir") or "projects").strip()
    if not root_text or not projects_segment:
        raise RuntimeError(f"ArcRho returned an incomplete workspace configuration: {workspace}")
    server_root = Path(root_text).expanduser().resolve()
    projects_dir = (server_root / projects_segment).resolve()
    if not server_root.is_dir() or not projects_dir.is_dir():
        raise RuntimeError(
            f"Configured ArcRho workspace is unavailable: {server_root} / {projects_dir}"
        )
    return server_root, projects_dir


def build_demo_project(args: argparse.Namespace) -> dict[str, Any]:
    validate_builder_configuration()
    source_profile = inspect_demo_csv(Path(args.source_csv))
    client = ArcRhoAppClient(args.app_url)
    server_root, projects_dir = _configured_workspace(client)
    project_name = str(args.project_name or DEFAULT_PROJECT_NAME).strip()
    if not project_name or re.search(r'[<>:"/\\|?*]', project_name):
        raise ValueError(f"Invalid ArcRho project name: {project_name!r}")
    _require_new_project(client, projects_dir, project_name)

    summary: dict[str, Any] = {
        "project_name": project_name,
        "project_path": str(projects_dir / project_name),
        "server_root": str(server_root),
        "app_url": client.base_url,
        "source_csv": str(source_profile.path),
        "source_rows": source_profile.row_count,
        "accident_months": source_profile.accident_month_count,
        "aggregate_bottom_paths": list(AGGREGATE_BOTTOM_PATHS),
        "dataset_instances": [],
    }
    if args.dry_run:
        summary["dry_run"] = True
        summary["planned_instance_count"] = len(AGGREGATE_BOTTOM_PATHS) * len(
            [item for item in ALL_DATASET_TYPES if item.materialize]
        )
        return summary

    created = False
    try:
        create_result = client.post(
            "/project_settings/project_map/create_project_folder",
            {"name": project_name},
            timeout_sec=30,
        )
        created_name = str(create_result.get("created_folder") or "").strip()
        if created_name != project_name:
            raise RuntimeError(
                f"ArcRho normalized project name to '{created_name}', expected '{project_name}'."
            )
        created = True
        print(f"Created project folder: {projects_dir / project_name}", flush=True)

        _configure_project(client, project_name, source_profile.path)
        print("Imported source data and saved project configuration.", flush=True)

        aggregate_paths = verify_aggregate_bottom_paths(client, project_name)
        print(f"Verified {len(aggregate_paths)} aggregate bottom RC paths.", flush=True)

        raw_to_materialize = tuple(
            item for item in RAW_DATASET_TYPES if item.materialize
        )
        raw_results = materialize_dataset_phase(
            client,
            project_name,
            aggregate_paths,
            raw_to_materialize,
            max_workers=args.max_workers,
            request_timeout=args.request_timeout,
            label="Raw datasets",
        )

        # Add calculated rows only after raw instances exist. This prevents
        # dependent propagation from competing with the initial raw build.
        _save_all_dataset_types(client, project_name)
        calculated_to_materialize = tuple(
            item for item in CALCULATED_DATASET_TYPES if item.materialize
        )
        calculated_results = materialize_dataset_phase(
            client,
            project_name,
            aggregate_paths,
            calculated_to_materialize,
            max_workers=args.max_workers,
            request_timeout=args.request_timeout,
            label="Calculated datasets",
        )
        summary["dataset_instances"] = raw_results + calculated_results
        summary["dataset_instance_count"] = len(summary["dataset_instances"])

        _register_project(client, project_name, args.registry_folder)
        summary["registered_folder"] = str(args.registry_folder)
        print(
            f"Registered {project_name} and created "
            f"{summary['dataset_instance_count']} dataset instances.",
            flush=True,
        )
        return summary
    except Exception:
        if created and not args.keep_partial:
            try:
                client.post(
                    "/project_settings/project_map/delete_project_folder",
                    {"name": project_name},
                    timeout_sec=60,
                )
                print(f"Removed partial project folder: {projects_dir / project_name}", flush=True)
            except Exception as cleanup_error:
                print(
                    f"WARNING: failed to remove partial project {project_name}: {cleanup_error}",
                    file=sys.stderr,
                    flush=True,
                )
        raise


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-name", default=DEFAULT_PROJECT_NAME)
    parser.add_argument("--source-csv", type=Path, default=DEFAULT_SOURCE_CSV)
    parser.add_argument("--registry-folder", default=DEFAULT_REGISTRY_FOLDER)
    parser.add_argument(
        "--app-url",
        default="",
        help="ArcRho app URL; defaults to the endpoint discovered by arcrho_api.",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=4,
        help="Maximum independent reserving-class folders built concurrently.",
    )
    parser.add_argument(
        "--request-timeout",
        type=float,
        default=90.0,
        help="Seconds allowed for each ArcRho Engine dataset request.",
    )
    parser.add_argument(
        "--keep-partial",
        action="store_true",
        help="Keep a newly created but incomplete project when a build fails.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and configured workspace without writing anything.",
    )
    args = parser.parse_args(argv)
    if args.max_workers < 1:
        parser.error("--max-workers must be at least 1")
    if args.request_timeout <= 0:
        parser.error("--request-timeout must be positive")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        summary = build_demo_project(args)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        return 1
    print(json.dumps(summary, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
