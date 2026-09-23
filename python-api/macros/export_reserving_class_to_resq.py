# <arcrho-macro>
# Title: Export Reserving Class to ResQ
# Version: 2.14.0
# Release Note: Every message, dialog title and review-table label now reads "Arco" instead of the old product name.
# Description: Push the datasets and methods you tick from the reserving class selected in the active Project Instance page into ResQ: input datasets with their Notes, DFM ratio, tail and Curves-tab selections, Result Selection and B&S Case Reserve Adequacy selections, the Notes of every dataset and method, and a save of every Bornhuetter Ferguson, Cape Cod and B&S Settlement Rate method, in ArcRho's dependency order.
# Scope: Reserving Class
# Icon: upload
# </arcrho-macro>

"""Push one ArcRho reserving class into ResQ.

Two things live in this file, because the Bridge freezes it beside the
canonical migration and loads it as its ResQ writer:

- ``ResQReservingClassExporter`` drives ResQ COM for one reserving class. The
  canonical session (``resq_migration.sync_session``) owns the inventory, the
  dependency order, and the per-item bookkeeping, and calls the writers here
  for both the Sync macro's apply phase and this macro's export phase.
- ``run_macro`` is the client side: it publishes a ``transfer_preview``
  request to the shared Bridge queue through ``arcrho_api.resq_sync_queue``
  and opens the shared review table (``arcrho_api.resq_transfer_review``) --
  the same window the Import macro opens -- then, once rows are ticked and
  accepted, an ``export`` request carrying those names, and shows the results
  in a Project Instance window. It never touches ResQ or the reserving-class
  files itself.
"""

from __future__ import annotations

from collections.abc import Mapping
import csv
from pathlib import Path
import re
import traceback
from typing import Any

TITLE = "Export Reserving Class to ResQ"
PROGRESS_ID = "export-reserving-class-to-resq"

# ResQ enumeration ordinals confirmed against resq_migration.core and the live
# fake-project probe; see python-api/docs/resq_reserving_class_export.md.
RESQ_METHOD_TYPE_DFM = 1
RESQ_METHOD_TYPE_BF = 2
RESQ_METHOD_TYPE_CAPE_COD = 3
RESQ_METHOD_TYPE_RESULT_SELECTION = 4
RESQ_METHOD_TYPE_BS_SR = 8
RESQ_METHOD_TYPE_BS_CRA = 9

# Only used when ResQ will not say how many average formulas a DFM has; the
# import probes the same distance. See ``_average_formula_count``.
MAX_AVERAGE_FORMULA_PROBE = 30

# ResQ Curves tab columns: Initial Selection and the four curves are columns
# 1-5, user value columns start at 6. A user column of DFMCurveColumnType
# cctUserEntry (3) takes values; the linked kinds keep ResQ's own.
RESQ_CURVE_FIXED_COLUMNS = 5
RESQ_CURVE_COLUMN_TYPE_USER_ENTRY = 3

# CustomAverages(i).AverageType ordinals the export writes; resq_migration.dfm
# owns the full list.
RESQ_AVERAGE_TYPE_CUSTOM = 0
RESQ_AVERAGE_TYPE_USER_ENTRY = 5
RESQ_AVERAGE_TYPE_CALCULATED = 6

# A v4 sidecar names its owning method in ``method_type``; the numeric twin is
# gone from the file, so the ResQ code is derived here from that name.
_SIDECAR_METHOD_TYPE_CODES = {
    "": 0,
    "none": 0,
    "dfm": RESQ_METHOD_TYPE_DFM,
    "bornhuetter ferguson": RESQ_METHOD_TYPE_BF,
    "cape cod": RESQ_METHOD_TYPE_CAPE_COD,
    "result selection": RESQ_METHOD_TYPE_RESULT_SELECTION,
}

# Methods ``save_method`` writes Notes for and then saves, without touching
# any other field, by the ResQ code the caller names them with. The export
# session sends only Cape Cod and B&S Settlement Rate here; a BF goes through
# ``export_bfs``, and its entry stays so ``save_method`` can still find one.
_SAVE_ONLY_METHOD_LABELS = {
    RESQ_METHOD_TYPE_BF: "BF",
    RESQ_METHOD_TYPE_CAPE_COD: "CC",
    RESQ_METHOD_TYPE_BS_SR: "B&S Settlement Rate",
}
BS_CRA_LABEL = "B&S Case Reserve Adequacy"


def _sidecar_method_code(sidecar) -> int:
    """ResQ's code for the method that owns a sidecar: 0 for a plain dataset,
    -1 for a method kind ResQ cannot receive through this macro."""
    name = str(sidecar.get("method_type") or "").strip().casefold().replace("_", " ")
    return _SIDECAR_METHOD_TYPE_CODES.get(name, -1)
RESQ_DATA_FORMAT_TRIANGLE = 0
RESQ_DATA_FORMAT_ORIGIN_VECTOR = 1
RESQ_PERC_DEVELOPED_PATTERN = 1
RESQ_PERC_DEVELOPED_CUM_DEV_FACTORS = 2
RESQ_PRIOR_TYPE_ULTIMATES = 0


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


def _strip_formula_index(raw) -> str:
    # ResQ names an average formula "10: User Entry"; the number is its position.
    return _clean_label(re.sub(r"^\s*\d+\s*:\s*", "", str(raw or "")))


def _is_user_entry_label(label) -> bool:
    return _label_key(label).startswith("user entry")


def _safe_number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _safe_length(item, member) -> int:
    """One of ResQ's period-length members as an int, 0 when it cannot be read."""
    try:
        return int(getattr(item, member, 0) or 0)
    except (TypeError, ValueError):
        return 0


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


