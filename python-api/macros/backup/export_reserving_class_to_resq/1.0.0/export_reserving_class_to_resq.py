# <arcrho-macro>
# Title: Export Reserving Class to ResQ
# Version: 1.0.0
# Release Note: Initial release: export reserving-class datasets and supported methods from ArcRho into the ResQ database.
# Description: Export all ArcRho datasets and supported methods (DFM, BF, Cape Cod, Result Selection) for the reserving-class path selected in the active Project Instance page into the ResQ database.
# Scope: Reserving Class
# </arcrho-macro>

from __future__ import annotations

import csv
import importlib.util
import json
from pathlib import Path
import re
import sys
import traceback

MIGRATION_SCRIPT = Path(r"E:\XWSpace\Repos\ArcRho\python-api\migration\resq_data_migration.py")
TITLE = "Export Reserving Class to ResQ"
PROGRESS_ID = "export-reserving-class-to-resq"
DEFAULT_SERVER_ROOT = Path(r"E:\ArcRho Server")

# ResQ enumeration ordinals confirmed against resq_migration.core and the live
# fake-project probe; see python-api/docs/resq_reserving_class_export.md.
RESQ_METHOD_TYPE_DFM = 1
RESQ_METHOD_TYPE_BF = 2
RESQ_METHOD_TYPE_CAPE_COD = 3
RESQ_METHOD_TYPE_RESULT_SELECTION = 4
RESQ_DATA_FORMAT_TRIANGLE = 0
RESQ_DATA_FORMAT_ORIGIN_VECTOR = 1
RESQ_PERC_DEVELOPED_PATTERN = 1
RESQ_PERC_DEVELOPED_CUM_DEV_FACTORS = 2
RESQ_PRIOR_TYPE_ULTIMATES = 0

_FILENAME_TOKEN = re.compile(r"_%([0-9A-Fa-f]{2})_")