class ResQReservingClassExporter:
    """Write one ArcRho reserving class's datasets and methods into ResQ."""

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
        self.progress_callback = progress_callback
        # ResQ COM objects, set by connect(); late-bound, so no static type.
        self.app: Any = None
        self.project: Any = None
        self.reserving_class: Any = None
        self._lookup_maps = {}
        self.counts = {
            "datasets_written": 0,
            "dfms_written": 0,
            "bfs_written": 0,
            "ccs_written": 0,
            "result_selections_written": 0,
            "bs_cras_written": 0,
            "methods_saved": 0,
            "errors": 0,
        }
        self.skipped = {}
        self.skip_details = []
        self.error_details = []
        # Items written with more to say than "written" -- the structure
        # changes of a DFM -- which the session puts in the results window.
        self.written_details = []
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
        self.skip_details.append({"kind": kind, "name": str(name), "reason": reason, "message": str(message)})
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

    # The export never creates anything in ResQ. A dataset or method ResQ does
    # not hold is reported with this skip and left alone; a new object reaches
    # ResQ through ResQ itself, never through an ArcRho write.
    @staticmethod
    def _missing_in_resq(label):
        return ExportSkipped("missing_in_resq", f"{label} not found in ResQ; the export never creates one")

    # ----- datasets ---------------------------------------------------------------

    def export_datasets(self, sidecars):
        exportable = []
        for sidecar in sidecars:
            name = _clean_label(sidecar.get("dataset_name"))
            method_code = _sidecar_method_code(sidecar)
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
        is_triangle = data_format.casefold() == "triangle"

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
                "no dataset CSV cache on disk (open the dataset once in Arco to build it)",
            )
        values = _read_csv_matrix(csv_path)
        if not values:
            raise ExportSkipped("empty_csv_cache", "dataset CSV cache is empty")

        target = self._find_dataset(name)
        if target is None:
            raise self._missing_in_resq("dataset")
        if bool(getattr(target, "Calculated", False)):
            raise ExportSkipped("calculated_in_resq", "ResQ dataset is calculated; ResQ recomputes its values")

        notes = self._sync_notes(target, sidecar)
        if is_triangle:
            self._write_triangle_values(target, sidecar, values, name)
        else:
            self._write_vector_values(target, values)
        self.counts["datasets_written"] += 1
        self._emit(f"Exported dataset: {name} (notes {notes})", status="success")

    def _triangle_row_width(self, triangle, origin_index):
        for attr in ("DevelopmentCountByIndex", "DevelopmentCount"):
            try:
                return int(getattr(triangle, attr)(origin_index))
            except Exception:
                continue
        return 0

    def _show_triangle_at(self, triangle, origin_length, development_length):
        """Show *triangle* at these lengths, keeping ResQ's factor rule.

        ResQ refuses a development length that is not a factor of the origin
        length, so a shorter development period is set before the origin comes
        down and a longer one after the origin has gone up.
        """
        current_development = _safe_length(triangle, "DevelopmentLength")
        puts = [("OriginLength", origin_length), ("DevelopmentLength", development_length)]
        if development_length and development_length < current_development:
            puts.reverse()
        for member, length in puts:
            if length and _safe_length(triangle, member) != length:
                setattr(triangle, member, length)

    def _empty_and_reopen(self, triangle, name):
        """Save the emptied *triangle* and read it back from ResQ.

        ResQ has no setter for the stored origin length: it follows the display
        origin length, and only while the triangle holds nothing. Saving the
        emptied triangle and reading it again is the sequence the ResQ window
        itself asks for before those settings can be changed, so the export
        follows it whenever the stored origin period has to move. Reading the
        class again invalidates every cached ResQ object, so the name maps go
        with it; the triangle in hand is kept if ResQ cannot hand back a fresh
        one.
        """
        try:
            triangle.Save()
        except Exception:
            return triangle
        if not name:
            return triangle
        try:
            self.reserving_class.UnloadChildren()
        except Exception:
            return triangle
        self._lookup_maps = {}
        return self._find_triangle(name) or triangle

    def _write_triangle_values(self, triangle, sidecar, values, name=""):
        if bool(getattr(triangle, "Calculated", False)):
            raise ExportSkipped("calculated_in_resq", "ResQ dataset is calculated; ResQ recomputes its values")
        origin_length = int(sidecar.get("origin_length") or 0)
        development_length = int(sidecar.get("development_length") or 0)
        stored_origin_length = int(sidecar.get("stored_origin_length") or 0) or origin_length
        stored_development_length = int(sidecar.get("stored_development_length") or 0) or development_length
        resq_stored_origin = _safe_length(triangle, "StoredOriginLength")
        moving_the_origin_store = bool(
            stored_origin_length and resq_stored_origin and resq_stored_origin != stored_origin_length
        )
        # The ArcRho CSV holds the sidecar's stored shape, and ResQ takes values
        # at the length the triangle is shown at. So empty it (which frees both
        # stored lengths), give it ArcRho's display shape and stored development
        # length, show it at the stored shape to write by index, then put the
        # display shape back before saving. Emptying is enough to free the
        # stored development length; moving the stored origin period goes
        # through the save-and-reopen the ResQ window asks for.
        try:
            triangle.ClearData()
        except Exception:
            pass
        if moving_the_origin_store:
            triangle = self._empty_and_reopen(triangle, name)
        self._show_triangle_at(triangle, origin_length, development_length)
        if stored_development_length and _safe_length(triangle, "StoredDevelopmentLength") != stored_development_length:
            triangle.StoredDevelopmentLength = stored_development_length
        self._show_triangle_at(triangle, stored_origin_length, stored_development_length)
        origin_count = int(triangle.OriginCount)
        for origin_index in range(1, min(origin_count, len(values)) + 1):
            row = values[origin_index - 1]
            width = self._triangle_row_width(triangle, origin_index)
            for development_index in range(1, min(width, len(row)) + 1):
                value = row[development_index - 1]
                if value is None:
                    continue
                triangle.SetValuesByIndex(origin_index, development_index, float(value))
        self._show_triangle_at(triangle, origin_length, development_length)
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
            details = _dict_path(payload, ("details_tab",))
            name = _clean_label(details.get("name")) or entry["name"]
            try:
                self._export_dfm(name, details, payload, entry)
            except ExportSkipped as skip:
                self._record_skip("DFM", name, skip.reason, str(skip))
            except Exception as exc:
                self._record_error("DFM", name, exc)

    def _export_dfm(self, name, details, payload, entry):
        dfm = self._find_in("dfm_methods", self.reserving_class.DFMMethods, name)
        if dfm is None:
            raise self._missing_in_resq("DFM")
        # The structure goes first: a length change resets ResQ's selections,
        # exclusions and Curves values, which the writes below then restore,
        # and a formula this step fixes must not skip the DFM in the probe.
        structure = self._sync_dfm_structure(dfm, details, payload)
        self._probe_dfm_averages(dfm)
        excluded = self._sync_dfm_excluded_ratios(dfm, payload)
        user_values = self._sync_dfm_user_entry_values(dfm, payload)
        tails = self._sync_dfm_tail_factors(dfm, payload)
        selected = self._sync_dfm_selected_ratios(dfm, payload)
        curves = self._sync_dfm_curves(dfm, payload)
        notes = self._sync_notes(dfm, entry)
        dfm.Save()
        self.counts["dfms_written"] += 1
        if structure:
            self.written_details.append({"kind": "DFM", "name": name, "message": ", ".join(structure)})
        self._emit(
            f"Exported DFM: {name} ("
            + (f"{', '.join(structure)}; " if structure else "")
            + f"excluded {excluded}, user values {user_values}, tails {tails}, "
            f"selected {selected}, curves {curves}, notes {notes})",
            status="success",
        )

    # ----- DFM structure ----------------------------------------------------------
    #
    # Exporting an existing DFM makes its ResQ output type, input triangle,
    # lengths and average rows match ArcRho before the value writes run. The
    # row definitions come from ``resq_migration.dfm.arcrho_average_rows_as_resq``,
    # the inverse of the import's own reading, so a row read back through the
    # import is the row ArcRho holds. Only what differs is written.

    def _sync_dfm_structure(self, dfm, details, payload):
        """Write the DFM's output type, input, lengths and rows; say what changed."""

        changes = []
        try:
            changes += self._sync_output_type(dfm, details)
            changes += self._sync_dfm_input_triangle(dfm, details)
            changes += self._sync_dfm_lengths(dfm, details)
            changes += self._sync_dfm_average_rows(dfm, payload)
        except ExportSkipped:
            raise
        except Exception as exc:
            done = f" after {', '.join(changes)}" if changes else ""
            raise RuntimeError(f"ResQ refused a change to the DFM's structure{done}: {exc}") from exc
        return changes

    def _find_dataset_type(self, name):
        return self._find_in("dataset_types", self.project.DatasetTypes, name)

    def _sync_output_type(self, method, details):
        """Give the method's output vector ArcRho's output type, when ResQ has it."""

        wanted = _clean_label(details.get("output_type"))
        if not wanted:
            return []
        output = method.OutputVector
        current = _clean_label(getattr(getattr(output, "DatasetType", None), "Name", ""))
        if _label_key(current) == _label_key(wanted):
            return []
        dataset_type = self._find_dataset_type(wanted)
        if dataset_type is None:
            return [f"output type {wanted} is not in ResQ, kept {current}"]
        output.DatasetType = dataset_type
        return [f"output type {current} -> {wanted}"]

    def _sync_dfm_input_triangle(self, dfm, details):
        wanted = _clean_label(details.get("input_triangle"))
        if not wanted:
            return []
        current = _clean_label(getattr(dfm.InputTriangle, "Name", ""))
        if _label_key(current) == _label_key(wanted):
            return []
        triangle = self._find_triangle(wanted)
        if triangle is None:
            raise ExportSkipped("missing_input", f"input triangle {wanted} not found in ResQ")
        dfm.InputTriangle = triangle
        return [f"input {current} -> {wanted}"]

    def _sync_dfm_lengths(self, dfm, details):
        """Put ArcRho's origin and development lengths, origin first.

        ResQ refuses a development length that does not divide the origin
        length and pulls the development length down with a shorter origin,
        so the origin goes first and the development length follows. Should
        ResQ refuse the origin while the old development length is still set,
        the development length goes first instead.
        """

        try:
            origin = int(details.get("origin_length") or 0)
            development = int(details.get("development_length") or 0)
        except (TypeError, ValueError):
            return []
        before = (_safe_length(dfm, "OriginLength"), _safe_length(dfm, "DevelopmentLength"))
        if not origin or not development or before == (origin, development):
            return []
        try:
            if before[0] != origin:
                dfm.OriginLength = origin
            if _safe_length(dfm, "DevelopmentLength") != development:
                dfm.DevelopmentLength = development
        except Exception:
            dfm.DevelopmentLength = development
            dfm.OriginLength = origin
        return [f"lengths {before[0]}/{before[1]} -> {origin}/{development}"]

    def _read_average_rows(self, dfm):
        """Each ResQ average row's name and fields, in ResQ order."""

        rows = []
        for index in range(1, self._average_formula_count(dfm) + 1):
            average = dfm.CustomAverages(index)
            average_type = int(average.AverageType)
            rows.append(
                {
                    "raw_name": str(dfm.AverageFormula(index) or ""),
                    "average_type": average_type,
                    "weight_type": int(average.WeightType),
                    "periods_included": int(average.PeriodsIncluded),
                    "exclude_flag": bool(average.ExcludeHighLow),
                    "exclude_high_low": int(average.ExcludeHighLow2),
                    "formula": str(average.Formula or "").strip(),
                }
            )
        return rows

    def _average_row_is_current(self, current, reading, wanted):
        """True when a ResQ row already holds what ArcRho asks for.

        Either the import would read the ResQ row back as ArcRho's row -- which
        keeps a ResQ median, pattern or prior-analysis row ArcRho carries as
        copied values -- or ResQ holds exactly the definition the export
        would write.
        """

        arcrho = wanted["arcrho"]
        key = self.migration.average_formula_key
        if (
            _label_key(reading["label"]) == _label_key(arcrho["label"])
            and reading["settings"] == arcrho["settings"]
            and key(reading["formula"]) == key(arcrho["formula"])
        ):
            return True
        if current["average_type"] != wanted["average_type"]:
            return False
        if _label_key(_strip_formula_index(current["raw_name"])) != _label_key(wanted["name"]):
            return False
        if wanted["average_type"] == RESQ_AVERAGE_TYPE_CUSTOM:
            return (
                current["weight_type"] == wanted["weight_type"]
                and current["periods_included"] == wanted["periods_included"]
                and current["exclude_high_low"] == wanted["exclude_high_low"]
                and current["exclude_flag"] == (wanted["exclude_high_low"] > 0)
            )
        if wanted["average_type"] == RESQ_AVERAGE_TYPE_CALCULATED:
            return key(current["formula"]) == key(wanted["formula"])
        return True

    def _write_average_row(self, dfm, index, current, wanted):
        """Write one row's fields, then its name.

        ResQ renames a row from its fields until it is named explicitly, and
        the import reads a custom row's weighting, periods and exclusion from
        that name, so the name always goes last.
        """

        average = dfm.CustomAverages(index)
        average_type = wanted["average_type"]
        if current["average_type"] != average_type:
            average.AverageType = average_type
        if average_type == RESQ_AVERAGE_TYPE_CUSTOM:
            if current["weight_type"] != wanted["weight_type"]:
                average.WeightType = wanted["weight_type"]
            if current["periods_included"] != wanted["periods_included"]:
                average.PeriodsIncluded = wanted["periods_included"]
            exclude = wanted["exclude_high_low"]
            if current["exclude_flag"] != (exclude > 0):
                average.ExcludeHighLow = exclude > 0
            if current["exclude_high_low"] != exclude:
                average.ExcludeHighLow2 = exclude
        elif average_type == RESQ_AVERAGE_TYPE_CALCULATED:
            if self.migration.average_formula_key(current["formula"]) != self.migration.average_formula_key(
                wanted["formula"]
            ):
                average.Formula = wanted["formula"]
        average.Name = wanted["name"]

    def _sync_dfm_average_rows(self, dfm, payload):
        """Give the ResQ DFM ArcRho's average rows: their count, then each row."""

        average_formulas = _dict_path(payload, ("ratios_tab", "average_formulas"))
        wanted_rows = self.migration.arcrho_average_rows_as_resq(average_formulas)
        if not wanted_rows:
            return []
        changes = []
        count = self._average_formula_count(dfm)
        if count != len(wanted_rows):
            dfm.RatioAverageCount = len(wanted_rows)
            changes.append(f"rows {count} -> {len(wanted_rows)}")
        current_rows = self._read_average_rows(dfm)
        readings = self.migration.resq_average_rows_as_arcrho(
            [row["raw_name"] for row in current_rows], current_rows
        )
        redefined = 0
        for index, (current, reading, wanted) in enumerate(zip(current_rows, readings, wanted_rows), start=1):
            if self._average_row_is_current(current, reading, wanted):
                continue
            self._write_average_row(dfm, index, current, wanted)
            redefined += 1
        if redefined:
            changes.append(f"{redefined} row{'s' if redefined != 1 else ''} redefined")
        return changes

    def _resq_notes_text(self, notes):
        # ResQ Notes need \r\n line breaks; a \n-only value renders as one line.
        text = str(notes or "")
        if not text.strip():
            return ""
        return re.sub(r"\r?\n", "\r\n", text)

    def _sync_notes(self, target, entry):
        # ArcRho keeps Notes in the sidecar: a dataset's own, or the output
        # sidecar of a method. A dataset entry is that sidecar and a method
        # entry carries ``notes`` only when its output sidecar was readable, so
        # an absent field leaves the ResQ Notes unchanged and an empty value
        # clears them.
        if "notes" not in entry:
            return 0
        notes = self._resq_notes_text(entry["notes"])
        if str(getattr(target, "Notes", "") or "") == notes:
            return 0
        target.Notes = notes
        return 1

    def _average_formula_count(self, dfm):
        """How many average formulas the DFM really has, 0 when ResQ will not say.

        Asking is the only way to know: ``AverageFormula`` never ends. Past the
        last real row -- 13 in every DFM of the fake project -- ResQ keeps
        answering ``"14: User Entry"``, ``"15: User Entry"`` and so on out of
        unallocated memory, and reading a value for one of those rows crashes
        inside ResQ3Automation.dll.
        """

        try:
            return max(int(dfm.RatioAverageCount), 0)
        except Exception:
            return 0

    @staticmethod
    def _average_type_at(dfm, index):
        """ResQ's AverageType of one average row, ``None`` when it cannot be read."""
        try:
            return int(dfm.CustomAverages(index).AverageType)
        except Exception:
            return None

    def _probe_dfm_averages(self, dfm):
        """Skip a DFM whose ResQ average formulas cannot be evaluated.

        ResQ evaluates every average formula of a DFM when one of its
        selections is written or it is saved. A formula ResQ itself cannot
        evaluate -- ``D 14 - Paid DFM w/ External LDFs`` in the fake project
        fails at its formula 7 on every read and every write -- surfaces as an
        access violation inside ResQ3Automation.dll rather than a clean error,
        so each formula's first column is read here before anything is written.
        Only the DFM's own rows are read: the phantom ones past the end fail
        the same way and would skip every DFM in the reserving class.
        """

        count = self._average_formula_count(dfm)
        for api_index in range(1, (count or MAX_AVERAGE_FORMULA_PROBE) + 1):
            try:
                label = _strip_formula_index(dfm.AverageFormula(api_index))
            except Exception:
                return
            try:
                dfm.AverageRatioValues(1, api_index)
            except Exception as exc:
                # ResQ names a formula "7: Vol + 0.9 - all"; the number is already in the message.
                raise ExportSkipped(
                    "resq_average_unreadable",
                    f"ResQ cannot evaluate average formula {api_index} ({label}); "
                    "fix or remove that formula in ResQ before exporting the DFM",
                ) from exc
            if not count and _is_user_entry_label(label):
                # No count to bound the walk: stop where the labels turn to noise.
                return

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
        pattern = _dict_path(payload, ("ratios_tab", "ratio_triangle")).get("excluded")
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
        """Map each of the DFM's average formula labels to its ResQ row number.

        A ResQ DFM repeats the User Entry row -- three of them sit between
        ``Simple - 2`` and the reserving class's own ``Aug 2024`` in the fake
        project. The labels are the ones the import gives those rows, so the
        repeats read ``User Entry 2``, ``User Entry 3`` and each ArcRho row
        finds its own ResQ row. The walk stops at the DFM's real row count;
        the phantom ``User Entry`` rows ResQ reports past the end would
        otherwise hide every label that follows the first one.
        """

        count = self._average_formula_count(dfm)
        raw_names = []
        for api_index in range(1, (count or MAX_AVERAGE_FORMULA_PROBE) + 1):
            try:
                raw_names.append(str(dfm.AverageFormula(api_index)))
            except Exception:
                break
            if not count and _is_user_entry_label(_strip_formula_index(raw_names[-1])):
                # No count to bound the walk: stop where the labels turn to noise.
                break
        out = {}
        labels = self.migration.resq_average_row_labels(raw_names)
        for api_index, (raw_name, label) in enumerate(zip(raw_names, labels), start=1):
            match = re.match(r"^\s*(\d+)\s*:", raw_name)
            out.setdefault(label, int(match.group(1)) if match else api_index)
        return out

    def _user_entry_payload_row_index(self, average_formulas):
        """The payload row that holds ResQ's own User Entry values.

        A ResQ User Calculation row -- the house "Benchmark" row -- imports as a
        User Entry row as well, so being the first row of that type no longer
        identifies the one ResQ will accept values for. Prefer the row ResQ
        itself calls "User Entry", then a User Entry row that is not driven by a
        formula over the other rows. ResQ keeps recalculating its own User
        Calculation rows, so nothing is ever written back to them.
        """

        labels = average_formulas.get("label")
        if isinstance(labels, list):
            for index, label in enumerate(labels):
                if _is_user_entry_label(label):
                    return index

        settings = average_formulas.get("custom_average_formula_settings")
        average_types = settings.get("average_type") if isinstance(settings, dict) else None
        if not isinstance(average_types, list):
            return None
        inputs = average_formulas.get("inputs")
        if not isinstance(inputs, list):
            inputs = average_formulas.get("formulas")
        user_entry_rows = [
            index
            for index, average_type in enumerate(average_types)
            if str(average_type or "").strip().casefold() == "user_entry"
        ]
        for index in user_entry_rows:
            row_inputs = inputs[index] if isinstance(inputs, list) and index < len(inputs) else None
            if not isinstance(row_inputs, list) or not any('"' in str(cell or "") for cell in row_inputs):
                return index
        return user_entry_rows[0] if user_entry_rows else None

    def _sync_dfm_user_entry_values(self, dfm, payload):
        average_formulas = _dict_path(payload, ("ratios_tab", "average_formulas"))
        values = average_formulas.get("values")
        if not isinstance(values, list):
            return 0
        display_indexes = self._average_formula_display_indexes(dfm)
        user_entry_indexes = {
            label: display_index
            for label, display_index in display_indexes.items()
            if _is_user_entry_label(label)
        }
        # A ResQ User Entry row ArcRho names otherwise -- one the structure
        # step just defined from an ArcRho User Entry row -- takes the values
        # of the ArcRho row of its own label.
        typed_indexes = {
            label: display_index
            for label, display_index in display_indexes.items()
            if label not in user_entry_indexes
            and self._average_type_at(dfm, display_index) == RESQ_AVERAGE_TYPE_USER_ENTRY
        }
        if not user_entry_indexes and not typed_indexes:
            return 0
        # ResQ's own User Entry row takes the row ArcRho holds as such, even
        # when that row was renamed; every further User Entry row of the DFM
        # is matched to its own ArcRho row by the label the import gave it.
        rows = {}
        primary_row = self._user_entry_payload_row_index(average_formulas)
        if primary_row is not None and user_entry_indexes:
            rows[primary_row] = next(iter(user_entry_indexes.values()))
        labels = average_formulas.get("label") if isinstance(average_formulas.get("label"), list) else []
        label_indexes = {**user_entry_indexes, **typed_indexes}
        for row_index, label in enumerate(labels):
            display_index = label_indexes.get(str(label))
            if display_index is not None and row_index not in rows and display_index not in rows.values():
                rows[row_index] = display_index
        # The last column is the "- Ult" tail, which is the row's TailFactor
        # rather than a user ratio; ``_sync_dfm_tail_factors`` writes it.
        column_count = self._dfm_development_column_count(dfm) - 1
        updates = 0
        for row_index, avg_index in rows.items():
            if row_index >= len(values) or not isinstance(values[row_index], list):
                continue
            for development_index, raw_value in enumerate(values[row_index], start=1):
                if development_index > column_count:
                    break
                value = _safe_number(raw_value)
                if value is None or value <= 0:
                    continue
                dfm.SetUserRatios(DevIndex=development_index, AvgIndex=avg_index, arg2=value)
                updates += 1
        return updates

    def _sync_dfm_tail_factors(self, dfm, payload):
        """Write each average row's "- Ult" value as that ResQ row's TailFactor.

        ResQ shows a row's tail factor in the Ratios tab's last column and
        keeps it on the row (``CustomAverages(i).TailFactor``); the selected
        tail then flows into the Curves tab's Initial Selection. ArcRho stores
        the same value as the row's last ``average formulas.values`` entry.
        """

        average_formulas = _dict_path(payload, ("ratios_tab", "average_formulas"))
        labels = average_formulas.get("label")
        values = average_formulas.get("values")
        if not isinstance(labels, list) or not isinstance(values, list):
            return 0
        tail_index = self._dfm_development_column_count(dfm) - 1
        if tail_index < 0:
            return 0
        display_indexes = self._average_formula_display_indexes(dfm)
        updates = 0
        for row_index, label in enumerate(labels):
            row = values[row_index] if row_index < len(values) else None
            if not isinstance(row, list) or tail_index >= len(row):
                continue
            value = _safe_number(row[tail_index])
            if value is None or value <= 0:
                continue
            display_index = display_indexes.get(str(label))
            if display_index is None:
                continue
            average = dfm.CustomAverages(display_index)
            if abs(float(average.TailFactor) - value) <= 1e-9:
                continue
            average.TailFactor = value
            updates += 1
        return updates

    def _sync_dfm_curves(self, dfm, payload):
        """Write the ArcRho Curves tab choices onto the ResQ Curves tab.

        The fit settings, the Include flags, the User Entry columns and the
        Selected Estimate Number per period go across. A ResQ user column that
        is a prior analysis, pattern or benchmark keeps its own values, and the
        fitting method is never written: ArcRho fits by log regression only, so
        a ResQ method fitted by least squares keeps that setting.
        """

        curves = _dict_path(payload, ("curves_tab",))
        if not curves:
            return 0
        period_count = max(self._dfm_development_column_count(dfm) - 1, 0)
        updates = 0
        future = _safe_number(curves.get("future_development_periods"))
        if future is not None and future >= 1 and int(dfm.FutureDevelopmentPeriods) != int(future):
            dfm.FutureDevelopmentPeriods = int(future)
            updates += 1
        if "free_fit_c" in curves and bool(dfm.FreeFitC) != bool(curves["free_fit_c"]):
            dfm.FreeFitC = bool(curves["free_fit_c"])
            updates += 1
        included = curves.get("included") if isinstance(curves.get("included"), list) else []
        for development_index, flag in enumerate(included[:period_count], start=1):
            dfm.SetIncludedRatios(development_index, flag in (1, True, "1"))
            updates += 1
        user_columns = curves.get("user_columns") if isinstance(curves.get("user_columns"), list) else []
        if user_columns and int(dfm.CurveUserValueColCount) < len(user_columns):
            dfm.CurveUserValueColCount = len(user_columns)
            updates += 1
        for offset, column in enumerate(user_columns):
            if not isinstance(column, Mapping):
                continue
            if str(column.get("column_type") or "user_entry") != "user_entry":
                continue
            resq_column = RESQ_CURVE_FIXED_COLUMNS + 1 + offset
            if int(dfm.CurveColumnType(resq_column)) != RESQ_CURVE_COLUMN_TYPE_USER_ENTRY:
                continue
            label = str(column.get("label") or "").strip()
            if label and str(dfm.CurveColumnDescription(resq_column) or "").strip() != label:
                dfm.SetCurveColumnDescription(resq_column, label)
                updates += 1
            column_values = column.get("values") if isinstance(column.get("values"), list) else []
            for development_index, raw_value in enumerate(column_values[:period_count], start=1):
                value = _safe_number(raw_value)
                if value is None or value <= 0:
                    continue
                dfm.SetCurveValues(resq_column, development_index, value)
                updates += 1
            tail = _safe_number(column.get("tail"))
            if tail is not None and tail > 0:
                dfm.SetCurveValues(resq_column, 0, tail)
                updates += 1
        column_limit = RESQ_CURVE_FIXED_COLUMNS + int(dfm.CurveUserValueColCount)
        selected = curves.get("selected_estimates") if isinstance(curves.get("selected_estimates"), list) else []
        for development_index, raw_number in enumerate(selected[:period_count], start=1):
            number = _safe_number(raw_number)
            if number is None or not 1 <= int(number) <= column_limit:
                continue
            dfm.SetSelectedEstimates(development_index, int(number))
            updates += 1
        for key in ("selected_tail_factor", "selected_tail_curve"):
            number = _safe_number(curves.get(key))
            if number is None or not 1 <= int(number) <= column_limit:
                continue
            if key == "selected_tail_factor":
                dfm.SelectedTailFactor = int(number)
            else:
                dfm.SelectedTailCurve = int(number)
            updates += 1
        return updates

    def _sync_dfm_selected_ratios(self, dfm, payload):
        average_formulas = _dict_path(payload, ("ratios_tab", "average_formulas"))
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
                self._export_bf(name, details, payload, entry)
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

    def _export_bf(self, name, details, payload, entry):
        bf = self._find_method_by_output(self.reserving_class.BFMethods(), name)
        if bf is None:
            raise self._missing_in_resq("BF method")

        method_tab = _dict_path(payload, ("method_tab",))
        structure = self._sync_bf_structure(bf, details, method_tab)
        weights = self._sync_bf_prior_weights(bf, method_tab)
        notes = self._sync_notes(bf, entry)
        bf.Save()
        self.counts["bfs_written"] += 1
        if structure:
            self.written_details.append({"kind": "BF", "name": name, "message": ", ".join(structure)})
        self._emit(
            f"Exported BF: {name} ("
            + (f"{', '.join(structure)}; " if structure else "")
            + f"prior weights {weights}, notes {notes})",
            status="success",
        )

    # ----- BF structure -----------------------------------------------------------
    #
    # Exporting an existing BF makes its ResQ output type, origin length,
    # latest, percentage developed and priors match ArcRho, writing only what
    # differs. Every input is looked up before anything is written, so a BF
    # whose input ResQ lacks is skipped untouched.

    def _bf_prior_names(self, method_tab):
        priors = method_tab.get("prior_datasets")
        names = []
        for prior in priors if isinstance(priors, list) else []:
            name = _clean_label(prior.get("name") if isinstance(prior, dict) else "")
            if name:
                names.append(name)
        return names

    def _resolve_bf_inputs(self, method_tab):
        """ResQ's latest, percentage-developed and prior datasets for ArcRho's names."""

        latest = None
        latest_type = None
        latest_name = _clean_label(method_tab.get("latest_dataset"))
        if latest_name:
            latest = self._find_triangle(latest_name)
            latest_type = RESQ_DATA_FORMAT_TRIANGLE
            if latest is None:
                latest = self._find_vector(latest_name)
                latest_type = RESQ_DATA_FORMAT_ORIGIN_VECTOR
            if latest is None:
                raise ExportSkipped("missing_input", f"latest dataset {latest_name} not found in ResQ")
        developed = None
        developed_name = _clean_label(method_tab.get("dfm_dataset"))
        if developed_name:
            developed = self._find_vector(developed_name)
            if developed is None:
                raise ExportSkipped("missing_input", f"percentage-developed dataset {developed_name} not found in ResQ")
        priors = []
        for prior_name in self._bf_prior_names(method_tab):
            prior = self._find_vector(prior_name)
            if prior is None:
                raise ExportSkipped("missing_input", f"prior dataset {prior_name} not found in ResQ")
            priors.append((prior_name, prior))
        return (latest_name, latest, latest_type), (developed_name, developed), priors

    def _sync_bf_structure(self, bf, details, method_tab):
        """Write the BF's output type, origin length, inputs and priors; say what changed."""

        latest, developed, priors = self._resolve_bf_inputs(method_tab)
        changes = []
        try:
            changes += self._sync_output_type(bf, details)
            changes += self._sync_origin_length(bf, details)
            changes += self._sync_bf_latest(bf, *latest)
            changes += self._sync_bf_percentage_developed(bf, method_tab, *developed)
            changes += self._sync_bf_priors(bf, method_tab, priors)
        except Exception as exc:
            done = f" after {', '.join(changes)}" if changes else ""
            raise RuntimeError(f"ResQ refused a change to the BF's inputs{done}: {exc}") from exc
        return changes

    def _sync_origin_length(self, method, details):
        try:
            wanted = int(details.get("origin_length") or 0)
        except (TypeError, ValueError):
            return []
        current = _safe_length(method, "OriginLength")
        if not wanted or current == wanted:
            return []
        method.OriginLength = wanted
        return [f"origin length {current} -> {wanted}"]

    def _sync_bf_latest(self, bf, wanted_name, latest, latest_type):
        if latest is None:
            return []
        current = _clean_label(getattr(getattr(bf, "Latest", None), "Name", ""))
        current_type = _safe_length(bf, "LatestType")
        if _label_key(current) == _label_key(wanted_name) and current_type == latest_type:
            return []
        bf.LatestType = latest_type
        bf.Latest = latest
        return [f"latest {current} -> {wanted_name}"]

    def _sync_bf_percentage_developed(self, bf, method_tab, wanted_name, developed):
        """Point percentage developed at ArcRho's DFM output, under its type.

        ArcRho reads percentage developed from the DFM's cumulative
        development factors, ResQ's type 2. The dataset goes in before the
        type, because putting the dataset moves ResQ's type (step 1, C3).
        """

        if developed is None:
            return []
        wanted_type = method_tab.get("percentage_developed_type_code")
        wanted_type = RESQ_PERC_DEVELOPED_CUM_DEV_FACTORS if wanted_type is None else int(wanted_type)
        changes = []
        current = _clean_label(getattr(getattr(bf, "PercentageDeveloped", None), "Name", ""))
        current_type = _safe_length(bf, "PercentageDevelopedType")
        if _label_key(current) != _label_key(wanted_name):
            bf.PercentageDeveloped = developed
            changes.append(f"percentage developed {current} -> {wanted_name}")
        if _safe_length(bf, "PercentageDevelopedType") != wanted_type:
            bf.PercentageDevelopedType = wanted_type
            if current_type != wanted_type:
                changes.append(f"percentage developed type {current_type} -> {wanted_type}")
        return changes

    def _resq_bf_prior_names(self, bf):
        names = []
        for index in range(1, _safe_length(bf, "PriorVectorCount") + 1):
            names.append(_clean_label(getattr(bf.PriorRatioObj(index).Vector, "Name", "")))
        return names

    def _sync_bf_priors(self, bf, method_tab, priors):
        """Make ResQ's prior list ArcRho's, in ArcRho's order.

        The priors both lists already share at the front stay with their
        weights; every later ResQ prior is removed from the end, then the rest
        of ArcRho's list is added. An ArcRho BF with no prior leaves ResQ's
        priors alone.
        """

        if not priors:
            return []
        current = self._resq_bf_prior_names(bf)
        kept = 0
        while (
            kept < len(current)
            and kept < len(priors)
            and _label_key(current[kept]) == _label_key(priors[kept][0])
        ):
            kept += 1
        if kept == len(current) == len(priors):
            return []
        prior_type = method_tab.get("prior_type_code")
        prior_type = RESQ_PRIOR_TYPE_ULTIMATES if prior_type is None else int(prior_type)
        for index in range(len(current), kept, -1):
            bf.RemovePriorVector(index)
        for _prior_name, prior in priors[kept:]:
            bf.AddPriorVector(prior, prior_type)
        return [f"priors {', '.join(current) or 'none'} -> {', '.join(name for name, _ in priors)}"]

    def _sync_bf_prior_weights(self, bf, method_tab):
        """Write each prior's weight per origin where ResQ's differs from ArcRho's.

        ResQ takes weights only under manual weighting
        (``PriorRatioWeightSelection = 1``), set before the first write. A
        blank ArcRho weight is 1, the BF contract's default.
        """

        priors = method_tab.get("prior_datasets")
        priors = [prior for prior in priors if isinstance(prior, dict) and _clean_label(prior.get("name"))] if isinstance(priors, list) else []
        prior_count = _safe_length(bf, "PriorVectorCount")
        origin_count = _safe_length(bf, "OriginCount")
        updates = 0
        for prior_index, prior in enumerate(priors[:prior_count], start=1):
            weights = prior.get("weights")
            if not isinstance(weights, list):
                continue
            ratio = bf.PriorRatioObj(prior_index)
            for origin_index, raw in enumerate(weights[:origin_count], start=1):
                wanted = _safe_number(raw)
                wanted = 1.0 if wanted is None else wanted
                current = _safe_number(ratio.RatioWeights(origin_index))
                if current is not None and abs(current - wanted) <= 1e-12:
                    continue
                if not updates and _safe_length(bf, "PriorRatioWeightSelection") != 1:
                    bf.PriorRatioWeightSelection = 1
                ratio.SetRatioWeights(origin_index, wanted)
                updates += 1
        return updates

    # ----- Cape Cod ---------------------------------------------------------------

    def export_ccs(self, cc_entries):
        for entry in cc_entries:
            self._completed += 1
            payload = entry["payload"]
            details = _dict_path(payload, ("details_tab",))
            name = _clean_label(details.get("name")) or entry["name"]
            try:
                self._export_cc(name, details, payload, entry)
            except ExportSkipped as skip:
                self._record_skip("CC", name, skip.reason, str(skip))
            except Exception as exc:
                self._record_error("CC", name, exc)

    def _export_cc(self, name, details, payload, entry):
        cc = self._find_method_by_output(self.reserving_class.CapeCodMethods(), name)
        if cc is None:
            raise self._missing_in_resq("Cape Cod method")

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
        notes = self._sync_notes(cc, entry)
        cc.Save()
        self.counts["ccs_written"] += 1
        self._emit(f"Exported CC: {name} (notes {notes})", status="success")

    # ----- save-only methods ------------------------------------------------------

    def _find_method(self, method_code, name):
        """The ResQ method object for a save-only kind, by its ArcRho output name."""

        if method_code == RESQ_METHOD_TYPE_BF:
            return self._find_method_by_output(self.reserving_class.BFMethods(), name)
        if method_code == RESQ_METHOD_TYPE_CAPE_COD:
            return self._find_method_by_output(self.reserving_class.CapeCodMethods(), name)
        if method_code in (RESQ_METHOD_TYPE_BS_SR, RESQ_METHOD_TYPE_BS_CRA):
            found = self.migration._find_berquist_sherman_for_triangle(self.reserving_class, name, method_code)
            return found[1] if found else None
        raise ValueError(f"ResQ method type {method_code} is not a save-only kind")

    def save_method(self, method_code, name, entry=None):
        """Write a ResQ method's Notes and save it, without writing any other field.

        The export pushes a method's inputs first, so the save makes ResQ
        recalculate the method from them and re-stamp it; apart from Notes,
        which every exported kind carries, ArcRho's own settings for the
        method are not carried across.
        """

        label = _SAVE_ONLY_METHOD_LABELS[method_code]
        self._completed += 1
        target = self._find_method(method_code, name)
        if target is None:
            self._record_skip(label, name, "missing_in_resq", "method not found in ResQ")
            return
        try:
            notes = self._sync_notes(target, entry or {})
            target.Save()
        except Exception as exc:
            self._record_error(label, name, exc)
            return
        self.counts["methods_saved"] += 1
        self._emit(f"Saved {label}: {name} (notes {notes})", status="success")

    # ----- Berquist Sherman Case Reserve Adequacy ---------------------------------

    def export_bs_cras(self, bs_cra_entries):
        for entry in bs_cra_entries:
            self._completed += 1
            payload = entry["payload"]
            details = _dict_path(payload, ("details_tab",))
            name = _clean_label(details.get("name")) or entry["name"]
            try:
                self._export_bs_cra(name, payload, entry)
            except ExportSkipped as skip:
                self._record_skip(BS_CRA_LABEL, name, skip.reason, str(skip))
            except Exception as exc:
                self._record_error(BS_CRA_LABEL, name, exc)

    def _export_bs_cra(self, name, payload, entry):
        """Carry the Avg. Selections tab across: both grids' User Value row and
        the estimator selected per development column, then Notes, then Save.

        The method JSON keeps the User Value row as the numbers the page
        evaluated (``user_inflation``, ``user_average_case_reserves``); a cell
        typed as a formula keeps its text in a separate ``*_inputs`` list, so
        ResQ, which has no formula there, receives the plain value.
        """

        method = self._find_method(RESQ_METHOD_TYPE_BS_CRA, name)
        if method is None:
            raise self._missing_in_resq(f"{BS_CRA_LABEL} method")
        method_tab = _dict_path(payload, ("method_tab",))
        inflation = self._sync_bs_cra_grid(
            method,
            "AvgInflation",
            method_tab.get("user_inflation"),
            method_tab.get("inflation_selection"),
            self.migration.BS_CRA_INFLATION_TYPES,
        )
        case_reserves = self._sync_bs_cra_grid(
            method,
            "AvgCaseReserves",
            method_tab.get("user_average_case_reserves"),
            method_tab.get("average_case_reserve_selection"),
            self.migration.BS_CRA_AVERAGE_CASE_RESERVE_TYPES,
        )
        notes = self._sync_notes(method, entry)
        method.Save()
        self.counts["bs_cras_written"] += 1
        self._emit(
            f"Exported {BS_CRA_LABEL}: {name} "
            f"(inflation {inflation}, average case reserves {case_reserves}, notes {notes})",
            status="success",
        )

    def _sync_bs_cra_grid(self, method, grid, user_values, selections, codes):
        """Write one Avg. Selections grid by development column: ``SetUser<grid>``
        takes the User Value row and ``SetSelected<grid>`` the ResQ ordinal of
        the estimator ArcRho names for that column (the import's label map,
        inverted). The value goes first so a ``user`` selection finds it."""

        set_user_value = getattr(method, f"SetUser{grid}")
        set_selected = getattr(method, f"SetSelected{grid}")
        codes_by_label = {label: code for code, label in codes.items()}
        updates = 0
        for development_index, raw_value in enumerate(user_values if isinstance(user_values, list) else [], start=1):
            value = _safe_number(raw_value)
            if value is None:
                continue
            set_user_value(development_index, value)
            updates += 1
        for development_index, label in enumerate(selections if isinstance(selections, list) else [], start=1):
            code = codes_by_label.get(_clean_label(label))
            if code is None:
                continue
            set_selected(development_index, code)
            updates += 1
        return updates

    # ----- Result Selection -------------------------------------------------------

    def export_result_selections(self, rs_entries):
        for entry in rs_entries:
            self._completed += 1
            payload = entry["payload"]
            details = _dict_path(payload, ("details_tab",))
            name = _clean_label(details.get("name")) or entry["name"]
            try:
                self._export_result_selection(name, details, payload, entry)
            except ExportSkipped as skip:
                self._record_skip("Result Selection", name, skip.reason, str(skip))
            except Exception as exc:
                self._record_error("Result Selection", name, exc)

    def _export_result_selection(self, name, details, payload, entry):
        rs = self._find_method_by_output(self.reserving_class.ResultSelections(), name)
        if rs is None:
            raise self._missing_in_resq("Result Selection")
        method_tab = _dict_path(payload, ("method_tab",))
        loaded = method_tab.get("loaded_datasets")
        loaded = loaded if isinstance(loaded, list) else []

        origin_length = int(details.get("origin_length") or 0)
        structure = self._sync_result_selection_structure(rs, name, details, loaded)
        existing = self._result_selection_dataset_indexes(rs)

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
        notes = self._sync_notes(rs, entry)
        rs.Save()
        self.counts["result_selections_written"] += 1
        if structure:
            self.written_details.append({"kind": "Result Selection", "name": name, "message": ", ".join(structure)})
        self._emit(
            f"Exported Result Selection: {name} ("
            + (f"{', '.join(structure)}; " if structure else "")
            + f"weights {weight_updates}, overrides {override_updates}, notes {notes})",
            status="success",
        )

    @staticmethod
    def _result_selection_dataset_indexes(rs):
        """ResQ's own index for each loaded dataset, by name key.

        ResQ orders ``Dataset(i)`` itself, whatever order the datasets were
        added in, so weights are always addressed through this map.
        """

        indexes = {}
        for dataset_index in range(1, int(getattr(rs, "DatasetCount", 0) or 0) + 1):
            try:
                indexes.setdefault(_label_key(rs.Dataset(dataset_index).Name), dataset_index)
            except Exception:
                continue
        return indexes

    def _sync_result_selection_structure(self, rs, name, details, loaded):
        """Write the output type and origin length, then make the loaded datasets ArcRho's.

        Every ResQ dataset ArcRho's list lacks is removed (``RemoveDataset``
        takes the dataset object), then every ArcRho dataset ResQ lacks is
        added, and the method is saved so the indexes the weights use are
        ResQ's new ones. An ArcRho list with no names removes nothing. A
        dataset ResQ does not hold is reported and left out.
        """

        changes = []
        try:
            changes += self._sync_output_type(rs, details)
            changes += self._sync_origin_length(rs, details)
            wanted = {}
            for source in loaded:
                source_name = _clean_label(source.get("name") if isinstance(source, dict) else "")
                if source_name:
                    wanted.setdefault(_label_key(source_name), source_name)
            current = []
            for dataset_index in range(1, int(getattr(rs, "DatasetCount", 0) or 0) + 1):
                dataset = rs.Dataset(dataset_index)
                current.append((_clean_label(getattr(dataset, "Name", "")), dataset))
            removed = [(label, dataset) for label, dataset in current if wanted and _label_key(label) not in wanted]
            for _label, dataset in removed:
                rs.RemoveDataset(dataset)
            held = {_label_key(label) for label, _dataset in current}
            added = []
            for key, source_name in wanted.items():
                if key in held:
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
                added.append(source_name)
            if removed or added:
                rs.Save()
        except Exception as exc:
            done = f" after {', '.join(changes)}" if changes else ""
            raise RuntimeError(f"ResQ refused a change to the Result Selection's datasets{done}: {exc}") from exc
        if removed:
            changes.append("removed " + ", ".join(label for label, _dataset in removed))
        if added:
            changes.append("added " + ", ".join(added))
        return changes


# ----- macro UI flow ------------------------------------------------------------------
#
# Everything below is client-side. The ResQ session and the reserving-class
# files are the Bridge worker's: the macro publishes an ``export`` request to
# the shared queue and renders what the worker reports.

KIND_DATASET = "Dataset"
_OUTCOME_CELLS = {
    "exported": ("Exported", "ok"),
    "saved": ("Saved", "ok"),
    "skipped": ("Skipped", "warn"),
    "failed": ("Failed", "error"),
}


def _message(ui, text, *, title=TITLE, kind="info", auto_close_ms=None, buttons=None, **options):
    return ui.message_box(
        str(text or ""),
        title=title,
        kind=kind,
        auto_close_ms=auto_close_ms,
        buttons=buttons,
        timeout_sec=600,
        **options,
    )


def _context_value(context, *names):
    if not isinstance(context, dict):
        return ""
    for name in names:
        value = str(context.get(name) or "").strip()
        if value:
            return value
    return ""


def _has_export_context(context) -> bool:
    return bool(
        _context_value(context, "projectName", "project_name")
        and _context_value(context, "selectedPath", "selected_path", "path")
    )


def _report_activity() -> None:
    cancel_checker = globals().get("check_macro_cancelled")
    if callable(cancel_checker):
        cancel_checker()
    reporter = globals().get("report_macro_activity")
    if callable(reporter):
        reporter()