def _load_resq_migration_module():
    if not MIGRATION_SCRIPT.exists():
        raise FileNotFoundError(f"ResQ migration script not found: {MIGRATION_SCRIPT}")
    module_dir = str(MIGRATION_SCRIPT.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    spec = importlib.util.spec_from_file_location("arcrho_resq_data_migration", MIGRATION_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load ResQ migration script: {MIGRATION_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _decode_filename_segment(value: str) -> str:
    return _FILENAME_TOKEN.sub(lambda match: chr(int(match.group(1), 16)), str(value or ""))


def _read_json(path: Path):
    try:
        with Path(path).open("r", encoding="utf-8-sig") as stream:
            return json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def _read_csv_matrix(path: Path):
    rows = []
    with Path(path).open("r", encoding="utf-8-sig", newline="") as stream:
        for raw_row in csv.reader(stream):
            row = []
            for cell in raw_row:
                text = str(cell or "").strip()
                if not text:
                    row.append(None)
                    continue
                try:
                    row.append(float(text))
                except ValueError:
                    row.append(None)
            rows.append(row)
    return rows


def _safe_item(collection, name):
    """collection.Item(name) that treats both COM errors and None as missing."""
    try:
        return collection.Item(name)
    except Exception:
        return None


def _iter_collection(collection):
    try:
        count = int(collection.Count)
    except Exception:
        return
    for index in range(1, count + 1):
        try:
            item = collection.Item(index)
        except Exception:
            continue
        if item is not None:
            yield item


def _clean_label(value) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _label_key(value) -> str:
    return _clean_label(value).casefold()


def _safe_number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _dict_path(payload, path):
    current = payload
    for key in path:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


class ExportSkipped(RuntimeError):
    """Raised to record a non-error skip for one exported item."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def collect_rc_artifacts(migration, rc_dir: Path):
    """Enumerate the reserving-class sidecars and method payloads on disk."""

    sidecars = []
    sidecar_dir = rc_dir / migration.DATASET_SIDECAR_DIR
    if sidecar_dir.is_dir():
        for path in sorted(sidecar_dir.glob("*.json")):
            payload = _read_json(path)
            if isinstance(payload, dict) and str(payload.get("dataset_name") or "").strip():
                sidecars.append(payload)

    methods = {"DFM": [], "RS": [], "BF": [], "CC": [], "BSSR": [], "BSCRA": []}
    method_dir = rc_dir / migration.METHOD_DATA_DIR
    if method_dir.is_dir():
        for path in sorted(method_dir.glob("*.json")):
            stem = path.stem
            prefix, _, encoded_name = stem.partition("@")
            if prefix not in methods or not encoded_name:
                continue
            payload = _read_json(path)
            if isinstance(payload, dict):
                methods[prefix].append(
                    {"file_name": path.name, "name": _clean_label(_decode_filename_segment(encoded_name)), "payload": payload}
                )
    return sidecars, methods


class ResQReservingClassExporter:
    """Push one ArcRho reserving class (datasets + supported methods) into ResQ."""

    def __init__(
        self,
        migration,
        *,
        arcrho_project_name: str,
        rc_path: str,
        server_root: Path,
        resq_project_name: str = "",
        connection_name: str = "",
        resq_user_name: str = "",
        resq_password: str = "",
        dry_run: bool = False,
        progress_callback=None,
    ) -> None:
        self.migration = migration
        self.arcrho_project_name = arcrho_project_name
        self.rc_path = rc_path
        self.server_root = Path(server_root)
        self.resq_project_name = resq_project_name or arcrho_project_name
        self.connection_name = connection_name or migration.CONNECTION_NAME
        self.resq_user_name = resq_user_name if resq_user_name else migration.USER_NAME
        self.resq_password = resq_password if resq_password else migration.PASSWORD
        self.dry_run = bool(dry_run)
        self.progress_callback = progress_callback
        self.app = None
        self.project = None
        self.reserving_class = None
        self._lookup_maps = {}
        self.counts = {
            "datasets_written": 0,
            "datasets_created": 0,
            "dfms_written": 0,
            "dfms_created": 0,
            "bfs_written": 0,
            "bfs_created": 0,
            "ccs_written": 0,
            "ccs_created": 0,
            "result_selections_written": 0,
            "result_selections_created": 0,
            "errors": 0,
        }
        self.skipped = {}
        self.error_details = []
        self._completed = 0
        self._total = 0

    # ----- progress / bookkeeping -------------------------------------------------

    def _emit(self, message, status=""):
        if self.progress_callback is None:
            return
        try:
            self.progress_callback(
                {
                    "completed": self._completed,
                    "total": self._total,
                    "message": str(message),
                    "status": status,
                }
            )
        except Exception:
            pass

    def _record_skip(self, kind, name, reason, message):
        self.skipped[reason] = self.skipped.get(reason, 0) + 1
        self._emit(f"Skipped {kind} {name}: {message}", status="skipped")

    def _record_error(self, kind, name, error):
        self.counts["errors"] += 1
        detail = {"kind": kind, "name": str(name), "message": str(error)}
        self.error_details.append(detail)
        self._emit(f"Error on {kind} {name}: {error}", status="error")

    # ----- ResQ session -----------------------------------------------------------

    def connect(self):
        try:
            import win32com.client
        except ImportError as exc:
            raise RuntimeError("pywin32 is required to reach the ResQ COM API: pip install pywin32") from exc

        self._emit(f"Connecting to ResQ: {self.connection_name}")
        self.app = win32com.client.Dispatch("ResQ3Automation.ResQApplication")
        try:
            self.app.ConnectByName(self.connection_name, self.resq_user_name, self.resq_password)
        except Exception as exc:
            raise RuntimeError(f"Could not connect to ResQ COM API ({self.connection_name}): {exc}") from exc
        self.project = _safe_item(self.app.Projects(), self.resq_project_name)
        if self.project is None:
            raise RuntimeError(f"ResQ project not found: {self.resq_project_name}")
        self.reserving_class = _safe_item(self.project.ReservingClasses(), self.rc_path)
        if self.reserving_class is None:
            raise RuntimeError(
                f"ResQ reserving class not found in project {self.resq_project_name}: {self.rc_path}"
            )

    def disconnect(self):
        if self.reserving_class is not None:
            try:
                self.reserving_class.UnloadChildren()
            except Exception:
                pass
        if self.app is not None:
            try:
                self.app.Disconnect()
            except Exception:
                pass
        self.app = None
        self.project = None
        self.reserving_class = None
        self._lookup_maps = {}

    # ----- shared lookups ---------------------------------------------------------
    #
    # ResQ names may carry stray leading/trailing/internal whitespace that ArcRho
    # normalized away on import, so a plain collection.Item(name) can miss an
    # existing object. Every lookup therefore falls back to a cached
    # whitespace-normalized name map.

    def _collection_map(self, cache_key, collection_factory):
        lookup = self._lookup_maps.get(cache_key)
        if lookup is None:
            lookup = {}
            for item in _iter_collection(collection_factory()):
                key = _label_key(getattr(item, "Name", ""))
                if key:
                    lookup.setdefault(key, item)
            self._lookup_maps[cache_key] = lookup
        return lookup

    def _find_in(self, cache_key, collection_factory, name):
        target = _safe_item(collection_factory(), name)
        if target is not None:
            return target
        return self._collection_map(cache_key, collection_factory).get(_label_key(name))

    def _find_triangle(self, name):
        return self._find_in("triangles", self.reserving_class.Triangles, name)

    def _find_vector(self, name):
        return self._find_in("vectors", self.reserving_class.Vectors, name)

    def _find_dataset(self, name):
        target = self._find_triangle(name)
        if target is None:
            target = self._find_vector(name)
        return target

    def _register_lookup(self, cache_key, name, item):
        lookup = self._lookup_maps.get(cache_key)
        if lookup is not None:
            lookup.setdefault(_label_key(name), item)

    def _ensure_dataset_type(self, type_name, category_name, data_format_code):
        dataset_types = self.project.DatasetTypes()
        dataset_type = self._find_in("dataset_types", self.project.DatasetTypes, type_name)
        if dataset_type is not None:
            return dataset_type
        if self.dry_run:
            raise ExportSkipped("dry_run_missing_dataset_type", f"Dataset Type missing in ResQ: {type_name}")
        try:
            dataset_type = dataset_types.Add()
            dataset_type.Name = type_name
            category = _safe_item(self.project.Categories(), category_name) if category_name else None
            if category is not None:
                dataset_type.Category = category
            dataset_type.DataFormat = int(data_format_code)
            dataset_type.Save()
            self._register_lookup("dataset_types", type_name, dataset_type)
        except Exception as exc:
            if "permission" in str(exc).casefold():
                raise ExportSkipped(
                    "dataset_type_not_creatable",
                    f"Dataset Type {type_name} is missing in ResQ and this ResQ user "
                    "may not create Dataset Types",
                ) from exc
            raise
        return dataset_type

    # ----- datasets ---------------------------------------------------------------

    def export_datasets(self, sidecars):
        exportable = []
        for sidecar in sidecars:
            name = _clean_label(sidecar.get("dataset_name"))
            method_code = int(sidecar.get("method_type_code") or 0)
            if method_code in (1, 2, 3, 4):
                # Owned by the ResQ method that produces it; exported with the method.
                continue
            if method_code != 0:
                self._record_skip(
                    "dataset",
                    name,
                    "unsupported_method_type",
                    f"method type {sidecar.get('method_type') or method_code} is not exported",
                )
                continue
            exportable.append(sidecar)

        for sidecar in exportable:
            name = _clean_label(sidecar.get("dataset_name"))
            self._completed += 1
            try:
                self._export_dataset_values(sidecar, name)
            except ExportSkipped as skip:
                self._record_skip("dataset", name, skip.reason, str(skip))
            except Exception as exc:
                self._record_error("dataset", name, exc)

    def _export_dataset_values(self, sidecar, name):
        data_format = _clean_label(sidecar.get("data_format"))
        format_code = sidecar.get("data_format_code")
        is_triangle = (int(format_code) == 0) if format_code is not None else data_format.casefold() == "triangle"

        csv_file = str(sidecar.get("csv_file") or "").strip()
        csv_path = (
            self.server_root
            / "projects"
            / self.arcrho_project_name
            / "data"
            / self.migration._encode_rc_folder(self.rc_path)
            / self.migration.DATASET_CACHE_DIR
            / csv_file
        )
        if not csv_file or not csv_path.is_file():
            raise ExportSkipped(
                "missing_csv_cache",
                "no dataset CSV cache on disk (open the dataset once in ArcRho to build it)",
            )
        values = _read_csv_matrix(csv_path)
        if not values:
            raise ExportSkipped("empty_csv_cache", "dataset CSV cache is empty")

        target = self._find_dataset(name)
        created = False
        if target is None:
            target = self._create_dataset(sidecar, name, is_triangle)
            created = True
        elif bool(getattr(target, "Calculated", False)):
            raise ExportSkipped("calculated_in_resq", "ResQ dataset is calculated; ResQ recomputes its values")

        if self.dry_run:
            self._emit(f"[dry run] would write {name}")
            return

        if is_triangle:
            self._write_triangle_values(target, sidecar, values)
        else:
            self._write_vector_values(target, values)
        self.counts["datasets_written"] += 1
        if created:
            self.counts["datasets_created"] += 1
        self._emit(f"Exported dataset: {name}", status="success")

    def _create_dataset(self, sidecar, name, is_triangle):
        type_name = _clean_label(sidecar.get("dataset_type")) or name
        category = _clean_label(sidecar.get("dataset_category"))
        format_code = RESQ_DATA_FORMAT_TRIANGLE if is_triangle else RESQ_DATA_FORMAT_ORIGIN_VECTOR
        dataset_type = self._ensure_dataset_type(type_name, category, format_code)
        if self.dry_run:
            raise ExportSkipped("dry_run_would_create", "dataset does not exist in ResQ yet")
        collection = self.reserving_class.Triangles() if is_triangle else self.reserving_class.Vectors()
        target = collection.Add()
        target.Name = name
        target.DatasetType = dataset_type
        if is_triangle:
            cumulative = sidecar.get("cumulative")
            if cumulative is not None:
                target.Cumulative = bool(cumulative)
        formula = str(sidecar.get("formula") or "").strip()
        if bool(sidecar.get("calculated")) and formula:
            target.Calculated = True
            target.Formula = formula
        target.Save()
        self._register_lookup("triangles" if is_triangle else "vectors", name, target)
        return target

    def _triangle_row_width(self, triangle, origin_index):
        for attr in ("DevelopmentCountByIndex", "DevelopmentCount"):
            try:
                return int(getattr(triangle, attr)(origin_index))
            except Exception:
                continue
        return 0

    def _write_triangle_values(self, triangle, sidecar, values):
        origin_length = int(sidecar.get("origin_length") or 0)
        development_length = int(sidecar.get("development_length") or 0)
        # The ArcRho CSV was captured at the sidecar display lengths; align the
        # ResQ display grid before writing by index so rows/columns match.
        if origin_length and int(getattr(triangle, "OriginLength", 0) or 0) != origin_length:
            triangle.OriginLength = origin_length
        if development_length and int(getattr(triangle, "DevelopmentLength", 0) or 0) != development_length:
            triangle.DevelopmentLength = development_length
        if bool(getattr(triangle, "Calculated", False)):
            raise ExportSkipped("calculated_in_resq", "ResQ dataset is calculated; ResQ recomputes its values")
        try:
            triangle.ClearData()
        except Exception:
            pass
        origin_count = int(triangle.OriginCount)
        for origin_index in range(1, min(origin_count, len(values)) + 1):
            row = values[origin_index - 1]
            width = self._triangle_row_width(triangle, origin_index)
            for development_index in range(1, min(width, len(row)) + 1):
                value = row[development_index - 1]
                if value is None:
                    continue
                triangle.SetValuesByIndex(origin_index, development_index, float(value))
        triangle.Save()

    def _write_vector_values(self, vector, values):
        flat = [row[0] if row else None for row in values]
        display_length = None
        try:
            stored_length = int(vector.StoredPeriodLength)
            display_length = int(vector.PeriodLength)
            if display_length != stored_length:
                vector.PeriodLength = stored_length
            else:
                display_length = None
        except Exception:
            display_length = None
        try:
            count = int(vector.Count)
            for index in range(1, min(count, len(flat)) + 1):
                value = flat[index - 1]
                if value is None:
                    continue
                vector.SetValuesByIndex(index, float(value))
        finally:
            if display_length is not None:
                try:
                    vector.PeriodLength = display_length
                except Exception:
                    pass
        vector.Save()

    # ----- DFM methods ------------------------------------------------------------

    def export_dfms(self, dfm_entries):
        for entry in dfm_entries:
            self._completed += 1
            payload = entry["payload"]
            details = _dict_path(payload, ("details tab",))
            name = _clean_label(details.get("name")) or entry["name"]
            try:
                self._export_dfm(name, details, payload)
            except ExportSkipped as skip:
                self._record_skip("DFM", name, skip.reason, str(skip))
            except Exception as exc:
                self._record_error("DFM", name, exc)

    def _export_dfm(self, name, details, payload):
        dfm = self._find_in("dfm_methods", self.reserving_class.DFMMethods, name)
        created = False
        if dfm is None:
            dfm = self._create_dfm(name, details)
            created = True
        if self.dry_run:
            self._emit(f"[dry run] would sync DFM {name}")
            return
        excluded = self._sync_dfm_excluded_ratios(dfm, payload)
        user_values = self._sync_dfm_user_entry_values(dfm, payload)
        selected = self._sync_dfm_selected_ratios(dfm, payload)
        dfm.Save()
        self.counts["dfms_written"] += 1
        if created:
            self.counts["dfms_created"] += 1
        self._emit(
            f"Exported DFM: {name} (excluded {excluded}, user values {user_values}, selected {selected})",
            status="success",
        )

    def _create_dfm(self, name, details):
        if self.dry_run:
            raise ExportSkipped("dry_run_would_create", "DFM method does not exist in ResQ yet")
        input_triangle_name = _clean_label(details.get("input triangle"))
        input_triangle = self._find_triangle(input_triangle_name) if input_triangle_name else None
        if input_triangle is None:
            raise ExportSkipped(
                "missing_input_triangle",
                f"input triangle not found in ResQ: {input_triangle_name or '<unset>'}",
            )
        output_dataset = _clean_label(details.get("output dataset")) or name
        output_type = _clean_label(details.get("output type")) or output_dataset
        output_category = _clean_label(details.get("output category"))
        dataset_type = self._ensure_dataset_type(output_type, output_category, RESQ_DATA_FORMAT_ORIGIN_VECTOR)

        dfm = self.reserving_class.AddMethod(RESQ_METHOD_TYPE_DFM)
        dfm.Name = name
        dfm.InputTriangle = input_triangle
        dfm.OutputVector.Name = output_dataset
        dfm.OutputVector.DatasetType = dataset_type
        origin_length = int(details.get("origin length") or 0)
        development_length = int(details.get("development length") or 0)
        if origin_length:
            dfm.OriginLength = origin_length
        if development_length:
            dfm.DevelopmentLength = development_length
        dfm.Save()
        return dfm

    def _dfm_development_column_count(self, dfm):
        try:
            rows = int(dfm.OriginCount)
        except Exception:
            return 0
        widths = []
        for origin_index in range(1, rows + 1):
            try:
                widths.append(int(dfm.DevelopmentCount(origin_index)))
            except Exception:
                continue
        return max(widths, default=0)

    def _sync_dfm_excluded_ratios(self, dfm, payload):
        pattern = _dict_path(payload, ("ratios tab", "ratio triangle")).get("excluded")
        if not isinstance(pattern, list):
            return 0
        origin_count = int(getattr(dfm, "OriginCount", 0) or 0)
        updates = 0
        for origin_index, row in enumerate(pattern, start=1):
            if origin_index > origin_count or not isinstance(row, list):
                continue
            try:
                ratio_count = max(int(dfm.DevelopmentCount(origin_index)) - 1, 0)
            except Exception:
                continue
            for development_index, raw_value in enumerate(row, start=1):
                if development_index > ratio_count:
                    break
                if raw_value in (0, False, "0"):
                    value = 0
                elif raw_value in (1, True, "1"):
                    value = 1
                else:
                    continue  # 2 == no data; ResQ derives empty cells itself
                dfm.SetExcludedRatios(OriginIndex=origin_index, DevIndex=development_index, arg2=value)
                updates += 1
        return updates

    def _average_formula_display_indexes(self, dfm):
        out = {}
        for api_index in range(1, 50):
            try:
                raw_name = str(dfm.AverageFormula(api_index))
            except Exception:
                break
            match = re.match(r"^\s*(\d+)\s*:\s*(.*?)\s*$", raw_name)
            if match:
                display_index, label = int(match.group(1)), match.group(2)
            else:
                display_index, label = api_index - 1, raw_name.strip()
            out.setdefault(label, display_index)
            if label == "User Entry":
                break
        return out

    def _user_entry_payload_row_index(self, average_formulas):
        settings = average_formulas.get("custom average formula settings")
        average_types = settings.get("averageType") if isinstance(settings, dict) else None
        if isinstance(average_types, list):
            for index, average_type in enumerate(average_types):
                if str(average_type or "").strip().casefold() == "user_entry":
                    return index
        labels = average_formulas.get("label")
        if isinstance(labels, list):
            for index, label in enumerate(labels):
                normalized = _label_key(label)
                if normalized == "user entry" or normalized.startswith("user entry "):
                    return index
        return None

    def _sync_dfm_user_entry_values(self, dfm, payload):
        average_formulas = _dict_path(payload, ("ratios tab", "average formulas"))
        values = average_formulas.get("values")
        if not isinstance(values, list):
            return 0
        row_index = self._user_entry_payload_row_index(average_formulas)
        if row_index is None or row_index >= len(values) or not isinstance(values[row_index], list):
            return 0
        display_indexes = self._average_formula_display_indexes(dfm)
        avg_index = None
        for label, display_index in display_indexes.items():
            normalized = _label_key(label)
            if normalized == "user entry" or normalized.startswith("user entry "):
                avg_index = display_index
                break
        if avg_index is None:
            return 0
        column_count = self._dfm_development_column_count(dfm)
        updates = 0
        for development_index, raw_value in enumerate(values[row_index], start=1):
            if development_index > column_count:
                break
            value = _safe_number(raw_value)
            if value is None or value <= 0:
                continue
            dfm.SetUserRatios(DevIndex=development_index, AvgIndex=avg_index, arg2=value)
            updates += 1
        return updates

    def _sync_dfm_selected_ratios(self, dfm, payload):
        average_formulas = _dict_path(payload, ("ratios tab", "average formulas"))
        labels = average_formulas.get("label")
        selected = average_formulas.get("selected")
        if not isinstance(labels, list) or not isinstance(selected, list):
            return 0
        label_to_display_index = self._average_formula_display_indexes(dfm)
        column_count = self._dfm_development_column_count(dfm)
        updates = 0
        for development_index in range(1, column_count + 1):
            selected_label = ""
            for row_index, row in enumerate(selected):
                if row_index >= len(labels) or not isinstance(row, list):
                    continue
                if development_index - 1 < len(row) and row[development_index - 1] in (1, True, "1"):
                    selected_label = str(labels[row_index])
                    break
            if not selected_label:
                continue
            display_index = label_to_display_index.get(selected_label)
            if display_index is None:
                continue
            dfm.SetSelectedRatios(DevIndex=development_index, arg1=display_index)
            updates += 1
        return updates

    # ----- Bornhuetter Ferguson ---------------------------------------------------

    def export_bfs(self, bf_entries):
        for entry in bf_entries:
            self._completed += 1
            payload = entry["payload"]
            details = _dict_path(payload, ("details_tab",))
            name = _clean_label(details.get("name")) or entry["name"]
            try:
                self._export_bf(name, details, payload)
            except ExportSkipped as skip:
                self._record_skip("BF", name, skip.reason, str(skip))
            except Exception as exc:
                self._record_error("BF", name, exc)

    def _find_method_by_output(self, collection, name):
        direct = _safe_item(collection, name)
        if direct is not None:
            return direct
        key = _label_key(name)
        for method in _iter_collection(collection):
            try:
                output_name = _label_key(method.OutputVector.Name)
            except Exception:
                output_name = ""
            if key and (output_name == key or _label_key(getattr(method, "Name", "")) == key):
                return method
        return None

    def _export_bf(self, name, details, payload):
        bf = self._find_method_by_output(self.reserving_class.BFMethods(), name)
        created = False
        if bf is None:
            if self.dry_run:
                raise ExportSkipped("dry_run_would_create", "BF method does not exist in ResQ yet")
            output_type = _clean_label(details.get("output_type")) or name
            category = _clean_label(details.get("dataset_category"))
            dataset_type = self._ensure_dataset_type(output_type, category, RESQ_DATA_FORMAT_ORIGIN_VECTOR)
            bf = self.reserving_class.AddMethod(RESQ_METHOD_TYPE_BF)
            bf.Name = name
            bf.OutputVector.Name = name
            bf.OutputVector.DatasetType = dataset_type
            created = True
        if self.dry_run:
            self._emit(f"[dry run] would sync BF {name}")
            return

        method_tab = _dict_path(payload, ("method_tab",))
        origin_length = int(details.get("origin_length") or 0)
        if origin_length:
            bf.OriginLength = origin_length

        latest_name = _clean_label(method_tab.get("latest_dataset"))
        if latest_name:
            latest = self._find_triangle(latest_name)
            if latest is not None:
                bf.LatestType = RESQ_DATA_FORMAT_TRIANGLE
                bf.Latest = latest
            else:
                latest = self._find_vector(latest_name)
                if latest is not None:
                    bf.LatestType = RESQ_DATA_FORMAT_ORIGIN_VECTOR
                    bf.Latest = latest

        developed_name = _clean_label(method_tab.get("dfm_dataset"))
        if developed_name:
            developed = self._find_vector(developed_name)
            if developed is not None:
                developed_type = method_tab.get("percentage_developed_type_code")
                if developed_type is None:
                    developed_type = RESQ_PERC_DEVELOPED_CUM_DEV_FACTORS
                bf.PercentageDevelopedType = int(developed_type)
                bf.PercentageDeveloped = developed

        priors = method_tab.get("prior_datasets")
        if isinstance(priors, list) and priors:
            prior_name = _clean_label(priors[0].get("name") if isinstance(priors[0], dict) else "")
            if prior_name:
                prior = self._find_vector(prior_name)
                if prior is not None:
                    prior_type = method_tab.get("prior_type_code")
                    bf.PriorType = int(prior_type) if prior_type is not None else RESQ_PRIOR_TYPE_ULTIMATES
                    bf.Prior = prior
        bf.Save()
        self.counts["bfs_written"] += 1
        if created:
            self.counts["bfs_created"] += 1
        self._emit(f"Exported BF: {name}", status="success")

    # ----- Cape Cod ---------------------------------------------------------------

    def export_ccs(self, cc_entries):
        for entry in cc_entries:
            self._completed += 1
            payload = entry["payload"]
            details = _dict_path(payload, ("details_tab",))
            name = _clean_label(details.get("name")) or entry["name"]
            try:
                self._export_cc(name, details, payload)
            except ExportSkipped as skip:
                self._record_skip("CC", name, skip.reason, str(skip))
            except Exception as exc:
                self._record_error("CC", name, exc)

    def _export_cc(self, name, details, payload):
        cc = self._find_method_by_output(self.reserving_class.CapeCodMethods(), name)
        created = False
        if cc is None:
            if self.dry_run:
                raise ExportSkipped("dry_run_would_create", "Cape Cod method does not exist in ResQ yet")
            output_type = _clean_label(details.get("output_type")) or name
            category = _clean_label(details.get("dataset_category"))
            dataset_type = self._ensure_dataset_type(output_type, category, RESQ_DATA_FORMAT_ORIGIN_VECTOR)
            cc = self.reserving_class.AddMethod(RESQ_METHOD_TYPE_CAPE_COD)
            cc.Name = name
            cc.OutputVector.Name = name
            cc.OutputVector.DatasetType = dataset_type
            created = True
        if self.dry_run:
            self._emit(f"[dry run] would sync CC {name}")
            return

        method_tab = _dict_path(payload, ("method_tab",))
        origin_length = int(details.get("origin_length") or 0)
        if origin_length:
            cc.OriginLength = origin_length

        exposure_name = _clean_label(method_tab.get("exposure_dataset"))
        if exposure_name:
            exposure = self._find_vector(exposure_name)
            if exposure is not None:
                cc.Exposure = exposure

        latest_name = _clean_label(method_tab.get("latest_dataset"))
        if latest_name:
            latest = self._find_triangle(latest_name)
            if latest is not None:
                cc.LatestType = RESQ_DATA_FORMAT_TRIANGLE
                cc.Latest = latest

        developed_name = _clean_label(method_tab.get("prior_ultimate_dataset"))
        if developed_name:
            developed = self._find_vector(developed_name)
            if developed is not None:
                mode = _label_key(method_tab.get("prior_ultimate_mode"))
                cc.PercentageDevelopedType = (
                    RESQ_PERC_DEVELOPED_PATTERN if mode == "pattern" else RESQ_PERC_DEVELOPED_CUM_DEV_FACTORS
                )
                cc.PercentageDeveloped = developed

        auto_trend = method_tab.get("auto_trend_fit")
        if auto_trend is not None:
            cc.AutoTrendFit = bool(auto_trend)
        trend_rate = _safe_number(method_tab.get("trend_rate"))
        if trend_rate is not None and not bool(auto_trend):
            cc.TrendRate = trend_rate
        decay = _safe_number(method_tab.get("decay_factor"))
        if decay is not None:
            cc.DecayFactor = decay
        alt_calc = method_tab.get("alternative_ultimate_calculation")
        if alt_calc is not None:
            try:
                cc.AltUltimateCalc = bool(alt_calc)
            except Exception:
                pass
        cc.Save()
        self.counts["ccs_written"] += 1
        if created:
            self.counts["ccs_created"] += 1
        self._emit(f"Exported CC: {name}", status="success")

    # ----- Result Selection -------------------------------------------------------

    def export_result_selections(self, rs_entries):
        for entry in rs_entries:
            self._completed += 1
            payload = entry["payload"]
            details = _dict_path(payload, ("details_tab",))
            name = _clean_label(details.get("name")) or entry["name"]
            try:
                self._export_result_selection(name, details, payload)
            except ExportSkipped as skip:
                self._record_skip("Result Selection", name, skip.reason, str(skip))
            except Exception as exc:
                self._record_error("Result Selection", name, exc)

    def _export_result_selection(self, name, details, payload):
        rs = self._find_method_by_output(self.reserving_class.ResultSelections(), name)
        created = False
        method_tab = _dict_path(payload, ("method_tab",))
        loaded = method_tab.get("loaded_datasets")
        loaded = loaded if isinstance(loaded, list) else []
        if rs is None:
            if self.dry_run:
                raise ExportSkipped("dry_run_would_create", "Result Selection does not exist in ResQ yet")
            output_type = _clean_label(details.get("output_type")) or name
            dataset_type = self._ensure_dataset_type(output_type, "", RESQ_DATA_FORMAT_ORIGIN_VECTOR)
            rs = self.reserving_class.AddMethod(RESQ_METHOD_TYPE_RESULT_SELECTION)
            rs.Name = name
            rs.OutputVector.Name = name
            rs.OutputVector.DatasetType = dataset_type
            created = True
        if self.dry_run:
            self._emit(f"[dry run] would sync Result Selection {name}")
            return

        origin_length = int(details.get("origin_length") or 0)
        if origin_length:
            rs.OriginLength = origin_length

        # Ensure every ArcRho source dataset is loaded into the ResQ method.
        existing = {}
        dataset_count = int(getattr(rs, "DatasetCount", 0) or 0)
        for dataset_index in range(1, dataset_count + 1):
            try:
                existing[_label_key(rs.Dataset(dataset_index).Name)] = dataset_index
            except Exception:
                continue
        for source in loaded:
            source_name = _clean_label(source.get("name") if isinstance(source, dict) else "")
            if not source_name or _label_key(source_name) in existing:
                continue
            dataset = self._find_dataset(source_name)
            if dataset is None:
                self._record_skip(
                    "Result Selection dataset",
                    source_name,
                    "missing_rs_source_dataset",
                    f"{name}: source dataset not found in ResQ",
                )
                continue
            rs.AddDataset(dataset)
        if created or any(_label_key(str(s.get("name") or "")) not in existing for s in loaded if isinstance(s, dict)):
            rs.Save()

        # Refresh the index map after AddDataset calls.
        existing = {}
        dataset_count = int(getattr(rs, "DatasetCount", 0) or 0)
        for dataset_index in range(1, dataset_count + 1):
            try:
                existing[_label_key(rs.Dataset(dataset_index).Name)] = dataset_index
            except Exception:
                continue

        origin_count = int(getattr(rs, "OriginCount", 0) or 0)
        weight_updates = 0
        for source in loaded:
            if not isinstance(source, dict):
                continue
            dataset_index = existing.get(_label_key(source.get("name")))
            weights = source.get("weights")
            if dataset_index is None or not isinstance(weights, list):
                continue
            for origin_index, raw_value in enumerate(weights, start=1):
                if origin_index > origin_count:
                    break
                value = _safe_number(raw_value)
                rs.SetWeights(dataset_index, origin_index, 0.0 if value is None else value)
                weight_updates += 1

        overrides = method_tab.get("ultimate_overrides")
        override_updates = 0
        if isinstance(overrides, list):
            try:
                rs.ClearOverriddenUltimates()
            except Exception:
                pass
            rs_origin_length = int(getattr(rs, "OriginLength", 0) or 0) or origin_length
            for origin_index, raw_value in enumerate(overrides, start=1):
                if origin_index > origin_count:
                    break
                value = _safe_number(raw_value)
                if value is None:
                    continue
                rs.SetUltimates(origin_index, rs_origin_length, value)
                override_updates += 1
        rs.Save()
        self.counts["result_selections_written"] += 1
        if created:
            self.counts["result_selections_created"] += 1
        self._emit(
            f"Exported Result Selection: {name} (weights {weight_updates}, overrides {override_updates})",
            status="success",
        )

    # ----- top-level --------------------------------------------------------------

    def run(self):
        rc_dir = (
            self.server_root
            / "projects"
            / self.arcrho_project_name
            / "data"
            / self.migration._encode_rc_folder(self.rc_path)
        )
        if not rc_dir.is_dir():
            raise RuntimeError(f"ArcRho reserving-class folder not found: {rc_dir}")
        sidecars, methods = collect_rc_artifacts(self.migration, rc_dir)
        for prefix, kind in (("BSSR", "berquist_sherman_sr"), ("BSCRA", "berquist_sherman_cra")):
            for entry in methods[prefix]:
                self._record_skip(
                    "method",
                    entry["name"],
                    "berquist_sherman_not_supported",
                    "Berquist Sherman method creation is not documented in the ResQ COM API",
                )

        plain_datasets = [
            sidecar
            for sidecar in sidecars
            if int(sidecar.get("method_type_code") or 0) == 0
        ]
        self._total = (
            len(plain_datasets)
            + len(methods["DFM"])
            + len(methods["BF"])
            + len(methods["CC"])
            + len(methods["RS"])
        )
        self._emit(
            f"Exporting {len(plain_datasets)} datasets and "
            f"{len(methods['DFM'])} DFM / {len(methods['BF'])} BF / "
            f"{len(methods['CC'])} CC / {len(methods['RS'])} RS methods"
        )

        self.connect()
        try:
            delayed = False
            if not self.dry_run:
                try:
                    self.project.BeginDelayedUpdate()
                    delayed = True
                except Exception:
                    delayed = False
            try:
                self.export_datasets(sidecars)
                if delayed:
                    self.project.EndDelayedUpdate()
                    delayed = False
            except Exception:
                if delayed:
                    try:
                        self.project.CancelDelayedUpdate()
                    except Exception:
                        pass
                    delayed = False
                raise
            self.export_dfms(methods["DFM"])
            self.export_bfs(methods["BF"])
            self.export_ccs(methods["CC"])
            self.export_result_selections(methods["RS"])
        finally:
            self.disconnect()

        return {
            "arcrho_project": self.arcrho_project_name,
            "resq_project": self.resq_project_name,
            "rc_path": self.rc_path,
            "connection": self.connection_name,
            "dry_run": self.dry_run,
            "counts": dict(self.counts),
            "skipped": dict(self.skipped),
            "error_details": list(self.error_details),
        }


def export_reserving_class_to_resq(
    project_name,
    rc_path,
    *,
    server_root=None,
    resq_project_name="",
    connection_name="",
    resq_user_name="",
    resq_password="",
    dry_run=False,
    progress_callback=None,
    migration=None,
):
    """Headless entry point used by the macro UI flow, tests, and __main__."""

    migration = migration or _load_resq_migration_module()
    exporter = ResQReservingClassExporter(
        migration,
        arcrho_project_name=str(project_name),
        rc_path=str(rc_path),
        server_root=Path(server_root) if server_root else DEFAULT_SERVER_ROOT,
        resq_project_name=str(resq_project_name or ""),
        connection_name=str(connection_name or ""),
        resq_user_name=str(resq_user_name or ""),
        resq_password=str(resq_password or ""),
        dry_run=bool(dry_run),
        progress_callback=progress_callback,
    )
    return exporter.run()


# ----- macro UI flow ------------------------------------------------------------------


def _message(ui, text, *, title=TITLE, kind="info", auto_close_ms=None, buttons=None):
    try:
        return ui.message_box(
            str(text or ""),
            title=title,
            kind=kind,
            auto_close_ms=auto_close_ms,
            buttons=buttons,
            timeout_sec=600,
        )
    except TypeError:
        return ui.message_box(str(text or ""), title=title, kind=kind)


def _context_value(context, *names):
    if not isinstance(context, dict):
        return ""
    for name in names:
        value = str(context.get(name) or "").strip()
        if value:
            return value
    return ""


def _has_export_context(context) -> bool:
    return isinstance(context, dict) and bool(
        _context_value(context, "projectName", "project_name")
        and _context_value(context, "selectedPath", "selected_path", "path")
    )


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _make_progress_callback(progress):
    def callback(event):
        cancel_checker = globals().get("check_macro_cancelled")
        if callable(cancel_checker):
            cancel_checker()
        activity_reporter = globals().get("report_macro_activity")
        if callable(activity_reporter):
            activity_reporter()
        if progress is None or not isinstance(event, dict):
            return
        total = _safe_int(event.get("total"), 0)
        completed = _safe_int(event.get("completed"), 0)
        message = str(event.get("message") or "Exporting to ResQ")
        status = str(event.get("status") or "").casefold()
        tone = {"error": "error", "skipped": "warning", "success": "success"}.get(status)
        try:
            progress.update(
                completed=completed if total > 0 else None,
                total=total if total > 0 else None,
                label=message,
                detail=message,
                tone=tone,
            )
        except Exception:
            pass

    return callback


def _summary_message(result):
    counts = result.get("counts") or {}
    skipped = result.get("skipped") or {}
    lines = [
        "Export to ResQ completed." if not counts.get("errors") else "Export to ResQ completed with errors.",
        f"ArcRho project: {result.get('arcrho_project')}",
        f"ResQ project: {result.get('resq_project')} ({result.get('connection')})",
        f"Path: {result.get('rc_path')}",
        "",
        f"Datasets written: {counts.get('datasets_written', 0)} (created {counts.get('datasets_created', 0)})",
        f"DFM methods: {counts.get('dfms_written', 0)} (created {counts.get('dfms_created', 0)})",
        f"BF methods: {counts.get('bfs_written', 0)} (created {counts.get('bfs_created', 0)})",
        f"Cape Cod methods: {counts.get('ccs_written', 0)} (created {counts.get('ccs_created', 0)})",
        f"Result Selections: {counts.get('result_selections_written', 0)} "
        f"(created {counts.get('result_selections_created', 0)})",
        f"Errors: {counts.get('errors', 0)}",
    ]
    if skipped:
        lines.append("")
        lines.append("Skipped:")
        for reason in sorted(skipped):
            lines.append(f"- {reason}: {skipped[reason]}")
    details = result.get("error_details") or []
    if details:
        lines.append("")
        lines.append("Details:")
        for detail in details[:12]:
            lines.append(f"- {detail.get('kind')} {detail.get('name')}: {detail.get('message')}")
    return "\n".join(lines)


def run_macro(active_dfm=None, active_context=None):
    from arcrho_api import ArcRhoUI, get_server_root

    ui = ArcRhoUI()
    progress = None
    try:
        migration = _load_resq_migration_module()
    except Exception as exc:
        message = f"Could not load the ResQ migration helpers.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}

    try:
        context = (
            active_context
            if _has_export_context(active_context)
            else ui.project_instance.context(timeout_sec=10)
        )
        project_name = _context_value(context, "projectName", "project_name")
        rc_path = _context_value(context, "selectedPath", "selected_path", "path")
        if not project_name or not rc_path:
            raise ValueError("The active Project Instance page does not expose a project and reserving-class path.")
    except Exception as exc:
        message = (
            "Activate a Project Instance page and select a valid reserving-class path "
            f"before exporting to ResQ.\n\n{exc}"
        )
        _message(ui, message, kind="warning")
        return {"success": False, "message": message}

    confirmation = _message(
        ui,
        (
            "Export all ArcRho datasets and supported methods to the ResQ database?\n\n"
            f"ResQ connection: {migration.CONNECTION_NAME}\n"
            f"ResQ project: {project_name}\n"
            f"Path: {rc_path}\n\n"
            "Matching ResQ datasets and method selections will be overwritten. "
            "Bootstrap and Berquist Sherman methods are not exported."
        ),
        kind="warning",
        buttons=["Export", "Cancel"],
    )
    if str(getattr(confirmation, "button", "") or "").strip().casefold() != "export":
        return {"success": False, "message": "Export cancelled by user.", "cancelled": True}

    try:
        server_root = get_server_root(required=True)
    except Exception as exc:
        message = f"Could not resolve the ArcRho Server root.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}

    try:
        progress = ui.progress_bar(
            progress_id=PROGRESS_ID,
            title=TITLE,
            label=f"Preparing export to ResQ: {rc_path}",
            total=0,
        )
    except Exception:
        progress = None

    try:
        result = export_reserving_class_to_resq(
            project_name,
            rc_path,
            server_root=server_root,
            progress_callback=_make_progress_callback(progress),
            migration=migration,
        )
    except Exception as exc:
        if progress is not None:
            try:
                progress.update(label="Export failed", tone="error")
            except Exception:
                pass
        tb = traceback.format_exc()
        message = (
            f"Export to ResQ failed.\n\nProject: {project_name}\nPath: {rc_path}\n\n{exc}"
        )
        _message(ui, f"{message}\n\n{tb}", kind="error")
        return {"success": False, "message": message, "traceback": tb}
    finally:
        if progress is not None:
            try:
                progress.close(auto_close_ms=1500)
            except Exception:
                pass

    errors = _safe_int((result.get("counts") or {}).get("errors"), 0)
    message = _summary_message(result)
    _message(ui, message, kind="warning" if errors else "info", auto_close_ms=None if errors else 5000)
    return {"success": errors == 0, "message": message, "result": result}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Export one ArcRho reserving class into ResQ.")
    parser.add_argument("project_name")
    parser.add_argument("rc_path")
    parser.add_argument("--server-root", default=str(DEFAULT_SERVER_ROOT))
    parser.add_argument("--resq-project", default="")
    parser.add_argument("--dry-run", action="store_true")
    arguments = parser.parse_args()

    def _print_progress(event):
        print(f"[{event.get('completed')}/{event.get('total')}] {event.get('status') or 'info'}: {event.get('message')}")

    outcome = export_reserving_class_to_resq(
        arguments.project_name,
        arguments.rc_path,
        server_root=arguments.server_root,
        resq_project_name=arguments.resq_project,
        dry_run=arguments.dry_run,
        progress_callback=_print_progress,
    )
    print(json.dumps(outcome, indent=2))