def export_baseline_sentence(baseline) -> str:
    """What the export saved for the next review to measure against.

    The saved pair is what makes the next review honest, so its absence is
    told plainly rather than left out: the writes are already durable either
    way, and a review with no pair falls back to comparing timestamps.
    """

    entry = baseline if isinstance(baseline, dict) else {}
    error = str(entry.get("error") or "")
    if error:
        return f"The Arco and ResQ timestamps were not saved, so the next review compares timestamps only. {error}"
    recorded = int(entry.get("recorded") or 0)
    if not recorded:
        return "No Arco and ResQ timestamps were saved, because nothing was written."
    absorbed = int(entry.get("absorbed") or 0)
    sentence = (
        f"Saved the Arco and ResQ timestamps of {recorded} written item(s) "
        "for the next export to compare against."
    )
    if absorbed:
        sentence += f" {absorbed} further item(s) ResQ recalculated from those writes were saved with them."
    return sentence


def export_selection_sentence(selection) -> str:
    """What the export remembered for the next review to open with."""

    entry = selection if isinstance(selection, dict) else {}
    error = str(entry.get("error") or "")
    if error:
        return f"The selection was not saved, so the next export opens with everything ticked. {error}"
    saved = int(entry.get("saved") or 0)
    if not saved:
        return "The whole reserving class was exported, so no selection was saved."
    return f"Saved the {saved} selected item(s) as the default for the next export."


def export_result_table_payload(result) -> dict:
    """Project the Bridge's export results into the read-only review-table contract.

    One row per item in the order it was written -- ArcRho's dependency
    order -- with its outcome and the Bridge's message; the header carries
    the counts.
    """

    items = [item for item in result.get("results") or [] if isinstance(item, dict)]
    rows = []
    counts = {outcome: 0 for outcome in _OUTCOME_CELLS}
    for index, item in enumerate(items, start=1):
        outcome = str(item.get("outcome") or "")
        if outcome not in counts:
            outcome = "failed"
        counts[outcome] += 1
        text, tone = _OUTCOME_CELLS[outcome]
        rows.append({
            "id": f"result-{index}",
            "cells": {
                "kind": str(item.get("kind") or KIND_DATASET),
                "name": str(item.get("name") or ""),
                "outcome": {"text": text, "tone": tone},
                "detail": str(item.get("message") or ""),
            },
        })
    headline = "Export to ResQ completed with errors." if counts["failed"] else "Export to ResQ completed."
    return {
        "title": "ResQ Export Results",
        "host": "projectInstance",
        "selectable": False,
        "summary": (
            f"{headline}\n"
            f"Project: {result.get('project_name')} | Reserving class: {result.get('rc_path')} | "
            f"ResQ: {result.get('connection_name')}\n"
            f"Exported {counts['exported']} dataset/method item(s); saved {counts['saved']} method(s); "
            f"skipped {counts['skipped']}; failed {counts['failed']}.\n"
            f"{export_baseline_sentence(result.get('baseline'))}\n"
            f"{export_selection_sentence(result.get('selection'))}"
        ),
        "columns": [
            {"key": "kind", "label": "Type", "width": 150},
            {"key": "name", "label": "Dataset / Method Output", "width": 250},
            {"key": "outcome", "label": "Outcome", "width": 110},
            {"key": "detail", "label": "Details", "width": 620},
        ],
        "rows": rows,
        "acceptLabel": "Close",
        "searchPlaceholder": "Filter results",
    }


def confirm_without_preview(ui, error) -> bool:
    """Ask whether to export when the timestamp comparison could not be made.

    The comparison is a check, not a gate: a preview the Bridge could not
    produce is reported, and the person decides.
    """

    confirmation = _message(
        ui,
        (
            "The ResQ timestamp comparison failed, so the Arco and ResQ timestamps "
            f"cannot be shown before the export.\n\n{error}\n\n"
            "Exporting overwrites the matching ResQ objects with the Arco copies."
        ),
        kind="warning",
        buttons=["Export Anyway", "Cancel"],
    )
    return str(getattr(confirmation, "button", "") or "").strip().casefold() == "export anyway"


def review_export_plan(ui, root, project_name, rc_path) -> dict:
    """Compare both sides and let the person tick what the export writes.

    Runs the queue's ``transfer_preview`` phase -- the same comparison the
    Import macro reviews, in the same window -- and returns the ticked names.
    Accepting the table is what starts the export; cancelling it publishes
    nothing.
    """

    from arcrho_api.resq_sync_queue import (
        DIRECTION_EXPORT,
        PHASE_TRANSFER_PREVIEW,
        PREVIEW_TIMEOUT_SEC,
        BridgeUnavailableError,
        run_bridge_phase,
    )
    from arcrho_api.resq_transfer_review import review_transfer

    progress = ui.progress_bar(
        progress_id=f"{PROGRESS_ID}-preview",
        title=TITLE,
        label=f"Comparing Arco and ResQ: {rc_path}",
        total=0,
    )
    preview_result: dict[str, Any] = {}
    failure = None
    try:
        preview_result = run_bridge_phase(
            server_root=root,
            project_name=project_name,
            rc_path=rc_path,
            phase=PHASE_TRANSFER_PREVIEW,
            direction=DIRECTION_EXPORT,
            timeout_sec=PREVIEW_TIMEOUT_SEC,
            progress=progress,
            progress_label=f"Comparing Arco and ResQ: {rc_path}",
            on_poll=_report_activity,
        )
    except BridgeUnavailableError:
        # Nothing was published; the caller reports this as a precondition.
        raise
    except Exception as exc:
        failure = exc
    finally:
        progress.close()
    if failure is not None:
        return {
            "status": "failed",
            "error": str(failure),
            "accepted": confirm_without_preview(ui, failure),
            "names": None,
        }
    preview: list[Mapping[str, Any]] = [
        row for row in preview_result.get("preview") or [] if isinstance(row, dict)
    ]
    connection_name = str(preview_result.get("connection_name") or "")
    direction = dict(preview_result.get("class_direction") or {})
    review = review_transfer(
        ui,
        preview,
        direction=DIRECTION_EXPORT,
        title=TITLE,
        accept_label="Export Selected to ResQ",
        project_name=project_name,
        rc_path=rc_path,
        connection_name=connection_name,
        class_direction=direction,
        selection=dict(preview_result.get("selection") or {}),
        on_poll=_report_activity,
    )
    return {
        "status": "reviewed",
        "accepted": review["accepted"],
        "names": review["names"],
        "preview": preview,
        "connection_name": connection_name,
        "direction": direction,
    }


def run_macro(active_dfm=None, active_context=None):
    from arcrho_api import ArcRhoUI, get_server_root
    from arcrho_api.resq_sync_queue import WRITE_TIMEOUT_SEC, BridgeUnavailableError, run_bridge_phase
    from arcrho_api.ui import await_review_table

    ui = ArcRhoUI()
    progress = None
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
            "Activate a Project Instance page and select a reserving-class path "
            f"before exporting to ResQ.\n\n{exc}"
        )
        _message(ui, message, kind="warning")
        return {"status": "cancelled", "cancelled": True, "message": message}

    try:
        active_window = ui.project_instance.active_window(timeout_sec=10)
        if active_window is not None and active_window.get_properties(timeout_sec=10).dirty:
            message = "Save or close unsaved dataset/method changes before exporting this reserving class."
            _message(ui, message, kind="warning", auto_close_ms=9000)
            return {"status": "cancelled", "cancelled": True, "reason": "active_window_dirty", "message": message}

        root = get_server_root(required=True)
        review = review_export_plan(ui, root, project_name, rc_path)
        if not review.get("accepted"):
            return {
                "status": "cancelled",
                "cancelled": True,
                "reason": "review_cancelled",
                "review": review,
                "message": "Export cancelled by user.",
            }
        selected_names = review.get("names")
        if selected_names is not None and not selected_names:
            message = "Nothing was selected, so nothing was exported."
            _message(ui, message, auto_close_ms=6000)
            return {
                "status": "cancelled",
                "cancelled": True,
                "reason": "empty_selection",
                "review": review,
                "message": message,
            }

        progress = ui.progress_bar(
            progress_id=PROGRESS_ID,
            title=TITLE,
            label=f"Exporting to ResQ: {rc_path}",
            total=0,
        )
        result = run_bridge_phase(
            server_root=root,
            project_name=project_name,
            rc_path=rc_path,
            phase="export",
            selected_names=selected_names,
            timeout_sec=WRITE_TIMEOUT_SEC,
            progress=progress,
            progress_label=f"Exporting to ResQ: {rc_path}",
            on_poll=_report_activity,
        )
        progress.close(auto_close_ms=1500)
        progress = None
        payload = export_result_table_payload(result)
        result["message"] = payload["summary"]
        result["preview"] = review.get("preview") or []
        await_review_table(ui, payload, on_poll=_report_activity)
        return result
    except BridgeUnavailableError as exc:
        # Nothing was published, so this is a precondition, not a failure to
        # report as a crash with a traceback the user cannot act on.
        if progress is not None:
            try:
                progress.update(label="ResQ is not reachable", detail=str(exc), tone="error")
            except Exception:
                pass
        _message(ui, str(exc), kind="warning")
        return {"status": "unavailable", "error": str(exc), "message": str(exc)}
    except Exception as exc:
        tb = traceback.format_exc()
        if progress is not None:
            try:
                progress.update(label="Export failed", detail=str(exc), tone="error")
            except Exception:
                pass
        message = f"Export to ResQ failed.\n\nProject: {project_name}\nPath: {rc_path}\n\n{exc}\n\n{tb}"
        _message(ui, message, kind="error")
        return {"status": "error", "error": str(exc), "traceback": tb, "message": message}
    finally:
        if progress is not None:
            try:
                progress.close(auto_close_ms=1500)
            except Exception:
                pass
