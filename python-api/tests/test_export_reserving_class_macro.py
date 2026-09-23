"""Cover the ResQ writer the Export and Sync macros share, and the Export macro's client side.

The Bridge loads ``export_reserving_class_to_resq.py`` from its bundle and
the canonical session drives its per-item writers, so these tests load the
macro file the same way and exercise the writers without a ResQ session. The
client side -- the export request and the results window -- runs against a
stub shell and a stub queue, because the macro itself never touches ResQ.
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, PropertyMock, patch


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
_MACRO_PATH = _PYTHON_API_ROOT / "macros" / "export_reserving_class_to_resq.py"
_SRC_DIR = _PYTHON_API_ROOT / "src"
_MIGRATION_DIR = _PYTHON_API_ROOT / "migration"
for _path in (_SRC_DIR, _MIGRATION_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

import arcrho_api  # noqa: E402
from arcrho_api import resq_sync_queue, ui as ui_module  # noqa: E402
from resq_migration.dfm import (  # noqa: E402
    arcrho_average_rows_as_resq,
    average_formula_key,
    resq_average_row_labels,
    resq_average_rows_as_arcrho,
)


def _load_macro():
    spec = importlib.util.spec_from_file_location("export_reserving_class_macro_under_test", _MACRO_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _migration(**fields):
    values = {
        "CONNECTION_NAME": "ResQ",
        "USER_NAME": "user",
        "PASSWORD": "secret",
        "resq_average_row_labels": resq_average_row_labels,
        "resq_average_rows_as_arcrho": resq_average_rows_as_arcrho,
        "arcrho_average_rows_as_resq": arcrho_average_rows_as_resq,
        "average_formula_key": average_formula_key,
    }
    values.update(fields)
    return types.SimpleNamespace(**values)


class ExportMacroMethodNotesTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro()

    def _exporter(self):
        exporter = self.module.ResQReservingClassExporter(
            _migration(), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )
        exporter.reserving_class = types.SimpleNamespace(DFMMethods=lambda: [])
        exporter._find_in = Mock()
        exporter._sync_dfm_excluded_ratios = Mock(return_value=0)
        exporter._sync_dfm_user_entry_values = Mock(return_value=0)
        exporter._sync_dfm_selected_ratios = Mock(return_value=0)
        return exporter

    def test_export_dfm_writes_notes_with_resq_line_breaks(self):
        exporter = self._exporter()
        dfm = Mock()
        dfm.Notes = "Old note"
        exporter._find_in.return_value = dfm

        exporter._export_dfm("Paid DFM", {}, {}, {"name": "Paid DFM", "payload": {}, "notes": "Excluded 2020.\nSelected 3-year."})

        self.assertEqual(dfm.Notes, "Excluded 2020.\r\nSelected 3-year.")
        dfm.Save.assert_called_once()
        self.assertEqual(exporter.counts["dfms_written"], 1)

    def test_export_dfm_clears_notes_for_a_blank_value_and_keeps_them_without_one(self):
        exporter = self._exporter()
        dfm = Mock()
        dfm.Notes = "ResQ note"
        exporter._find_in.return_value = dfm

        exporter._export_dfm("Paid DFM", {}, {}, {"name": "Paid DFM", "payload": {}, "notes": "  \n"})
        self.assertEqual(dfm.Notes, "")

        dfm.Notes = "ResQ note"
        exporter._export_dfm("Paid DFM", {}, {}, {"name": "Paid DFM", "payload": {}})
        self.assertEqual(dfm.Notes, "ResQ note")

    def test_export_dataset_writes_the_sidecar_notes_before_saving_values(self):
        with tempfile.TemporaryDirectory() as temp:
            server_root = Path(temp)
            cache = server_root / "projects" / "Project" / "data" / "RC" / "cache"
            cache.mkdir(parents=True)
            (cache / "Paid Loss@12.csv").write_text("1\n", encoding="utf-8")
            migration = _migration(DATASET_CACHE_DIR="cache", _encode_rc_folder=lambda _path: "RC")
            exporter = self.module.ResQReservingClassExporter(
                migration, arcrho_project_name="Project", rc_path="Line/Class", server_root=server_root
            )
            target = Mock()
            target.Calculated = False
            target.Notes = ""
            exporter._find_dataset = Mock(return_value=target)
            exporter._write_vector_values = Mock()
            sidecar = {
                "dataset_name": "Paid Loss",
                "data_format": "Vector",
                "csv_file": "Paid Loss@12.csv",
                "notes": "Loaded from claims.\nReviewed.",
            }

            exporter._export_dataset_values(sidecar, "Paid Loss")

        self.assertEqual(target.Notes, "Loaded from claims.\r\nReviewed.")
        exporter._write_vector_values.assert_called_once()
        self.assertEqual(exporter.counts["datasets_written"], 1)

    def test_a_missing_csv_cache_is_recorded_as_a_skip_with_its_message(self):
        migration = _migration(DATASET_CACHE_DIR="cache", _encode_rc_folder=lambda _path: "RC")
        exporter = self.module.ResQReservingClassExporter(
            migration, arcrho_project_name="Project", rc_path="Line/Class", server_root=Path("nowhere")
        )

        exporter.export_datasets([{"dataset_name": "Paid Loss", "method_type": "None", "csv_file": "Paid Loss.csv"}])

        self.assertEqual(exporter.skipped, {"missing_csv_cache": 1})
        self.assertEqual(exporter.skip_details[-1]["name"], "Paid Loss")
        self.assertIn("no dataset CSV cache on disk", exporter.skip_details[-1]["message"])
        self.assertEqual(exporter.counts["datasets_written"], 0)


class _FakeTriangle:
    """A stand-in for a ResQ triangle following the rules the stored-length probe pinned down.

    Shaped like the fake project the probe ran against: annual origins whose
    newest cell is 113 months old, so a monthly display is 113, 101, ... 5
    columns wide over 10 rows and 113, 112, ... over 120 monthly rows.
    """

    NEWEST_AGE = 113
    ORIGIN_MONTHS = 120

    def __init__(self, origin_length=12, development_length=12, stored_development_length=None, holds_data=True):
        self.Calculated = False
        self._origin_length = origin_length
        self._development_length = development_length
        self._stored_origin_length = origin_length
        self._stored_development_length = stored_development_length or development_length
        self._holds_data = holds_data
        self._pending = False
        self.puts = []
        self.stored_development_puts = 0
        self.written = {}
        self.saves = 0
        self.clears = 0

    @property
    def _is_empty(self):
        """A display put moves the store only while nothing has been written at all."""
        return not self._holds_data and not self._pending

    # -- period lengths ---------------------------------------------------------

    @property
    def OriginLength(self):
        return self._origin_length

    @OriginLength.setter
    def OriginLength(self, value):
        value = int(value)
        if value % self._development_length:
            raise RuntimeError("The development length must be a factor of the origin length")
        if self._holds_data and value % self._stored_origin_length:
            raise RuntimeError("The stored origin length must be a factor of the origin length.")
        self._origin_length = value
        if self._is_empty:
            self._stored_origin_length = value
        self.puts.append(("OriginLength", value))

    @property
    def DevelopmentLength(self):
        return self._development_length

    @DevelopmentLength.setter
    def DevelopmentLength(self, value):
        value = int(value)
        if self._origin_length % value:
            raise RuntimeError("The development length must be a factor of the origin length")
        if self._holds_data and value % self._stored_development_length:
            raise RuntimeError("The stored development length must be a factor of the development length.")
        self._development_length = value
        if self._is_empty:
            self._stored_development_length = value
        self.puts.append(("DevelopmentLength", value))

    @property
    def StoredOriginLength(self):
        return self._stored_origin_length

    @property
    def StoredDevelopmentLength(self):
        return self._stored_development_length

    @StoredDevelopmentLength.setter
    def StoredDevelopmentLength(self, value):
        value = int(value)
        if self._holds_data:
            raise RuntimeError("The stored development length may not be set in this triangle.")
        if self._development_length % value:
            raise RuntimeError("The stored development length must be a factor of the development length.")
        self._stored_development_length = value
        self.stored_development_puts += 1
        self.puts.append(("StoredDevelopmentLength", value))

    # -- shape and values -------------------------------------------------------

    @property
    def OriginCount(self):
        return self.ORIGIN_MONTHS // self._origin_length

    def DevelopmentCountByIndex(self, origin_index):
        months = self.NEWEST_AGE - self._origin_length * (origin_index - 1)
        if months <= 0:
            return 0
        return -(-months // self._development_length)

    def SetValuesByIndex(self, origin_index, development_index, value):
        self.written[(self._development_length, origin_index, development_index)] = value
        self._pending = True

    def ClearData(self):
        self.clears += 1
        self.written.clear()
        self._pending = False
        self._holds_data = False

    def reopened(self):
        """A separate object holding the saved state, as ResQ hands one back
        after the reserving class has been read again."""
        fresh = _FakeTriangle(
            origin_length=self._origin_length,
            development_length=self._development_length,
            stored_development_length=self._stored_development_length,
            holds_data=self._holds_data,
        )
        fresh._stored_origin_length = self._stored_origin_length
        return fresh

    def Save(self):
        self.saves += 1
        if self._pending:
            self._holds_data = True


class _FakeTriangleCollection:
    """The subset of a ResQ triangle collection the export's lookups use."""

    def __init__(self, triangles):
        self._triangles = dict(triangles)

    @property
    def Count(self):
        return len(self._triangles)

    def Item(self, key):
        if isinstance(key, int):
            return list(self._triangles.values())[key - 1]
        return self._triangles[key]


class _FakeReservingClass:
    """Enough of a ResQ reserving class for the export's empty-and-reopen step.

    Reading the class again hands back a separate triangle object carrying the
    saved state, exactly as ResQ does, so a test can tell a reopened triangle
    from the one the export started with.
    """

    def __init__(self, triangles):
        self._triangles = dict(triangles)
        self.unloads = 0

    def UnloadChildren(self):
        self.unloads += 1
        self._triangles = {name: triangle.reopened() for name, triangle in self._triangles.items()}

    def Triangles(self):
        return _FakeTriangleCollection(self._triangles)

    def Vectors(self):
        return _FakeTriangleCollection({})

    def triangle(self, name):
        return self._triangles[name]


def _triangle_values(triangle):
    """The CSV matrix a sidecar would hold for *triangle* at its current shape."""
    return [
        [float(1000 * i + j) for j in range(1, triangle.DevelopmentCountByIndex(i) + 1)]
        for i in range(1, triangle.OriginCount + 1)
    ]


class ExportMacroStoredShapeTests(unittest.TestCase):
    """A triangle is written at the shape ArcRho stores it in, then shown at its display shape again."""

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, triangles=None):
        exporter = self.module.ResQReservingClassExporter(
            _migration(), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )
        if triangles is not None:
            exporter.reserving_class = _FakeReservingClass(triangles)
        return exporter

    @staticmethod
    def _sidecar(origin, development, stored_origin, stored_development):
        return {
            "origin_length": origin,
            "development_length": development,
            "stored_origin_length": stored_origin,
            "stored_development_length": stored_development,
        }

    def test_a_finer_development_store_is_written_monthly_and_shown_annually_again(self):
        triangle = _FakeTriangle(origin_length=12, development_length=12)
        stored = _FakeTriangle(origin_length=12, development_length=1)
        values = _triangle_values(stored)

        self._exporter()._write_triangle_values(triangle, self._sidecar(12, 12, 12, 1), values)

        self.assertEqual(triangle.clears, 1)
        self.assertEqual(triangle.saves, 1)
        self.assertEqual(triangle.StoredDevelopmentLength, 1)
        self.assertEqual((triangle.OriginLength, triangle.DevelopmentLength), (12, 12))
        self.assertEqual({key[0] for key in triangle.written}, {1})
        self.assertEqual(len(triangle.written), sum(len(row) for row in values))
        self.assertEqual(triangle.written[(1, 1, 113)], 1113.0)
        self.assertEqual(triangle.puts[-1], ("DevelopmentLength", 12))

    def test_a_monthly_origin_store_is_written_row_by_row_and_shown_annually_again(self):
        triangle = _FakeTriangle(origin_length=1, development_length=1)
        values = _triangle_values(triangle)

        self._exporter()._write_triangle_values(triangle, self._sidecar(12, 12, 1, 1), values)

        self.assertEqual({key[0] for key in triangle.written}, {1})
        self.assertEqual(len(triangle.written), sum(len(row) for row in values))
        self.assertEqual((triangle.OriginLength, triangle.DevelopmentLength), (12, 12))
        self.assertEqual((triangle.StoredOriginLength, triangle.StoredDevelopmentLength), (1, 1))
        self.assertEqual(triangle.saves, 1)

    def test_a_matching_store_writes_at_the_display_shape_and_never_sets_the_stored_length(self):
        triangle = _FakeTriangle(origin_length=12, development_length=12)
        values = _triangle_values(triangle)

        self._exporter()._write_triangle_values(triangle, self._sidecar(12, 12, 12, 12), values)

        self.assertEqual(triangle.stored_development_puts, 0)
        self.assertEqual({key[0] for key in triangle.written}, {12})
        self.assertEqual(len(triangle.written), 55)
        self.assertEqual((triangle.OriginLength, triangle.DevelopmentLength), (12, 12))

    def test_a_coarser_origin_store_is_emptied_saved_and_reopened_before_it_moves(self):
        """ResQ keeps the figures monthly, ArcRho yearly: the store moves instead of the export stopping."""
        triangle = _FakeTriangle(origin_length=1, development_length=1)
        exporter = self._exporter({"Paid Loss": triangle})
        stored = _FakeTriangle(origin_length=12, development_length=1)
        values = _triangle_values(stored)

        exporter._write_triangle_values(triangle, self._sidecar(12, 12, 12, 1), values, "Paid Loss")

        written = exporter.reserving_class.triangle("Paid Loss")
        self.assertEqual(exporter.reserving_class.unloads, 1)
        self.assertIsNot(written, triangle)
        self.assertEqual(triangle.clears, 1)
        self.assertEqual(triangle.saves, 1)  # the empty save that frees the store
        self.assertEqual((written.StoredOriginLength, written.StoredDevelopmentLength), (12, 1))
        self.assertEqual((written.OriginLength, written.DevelopmentLength), (12, 12))
        self.assertEqual({key[0] for key in written.written}, {1})
        self.assertEqual(len(written.written), sum(len(row) for row in values))
        self.assertEqual(written.written[(1, 1, 113)], 1113.0)
        self.assertEqual(written.saves, 1)

    def test_a_finer_origin_store_is_reopened_and_moves_down(self):
        """The other direction: ResQ keeps the figures yearly and ArcRho keeps them monthly."""
        triangle = _FakeTriangle(origin_length=12, development_length=12)
        exporter = self._exporter({"Paid Loss": triangle})
        stored = _FakeTriangle(origin_length=1, development_length=1)
        values = _triangle_values(stored)

        exporter._write_triangle_values(triangle, self._sidecar(12, 12, 1, 1), values, "Paid Loss")

        written = exporter.reserving_class.triangle("Paid Loss")
        self.assertEqual(exporter.reserving_class.unloads, 1)
        self.assertEqual((written.StoredOriginLength, written.StoredDevelopmentLength), (1, 1))
        self.assertEqual((written.OriginLength, written.DevelopmentLength), (12, 12))
        self.assertEqual(len(written.written), sum(len(row) for row in values))
        self.assertEqual(exporter.skipped, {})

    def test_a_matching_origin_store_is_never_reopened(self):
        """Only a stored origin period that has to move pays for reading the class again."""
        triangle = _FakeTriangle(origin_length=12, development_length=12)
        exporter = self._exporter({"Paid Loss": triangle})
        stored = _FakeTriangle(origin_length=12, development_length=1)

        exporter._write_triangle_values(
            triangle, self._sidecar(12, 12, 12, 1), _triangle_values(stored), "Paid Loss"
        )

        self.assertEqual(exporter.reserving_class.unloads, 0)
        self.assertEqual(triangle.saves, 1)
        self.assertEqual((triangle.StoredOriginLength, triangle.StoredDevelopmentLength), (12, 1))


class ExportMacroNeverCreatesTests(unittest.TestCase):
    """An item ResQ does not hold is a warning, never a creation; a DFM ResQ cannot evaluate is skipped before any write."""

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, server_root=Path("."), **migration_fields):
        exporter = self.module.ResQReservingClassExporter(
            _migration(**migration_fields), arcrho_project_name="Project", rc_path="Line/Class", server_root=server_root
        )
        # Nothing here offers Add or AddMethod: a creation attempt would raise.
        exporter.reserving_class = types.SimpleNamespace(
            DFMMethods=lambda: [], BFMethods=lambda: [], CapeCodMethods=lambda: [], ResultSelections=lambda: []
        )
        return exporter

    def test_a_dataset_resq_does_not_hold_is_a_warning(self):
        with tempfile.TemporaryDirectory() as temp:
            server_root = Path(temp)
            cache = server_root / "projects" / "Project" / "data" / "RC" / "cache"
            cache.mkdir(parents=True)
            (cache / "Accounting Cutoff@12.csv").write_text("1\n", encoding="utf-8")
            exporter = self._exporter(server_root, DATASET_CACHE_DIR="cache", _encode_rc_folder=lambda _path: "RC")
            exporter._find_dataset = Mock(return_value=None)

            exporter.export_datasets([{
                "dataset_name": "Accounting Cutoff",
                "method_type": "None",
                "data_format": "Vector",
                "csv_file": "Accounting Cutoff@12.csv",
            }])

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(exporter.counts["errors"], 0)
        self.assertIn("the export never creates one", exporter.skip_details[-1]["message"])

    def test_a_dfm_resq_does_not_hold_is_a_warning(self):
        exporter = self._exporter()
        exporter._find_in = Mock(return_value=None)

        exporter.export_dfms([{"name": "D 99", "payload": {"details_tab": {"name": "D 99", "input_triangle": "Paid"}}}])

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(exporter.skip_details[-1]["kind"], "DFM")
        self.assertEqual(exporter.counts["errors"], 0)

    def test_a_result_selection_resq_does_not_hold_is_a_warning(self):
        exporter = self._exporter()
        exporter._find_method_by_output = Mock(return_value=None)

        exporter.export_result_selections([{"name": "C 91", "payload": {"details_tab": {"name": "C 91"}}}])

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(exporter.counts["errors"], 0)

    def test_a_dfm_whose_average_formula_resq_cannot_evaluate_is_skipped_before_any_write(self):
        exporter = self._exporter()
        dfm = Mock()
        labels = {1: "1: Volume - all", 2: "2: Vol + 0.9 - all", 3: "3: User Entry"}

        def formula(index):
            if index in labels:
                return labels[index]
            raise ValueError(index)

        def values(_column, index):
            if index == 2:
                raise RuntimeError("Access violation at address 0000000076084D70 in module 'ResQ3Automation.dll'")
            return 1.5

        dfm.AverageFormula.side_effect = formula
        dfm.AverageRatioValues.side_effect = values
        exporter._find_in = Mock(return_value=dfm)

        exporter.export_dfms([{
            "name": "D 14",
            "payload": {"details_tab": {"name": "D 14"}, "ratios_tab": {"ratio_triangle": {"excluded": [[1]]}}},
        }])

        self.assertEqual(exporter.skipped, {"resq_average_unreadable": 1})
        self.assertIn("average formula 2 (Vol + 0.9 - all)", exporter.skip_details[-1]["message"])
        self.assertEqual(exporter.counts["errors"], 0)
        self.assertEqual(exporter.counts["dfms_written"], 0)
        dfm.SetExcludedRatios.assert_not_called()
        dfm.Save.assert_not_called()


class ExportMacroAverageFormulaTests(unittest.TestCase):
    """ResQ's average formula list ends where ResQ says it does, not where it stops answering.

    A ResQ DFM carries three identical ``User Entry`` rows, of which ArcRho
    keeps one, and a reserving class of its own can follow them. Past the last
    real row ResQ keeps naming phantom ``User Entry`` rows and crashes when one
    is evaluated, so the row count is the only end of the list.
    """

    # The 13 rows every DFM of the fake project carries, exactly as ResQ names them.
    RESQ_FORMULAS = [
        "1: Volume - all", "2: Simple - 8", "3: Volume - 8", "4: Simple - 8 Ex hi/lo",
        "5: Simple - 5", "6: Simple - 3", "7: Simple - 5 Ex hi/lo", "8: Benchmark",
        "9: Simple - 2", "10: User Entry", "11: User Entry", "12: User Entry", "13: Aug 2024",
    ]

    def setUp(self):
        self.module = _load_macro()

    def _resq_dfm(self, count=len(RESQ_FORMULAS)):
        dfm = Mock()
        dfm.RatioAverageCount = count

        def formula(index):
            if 1 <= index <= len(self.RESQ_FORMULAS):
                return self.RESQ_FORMULAS[index - 1]
            return f"{index}: User Entry"  # phantom: ResQ reads past its own list

        def values(_column, index):
            if index > len(self.RESQ_FORMULAS):
                raise RuntimeError(
                    "Access violation at address 00000000753DF2AB in module 'ResQ3Automation.dll'"
                )
            return 1.5

        dfm.AverageFormula.side_effect = formula
        dfm.AverageRatioValues.side_effect = values
        return dfm

    def _exporter(self):
        return self.module.ResQReservingClassExporter(
            _migration(), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )

    def test_a_phantom_user_entry_row_past_the_count_is_never_evaluated(self):
        self._exporter()._probe_dfm_averages(self._resq_dfm())

    def test_the_repeated_user_entry_rows_are_numbered_the_way_the_import_names_them(self):
        indexes = self._exporter()._average_formula_display_indexes(self._resq_dfm())

        self.assertEqual(indexes["User Entry"], 10)
        self.assertEqual(indexes["User Entry 2"], 11)
        self.assertEqual(indexes["User Entry 3"], 12)
        self.assertEqual(indexes["Aug 2024"], 13)
        self.assertEqual(indexes["Volume - all"], 1)
        self.assertEqual(len(indexes), 13)

    def test_every_user_entry_row_is_written_to_its_own_resq_row(self):
        exporter = self._exporter()
        dfm = self._resq_dfm()
        dfm.OriginCount = 2
        dfm.DevelopmentCount.side_effect = lambda _origin: 3
        payload = {"ratios_tab": {"average_formulas": {
            "label": ["Volume - all", "User Entry", "User Entry 2", "User Entry 3", "Aug 2024"],
            "custom_average_formula_settings": {
                "average_type": ["custom", "user_entry", "user_entry", "user_entry", "custom"],
            },
            "values": [[1.0, 1.0, 1.0], [1.25, 1.1, 1.0], [1.3, 1.2, 1.0], [1.35, 0, 1.0], [1.0, 1.0, 1.0]],
        }}}

        self.assertEqual(exporter._sync_dfm_user_entry_values(dfm, payload), 5)
        dfm.SetUserRatios.assert_any_call(DevIndex=1, AvgIndex=10, arg2=1.25)
        dfm.SetUserRatios.assert_any_call(DevIndex=2, AvgIndex=10, arg2=1.1)
        dfm.SetUserRatios.assert_any_call(DevIndex=1, AvgIndex=11, arg2=1.3)
        dfm.SetUserRatios.assert_any_call(DevIndex=2, AvgIndex=11, arg2=1.2)
        dfm.SetUserRatios.assert_any_call(DevIndex=1, AvgIndex=12, arg2=1.35)

    def test_a_label_after_the_user_entry_rows_can_still_be_selected(self):
        exporter = self._exporter()
        dfm = self._resq_dfm()
        dfm.OriginCount = 2
        dfm.DevelopmentCount.side_effect = lambda _origin: 2
        payload = {"ratios_tab": {"average_formulas": {
            "label": ["Volume - all", "User Entry", "Aug 2024"],
            "selected": [[0, 0], [1, 0], [0, 1]],
        }}}

        self.assertEqual(exporter._sync_dfm_selected_ratios(dfm, payload), 2)
        dfm.SetSelectedRatios.assert_any_call(DevIndex=1, arg1=10)
        dfm.SetSelectedRatios.assert_any_call(DevIndex=2, arg1=13)

    def test_an_imported_user_calculation_row_is_never_written_back_as_user_entry(self):
        """ResQ's Benchmark row imports as a User Entry row, and stays ResQ's.

        Picking the first row of that type would send Benchmark's numbers into
        ResQ's own User Entry row. ResQ keeps recalculating row 8 from its own
        formula, so the export leaves it alone and writes only the row ResQ
        calls User Entry.
        """
        exporter = self._exporter()
        dfm = self._resq_dfm()
        dfm.OriginCount = 2
        dfm.DevelopmentCount.side_effect = lambda _origin: 3
        payload = {"ratios_tab": {"average_formulas": {
            "label": ["Volume - all", "Benchmark", "User Entry"],
            "custom_average_formula_settings": {
                "average_type": ["custom", "user_entry", "user_entry"],
            },
            "inputs": [["", "", ""], ['="Volume - all"*2'] * 2 + [""], ["1.25", "1.1", ""]],
            "values": [[1.0, 1.0, 1.0], [7.7, 7.7, 1.0], [1.25, 1.1, 1.0005]],
        }}}

        self.assertEqual(exporter._sync_dfm_user_entry_values(dfm, payload), 2)
        dfm.SetUserRatios.assert_any_call(DevIndex=1, AvgIndex=10, arg2=1.25)
        dfm.SetUserRatios.assert_any_call(DevIndex=2, AvgIndex=10, arg2=1.1)
        for call in dfm.SetUserRatios.call_args_list:
            self.assertNotIn(7.7, call.kwargs.values())
            # The last column is the "- Ult" tail, written as the row's TailFactor instead.
            self.assertNotIn(1.0005, call.kwargs.values())

    def test_the_tail_column_is_written_as_each_rows_tail_factor(self):
        """The "- Ult" value of a row is ResQ's CustomAverages(i).TailFactor.

        Confirmed live on 2026-09-03: setting a row's TailFactor and selecting
        that row at the tail column makes it the Ratios tab's selected tail,
        which the Curves tab's Initial Selection then carries.
        """
        exporter = self._exporter()
        dfm = self._resq_dfm()
        dfm.OriginCount = 2
        dfm.DevelopmentCount.side_effect = lambda _origin: 3
        averages = {}

        def custom_average(index):
            average = averages.setdefault(index, Mock())
            if not isinstance(average.TailFactor, float):
                average.TailFactor = 1.0
            return average

        dfm.CustomAverages.side_effect = custom_average
        payload = {"ratios_tab": {"average_formulas": {
            "label": ["Volume - all", "User Entry", "Aug 2024"],
            "values": [[1.5, 1.2, 1.0], [1.25, 1.1, 1.0005], [1.4, 1.3, 1.0017]],
        }}}

        self.assertEqual(exporter._sync_dfm_tail_factors(dfm, payload), 2)
        self.assertEqual(averages[10].TailFactor, 1.0005)
        self.assertEqual(averages[13].TailFactor, 1.0017)
        self.assertEqual(averages[1].TailFactor, 1.0)

    def test_the_curves_tab_is_written_onto_the_resq_curves_tab(self):
        exporter = self._exporter()
        dfm = self._resq_dfm()
        dfm.OriginCount = 2
        dfm.DevelopmentCount.side_effect = lambda _origin: 3
        dfm.FutureDevelopmentPeriods = 1
        dfm.FreeFitC = False
        dfm.CurveUserValueColCount = 2
        dfm.CurveColumnType.side_effect = lambda column: {6: 3, 7: 4}[column]
        dfm.CurveColumnDescription.side_effect = lambda column: {6: "User Entry", 7: "Aug 2024"}[column]
        payload = {"curves_tab": {
            "fitting_method": "log_regression",
            "future_development_periods": 3,
            "free_fit_c": True,
            "included": [1, 0],
            "user_columns": [
                {"label": "My Tail", "column_type": "user_entry", "values": [1.3, 1.2], "tail": 1.05},
                {"label": "Aug 2024", "column_type": "prior_analysis", "values": [1.9, 1.1], "tail": 1.0017},
            ],
            "selected_estimates": [1, 3],
            "selected_tail_factor": 6,
            "selected_tail_curve": 3,
        }}

        self.assertGreater(exporter._sync_dfm_curves(dfm, payload), 0)
        self.assertEqual(dfm.FutureDevelopmentPeriods, 3)
        self.assertTrue(dfm.FreeFitC)
        dfm.SetIncludedRatios.assert_any_call(1, True)
        dfm.SetIncludedRatios.assert_any_call(2, False)
        dfm.SetCurveColumnDescription.assert_called_once_with(6, "My Tail")
        dfm.SetCurveValues.assert_any_call(6, 1, 1.3)
        dfm.SetCurveValues.assert_any_call(6, 2, 1.2)
        dfm.SetCurveValues.assert_any_call(6, 0, 1.05)
        # The prior-analysis column keeps ResQ's own values.
        for call in dfm.SetCurveValues.call_args_list:
            self.assertNotEqual(call.args[0], 7)
        dfm.SetSelectedEstimates.assert_any_call(1, 1)
        dfm.SetSelectedEstimates.assert_any_call(2, 3)
        self.assertEqual(dfm.SelectedTailFactor, 6)
        self.assertEqual(dfm.SelectedTailCurve, 3)
        # ArcRho fits by log regression only, so ResQ's fitting method is left alone.
        self.assertIsInstance(dfm.FittingMethod, Mock)

    def test_a_dfm_whose_count_resq_will_not_give_stops_at_the_first_user_entry(self):
        exporter = self._exporter()
        dfm = self._resq_dfm()
        del dfm.RatioAverageCount  # an older ResQ that does not answer

        exporter._probe_dfm_averages(dfm)
        indexes = exporter._average_formula_display_indexes(dfm)

        self.assertEqual(indexes["User Entry"], 10)
        self.assertNotIn("Aug 2024", indexes)


class _FakeAverage:
    """One ResQ ``CustomAverages(i)`` row.

    ResQ renames a row from its fields until it is named explicitly, and an
    explicit name sticks; the probe of 2026-09-23 confirmed both.
    """

    def __init__(self, name, average_type=0, weight_type=1, periods=0, exclude=0, formula=""):
        self.__dict__.update(
            _name=name, _explicit=True, AverageType=average_type, WeightType=weight_type,
            PeriodsIncluded=periods, ExcludeHighLow=exclude > 0, ExcludeHighLow2=exclude,
            Formula=formula, TailFactor=1.0, puts=[],
        )

    def _derived_name(self):
        if self.AverageType == 5:
            return "User Entry"
        if self.AverageType == 6:
            return "Calculated"
        if self.AverageType == 9:
            return "Benchmark Pattern"
        base = "Volume" if self.WeightType == 1 else "Simple"
        periods = "all" if self.PeriodsIncluded == 0 else str(self.PeriodsIncluded)
        exclude = ""
        if self.ExcludeHighLow and self.ExcludeHighLow2:
            exclude = " Ex hi/lo" + (f" x{self.ExcludeHighLow2}" if self.ExcludeHighLow2 > 1 else "")
        return f"{base} - {periods}{exclude}"

    def __setattr__(self, key, value):
        self.__dict__["puts"].append(key)
        if key == "Name":
            self.__dict__.update(_name=value, _explicit=True)
            return
        self.__dict__[key] = value
        if not self._explicit:
            self.__dict__["_name"] = self._derived_name()

    @property
    def Name(self):
        return self._name


class _FakeNamed:
    def __init__(self, name):
        self.Name = name


class _FakeResqDfm:
    """A ResQ DFM with the structure members the export writes."""

    def __init__(self, rows, *, origin_length=12, development_length=12, input_name="Paid Loss", output_type="D 50"):
        self.averages = [_FakeAverage(*row) for row in rows]
        self._origin = origin_length
        self._development = development_length
        self.InputTriangle = _FakeNamed(input_name)
        self.OutputVector = types.SimpleNamespace(Name="D 50 out", DatasetType=_FakeNamed(output_type))
        self.length_puts = []
        self.saved = 0
        self.Notes = ""
        self.locked = False  # a template implementation refuses structural changes

    @property
    def RatioAverageCount(self):
        return len(self.averages)

    @RatioAverageCount.setter
    def RatioAverageCount(self, value):
        if self.locked:
            raise RuntimeError("it is part of the template implementation")
        if value < len(self.averages):
            del self.averages[value:]
        while len(self.averages) < value:
            # ResQ appends its own default rows, then User Entry rows.
            average = _FakeAverage("User Entry", average_type=5)
            average.__dict__["_explicit"] = False
            self.averages.append(average)

    @property
    def OriginLength(self):
        return self._origin

    @OriginLength.setter
    def OriginLength(self, value):
        self.length_puts.append(("OriginLength", value))
        self._origin = value
        if value % self._development:
            self._development = value  # a shorter origin pulls the development length down

    @property
    def DevelopmentLength(self):
        return self._development

    @DevelopmentLength.setter
    def DevelopmentLength(self, value):
        if self._origin % value:
            raise RuntimeError("The development length is incompatible with the origin length")
        self.length_puts.append(("DevelopmentLength", value))
        self._development = value

    def CustomAverages(self, index):
        return self.averages[index - 1]

    def AverageFormula(self, index):
        if index <= len(self.averages):
            return f"{index}: {self.averages[index - 1].Name}"
        return f"{index}: User Entry"

    def AverageRatioValues(self, _column, index):
        if index > len(self.averages):
            raise RuntimeError("Access violation in module 'ResQ3Automation.dll'")
        return 1.5

    OriginCount = 0

    def Save(self):
        self.saved += 1


class ExportMacroDfmStructureTests(unittest.TestCase):
    """Exporting an existing DFM gives ResQ ArcRho's output type, input, lengths and average rows first."""

    RESQ_ROWS = [
        ("Volume - all", 0, 1, 0, 0),
        ("Simple - 5", 0, 0, 5, 0),
        ("Simple - 3", 0, 0, 3, 0),
        ("Benchmark", 9, 0, 0, 0),
        ("User Entry", 5, 0, 0, 0),
        ("Aug 2024", 7, 0, 0, 0),  # a prior-analysis row ArcRho holds as copied values
    ]
    # The rows the import gives ArcRho for RESQ_ROWS.
    ARCRHO_ROWS = [
        ("Volume - all", "custom", "volume", "all", 0),
        ("Simple - 5", "custom", "simple", 5, 0),
        ("Simple - 3", "custom", "simple", 3, 0),
        ("Benchmark", "custom", "benchmark", "all", 0),
        ("User Entry", "user_entry", "simple", "all", 0),
        ("Aug 2024", "user_entry", "simple", "all", 0),
    ]

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, dfm, triangles=(), dataset_types=()):
        exporter = self.module.ResQReservingClassExporter(
            _migration(), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )
        found = {"dfm_methods": dfm}
        exporter._find_in = lambda key, _factory, name: (
            found.get(key)
            if key == "dfm_methods"
            else next((item for item in (triangles if key == "triangles" else dataset_types) if item.Name == name), None)
        )
        exporter.reserving_class = types.SimpleNamespace(DFMMethods=lambda: [], Triangles=lambda: [])
        exporter.project = types.SimpleNamespace(DatasetTypes=lambda: [])
        return exporter

    @staticmethod
    def _payload(rows, *, formulas=None, dev_count=3, **details):
        block = {
            "label": [row[0] for row in rows],
            "custom_average_formula_settings": {
                "average_type": [row[1] for row in rows],
                "base": [row[2] for row in rows],
                "periods": [row[3] for row in rows],
                "exclude": [row[4] for row in rows],
            },
            "inputs": [[""] * dev_count for _ in rows],
        }
        for index, formula in (formulas or {}).items():
            block["inputs"][index] = [formula] * (dev_count - 1) + [""]
        details.setdefault("name", "D 50")
        return {"details_tab": details, "ratios_tab": {"average_formulas": block}}

    def _export(self, exporter, payload):
        exporter.export_dfms([{"name": "D 50", "payload": payload}])
        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)
        self.assertEqual(exporter.skipped, {}, exporter.skip_details)

    def _read_back(self, dfm):
        """The rows as the import would read them from the fake ResQ DFM."""
        raw = [dfm.AverageFormula(i) for i in range(1, dfm.RatioAverageCount + 1)]
        stored = [{"average_type": a.AverageType, "formula": a.Formula} for a in dfm.averages]
        return resq_average_rows_as_arcrho(raw, stored)

    def test_an_unchanged_dfm_has_nothing_structural_written(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS)
        exporter = self._exporter(dfm)

        self._export(exporter, self._payload(self.ARCRHO_ROWS, origin_length=12, development_length=12,
                                             input_triangle="Paid Loss", output_type="D 50"))

        self.assertTrue(all(average.puts == [] for average in dfm.averages))
        self.assertEqual(dfm.length_puts, [])
        self.assertEqual(exporter.written_details, [])
        self.assertEqual(dfm.saved, 1)
        # The prior-analysis row ArcRho carries as copied values keeps its ResQ type.
        self.assertEqual(dfm.averages[5].AverageType, 7)

    def test_too_many_resq_rows_are_dropped_to_the_arcrho_count(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS + [("User Entry", 5, 0, 0, 0), ("Simple - 2", 0, 0, 2, 0)])
        exporter = self._exporter(dfm)

        self._export(exporter, self._payload(self.ARCRHO_ROWS))

        self.assertEqual(dfm.RatioAverageCount, 6)
        self.assertEqual(exporter.written_details[-1]["message"], "rows 8 -> 6")

    def test_too_few_resq_rows_grow_and_the_new_rows_take_the_arcrho_definitions(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS[:3])
        exporter = self._exporter(dfm)
        rows = self.ARCRHO_ROWS[:3] + [
            ("Volume - 4 Ex hi/lo", "custom", "volume", 4, 1),
            ("Simple - 6 Ex hi/lo x2", "custom", "simple", 6, 2),
        ]

        self._export(exporter, self._payload(rows))

        self.assertEqual(dfm.RatioAverageCount, 5)
        read_back = self._read_back(dfm)
        self.assertEqual([row["label"] for row in read_back], [row[0] for row in rows])
        self.assertEqual(read_back[3]["settings"], {"average_type": "custom", "base": "volume", "periods": 4, "exclude": 1})
        self.assertEqual(read_back[4]["settings"], {"average_type": "custom", "base": "simple", "periods": 6, "exclude": 2})
        self.assertEqual(exporter.written_details[-1]["message"], "rows 3 -> 5, 2 rows redefined")
        # The name is always the last put, after the fields ResQ derives a name from.
        self.assertEqual(dfm.averages[3].puts[-1], "Name")

    def test_a_changed_row_type_is_rewritten(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS)
        exporter = self._exporter(dfm)
        rows = list(self.ARCRHO_ROWS)
        rows[1] = ("Volume - 5", "custom", "volume", 5, 0)
        rows[3] = ("Simple - 8", "custom", "simple", 8, 0)

        self._export(exporter, self._payload(rows))

        self.assertEqual((dfm.averages[1].WeightType, dfm.averages[1].PeriodsIncluded, dfm.averages[1].Name), (1, 5, "Volume - 5"))
        self.assertEqual((dfm.averages[3].AverageType, dfm.averages[3].PeriodsIncluded, dfm.averages[3].Name), (0, 8, "Simple - 8"))
        self.assertEqual([row["label"] for row in self._read_back(dfm)], [row[0] for row in rows])
        self.assertEqual(exporter.written_details[-1]["message"], "2 rows redefined")

    def test_a_calculated_formula_naming_other_rows_becomes_a_resq_user_calculation(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS)
        exporter = self._exporter(dfm)
        rows = list(self.ARCRHO_ROWS)
        rows[3] = ("Avg 5 and 3", "user_entry", "simple", "all", 0)
        formula = '=("Simple - 5"+"Simple - 3")/2'

        self._export(exporter, self._payload(rows, formulas={3: formula}))

        average = dfm.averages[3]
        self.assertEqual((average.AverageType, average.Formula, average.Name), (6, "(Average(2)+Average(3))/2", "Avg 5 and 3"))
        read_back = self._read_back(dfm)
        self.assertEqual(read_back[3]["formula"], formula)
        self.assertEqual(read_back[3]["settings"]["average_type"], "user_entry")

        # Exporting again finds the row current and writes nothing more.
        average.puts.clear()
        exporter.written_details.clear()
        self._export(exporter, self._payload(rows, formulas={3: formula}))
        self.assertEqual(average.puts, [])
        self.assertEqual(exporter.written_details, [])

    def test_a_changed_input_triangle_and_output_type_are_written(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS)
        incurred = _FakeNamed("Incurred Loss")
        new_type = _FakeNamed("D 60")
        exporter = self._exporter(dfm, triangles=[incurred], dataset_types=[new_type])

        self._export(exporter, self._payload(self.ARCRHO_ROWS, input_triangle="Incurred Loss", output_type="D 60"))

        self.assertIs(dfm.InputTriangle, incurred)
        self.assertIs(dfm.OutputVector.DatasetType, new_type)
        self.assertEqual(
            exporter.written_details[-1]["message"],
            "output type D 50 -> D 60, input Paid Loss -> Incurred Loss",
        )

    def test_an_input_triangle_resq_lacks_skips_the_dfm_before_any_write(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS)
        exporter = self._exporter(dfm)

        exporter.export_dfms([{"name": "D 50", "payload": self._payload(self.ARCRHO_ROWS, input_triangle="Nowhere")}])

        self.assertEqual(exporter.skipped, {"missing_input": 1})
        self.assertIn("input triangle Nowhere not found in ResQ", exporter.skip_details[-1]["message"])
        self.assertEqual(dfm.saved, 0)

    def test_shorter_lengths_put_the_origin_first(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS, origin_length=12, development_length=12)
        exporter = self._exporter(dfm)

        self._export(exporter, self._payload(self.ARCRHO_ROWS, origin_length=3, development_length=3))

        self.assertEqual((dfm.OriginLength, dfm.DevelopmentLength), (3, 3))
        self.assertEqual(dfm.length_puts, [("OriginLength", 3)])
        self.assertEqual(exporter.written_details[-1]["message"], "lengths 12/12 -> 3/3")

    def test_longer_lengths_put_the_origin_then_the_development_length(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS, origin_length=3, development_length=3)
        exporter = self._exporter(dfm)

        self._export(exporter, self._payload(self.ARCRHO_ROWS, origin_length=12, development_length=12))

        self.assertEqual((dfm.OriginLength, dfm.DevelopmentLength), (12, 12))
        self.assertEqual(dfm.length_puts, [("OriginLength", 12), ("DevelopmentLength", 12)])

    def test_a_refused_structure_change_is_an_error_naming_what_was_done(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS)
        dfm.locked = True
        exporter = self._exporter(dfm)

        exporter.export_dfms([{"name": "D 50", "payload": self._payload(self.ARCRHO_ROWS[:4], origin_length=6, development_length=6)}])

        self.assertEqual(exporter.counts["errors"], 1)
        self.assertEqual(
            exporter.error_details[-1]["message"],
            "ResQ refused a change to the DFM's structure after lengths 12/12 -> 6/6: "
            "it is part of the template implementation",
        )
        self.assertEqual(dfm.saved, 0)

    def test_a_plain_user_entry_row_arcrho_names_otherwise_takes_its_values(self):
        dfm = _FakeResqDfm(self.RESQ_ROWS)
        dfm.OriginCount = 2
        dfm.DevelopmentCount = lambda _origin: 3
        calls = []
        dfm.SetUserRatios = lambda **kwargs: calls.append(kwargs)
        exporter = self._exporter(dfm)
        rows = list(self.ARCRHO_ROWS)
        rows[3] = ("Selected", "user_entry", "simple", "all", 0)
        payload = self._payload(rows)
        payload["ratios_tab"]["average_formulas"]["values"] = [[1.0, 1.0, 1.0]] * 3 + [[1.4, 1.2, 1.0], [1.3, 1.1, 1.0], [1.0, 1.0, 1.0]]

        self.assertEqual(exporter._sync_dfm_structure(dfm, payload["details_tab"], payload), ["1 row redefined"])
        exporter._sync_dfm_user_entry_values(dfm, payload)

        self.assertEqual((dfm.averages[3].AverageType, dfm.averages[3].Name), (5, "Selected"))
        self.assertIn({"DevIndex": 1, "AvgIndex": 4, "arg2": 1.4}, calls)
        self.assertIn({"DevIndex": 2, "AvgIndex": 4, "arg2": 1.2}, calls)
        self.assertIn({"DevIndex": 1, "AvgIndex": 5, "arg2": 1.3}, calls)


class ExportMacroSaveOnlyTests(unittest.TestCase):
    """``save_method`` writes a method's Notes and saves it in ResQ; no other
    field is rewritten. The export sends Cape Cod and B&S Settlement Rate
    methods here; a BF goes through ``export_bfs``."""

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, **migration_fields):
        exporter = self.module.ResQReservingClassExporter(
            _migration(**migration_fields), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )
        exporter.reserving_class = types.SimpleNamespace(BFMethods=lambda: "bfs", CapeCodMethods=lambda: "ccs")
        return exporter

    def test_an_existing_bf_is_saved_without_a_field_other_than_notes_written(self):
        exporter = self._exporter()
        bf = Mock()
        bf.Notes = ""
        exporter._find_method_by_output = Mock(return_value=bf)

        exporter.save_method(self.module.RESQ_METHOD_TYPE_BF, "D 41 - BF Incurred")

        exporter._find_method_by_output.assert_called_once_with("bfs", "D 41 - BF Incurred")
        bf.Save.assert_called_once_with()
        self.assertEqual(bf.Notes, "")
        self.assertEqual(exporter.counts["methods_saved"], 1)
        self.assertEqual(exporter.counts["bfs_written"], 0)

    def test_the_notes_of_a_saved_method_reach_resq_with_windows_line_breaks(self):
        exporter = self._exporter()
        bf = Mock()
        bf.Notes = "Stale."
        exporter._find_method_by_output = Mock(return_value=bf)

        exporter.save_method(
            self.module.RESQ_METHOD_TYPE_BF,
            "D 41 - BF Incurred",
            {"name": "D 41 - BF Incurred", "payload": {}, "notes": "Reviewed.\nSigned off."},
        )

        self.assertEqual(bf.Notes, "Reviewed.\r\nSigned off.")
        bf.Save.assert_called_once_with()
        self.assertEqual(exporter.counts["methods_saved"], 1)

    def test_a_berquist_sherman_settlement_rate_method_carries_its_notes(self):
        bs = Mock()
        bs.Notes = ""
        exporter = self._exporter(_find_berquist_sherman_for_triangle=Mock(return_value=("sr", bs)))

        exporter.save_method(
            self.module.RESQ_METHOD_TYPE_BS_SR,
            "Gross Loss--Paid - B&S Settlement Rate Adjustment",
            {"name": "Gross Loss--Paid - B&S Settlement Rate Adjustment", "payload": {}, "notes": "Adjusted."},
        )

        self.assertEqual(bs.Notes, "Adjusted.")
        bs.Save.assert_called_once_with()
        self.assertEqual(exporter.counts["methods_saved"], 1)

    def test_an_entry_without_notes_leaves_the_resq_notes_alone(self):
        exporter = self._exporter()
        bf = Mock()
        bf.Notes = "Written in ResQ."
        exporter._find_method_by_output = Mock(return_value=bf)

        exporter.save_method(
            self.module.RESQ_METHOD_TYPE_BF, "D 41 - BF Incurred", {"name": "D 41 - BF Incurred", "payload": {}}
        )

        self.assertEqual(bf.Notes, "Written in ResQ.")
        self.assertEqual(exporter.counts["methods_saved"], 1)

    def test_a_notes_write_resq_refuses_is_recorded_as_an_error(self):
        exporter = self._exporter()
        bf = Mock()
        type(bf).Notes = PropertyMock(side_effect=RuntimeError("the method is read only"))
        exporter._find_method_by_output = Mock(return_value=bf)

        exporter.save_method(
            self.module.RESQ_METHOD_TYPE_BF,
            "D 41 - BF Incurred",
            {"name": "D 41 - BF Incurred", "payload": {}, "notes": "Reviewed."},
        )

        self.assertEqual(exporter.counts["errors"], 1)
        self.assertEqual(exporter.error_details[-1]["message"], "the method is read only")
        self.assertEqual(exporter.counts["methods_saved"], 0)
        bf.Save.assert_not_called()

    def test_a_cape_cod_method_is_looked_up_in_its_own_collection(self):
        exporter = self._exporter()
        exporter._find_method_by_output = Mock(return_value=Mock())

        exporter.save_method(self.module.RESQ_METHOD_TYPE_CAPE_COD, "D 53 - Cape Cod")

        exporter._find_method_by_output.assert_called_once_with("ccs", "D 53 - Cape Cod")

    def test_a_berquist_sherman_method_is_found_through_the_migration_by_its_output_triangle(self):
        bs = Mock()
        finder = Mock(return_value=("sr", bs))
        exporter = self._exporter(_find_berquist_sherman_for_triangle=finder)

        exporter.save_method(self.module.RESQ_METHOD_TYPE_BS_SR, "Gross Loss--Paid - B&S Settlement Rate Adjustment")

        finder.assert_called_once_with(
            exporter.reserving_class, "Gross Loss--Paid - B&S Settlement Rate Adjustment", self.module.RESQ_METHOD_TYPE_BS_SR
        )
        bs.Save.assert_called_once_with()
        self.assertEqual(exporter.counts["methods_saved"], 1)

    def test_a_method_resq_does_not_hold_is_a_skip(self):
        exporter = self._exporter(_find_berquist_sherman_for_triangle=Mock(return_value=None))

        exporter.save_method(self.module.RESQ_METHOD_TYPE_BS_SR, "Missing")

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(exporter.skip_details[-1]["kind"], "B&S Settlement Rate")
        self.assertEqual(exporter.counts["methods_saved"], 0)

    def test_a_failed_save_is_recorded_as_an_error(self):
        exporter = self._exporter()
        bf = Mock()
        bf.Save.side_effect = RuntimeError("part of the template implementation")
        exporter._find_method_by_output = Mock(return_value=bf)

        exporter.save_method(self.module.RESQ_METHOD_TYPE_BF, "D 41 - BF Incurred")

        self.assertEqual(exporter.counts["errors"], 1)
        self.assertEqual(exporter.error_details[-1]["message"], "part of the template implementation")
        self.assertEqual(exporter.counts["methods_saved"], 0)


class _FakePriorRatio:
    """One entry of a ResQ BF's prior collection, ``PriorRatioObj(k)``."""

    def __init__(self, vector, prior_type, origins):
        self.Vector = vector
        self.PriorType = prior_type
        self.weights = [1.0] * origins  # ResQ's default weight
        self.weight_puts = []

    def RatioWeights(self, origin_index):
        return self.weights[origin_index - 1]

    def SetRatioWeights(self, origin_index, weight):
        self.weight_puts.append((origin_index, weight))
        self.weights[origin_index - 1] = weight


class _FakeResqBf:
    """A ResQ BF with the members the export writes.

    Putting ``PercentageDeveloped`` moves a type-2 BF to type 3, as the
    probe of 2026-09-23 saw (case C3).
    """

    def __init__(
        self,
        *,
        latest="Paid Loss",
        latest_type=0,
        developed="D 50 out",
        developed_type=2,
        priors=("D 82",),
        origin_length=12,
        output_type="D 41",
        origins=3,
    ):
        self.Latest = _FakeNamed(latest)
        self.LatestType = latest_type
        self._developed = _FakeNamed(developed)
        self._developed_type = developed_type
        self.priors = [_FakePriorRatio(_FakeNamed(name), 0, origins) for name in priors]
        self.OriginLength = origin_length
        self.OriginCount = origins
        self.OutputVector = types.SimpleNamespace(Name="D 41 out", DatasetType=_FakeNamed(output_type))
        self.PriorRatioWeightSelection = 0
        self.Notes = ""
        self.saved = 0
        self.calls = []

    @property
    def PercentageDeveloped(self):
        return self._developed

    @PercentageDeveloped.setter
    def PercentageDeveloped(self, value):
        self.calls.append(("PercentageDeveloped", value.Name))
        self._developed = value
        if self._developed_type == 2:
            self._developed_type = 3

    @property
    def PercentageDevelopedType(self):
        return self._developed_type

    @PercentageDevelopedType.setter
    def PercentageDevelopedType(self, value):
        self.calls.append(("PercentageDevelopedType", value))
        self._developed_type = value

    @property
    def PriorVectorCount(self):
        return len(self.priors)

    def PriorRatioObj(self, index):
        return self.priors[index - 1]

    def AddPriorVector(self, vector, prior_type):
        self.calls.append(("AddPriorVector", vector.Name, prior_type))
        self.priors.append(_FakePriorRatio(vector, prior_type, self.OriginCount))

    def RemovePriorVector(self, index):
        self.calls.append(("RemovePriorVector", index))
        del self.priors[index - 1]

    def Save(self):
        self.saved += 1


class ExportMacroBfTests(unittest.TestCase):
    """Exporting an existing BF gives ResQ ArcRho's output type, origin length, inputs and priors."""

    TRIANGLES = ("Paid Loss", "Reported Loss")
    VECTORS = ("D 50 out", "D 51 out", "D 82", "D 91", "D 92")
    DATASET_TYPES = ("D 41", "D 42")

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, bf):
        exporter = self.module.ResQReservingClassExporter(
            _migration(), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )
        exporter.reserving_class = types.SimpleNamespace(BFMethods=lambda: "bfs")
        exporter._find_method_by_output = Mock(return_value=bf)
        exporter._find_triangle = lambda name: _FakeNamed(name) if name in self.TRIANGLES else None
        exporter._find_vector = lambda name: _FakeNamed(name) if name in self.VECTORS else None
        exporter._find_dataset_type = lambda name: _FakeNamed(name) if name in self.DATASET_TYPES else None
        return exporter

    @staticmethod
    def _payload(*, latest="Paid Loss", developed="D 50 out", priors=(("D 82", None),), **details):
        details.setdefault("name", "D 41 out")
        details.setdefault("output_type", "D 41")
        details.setdefault("origin_length", 12)
        return {
            "details_tab": details,
            "method_tab": {
                "latest_dataset": latest,
                "dfm_dataset": developed,
                "prior_datasets": [
                    {"name": name, "weights": list(weights) if weights is not None else [1.0, 1.0, 1.0]}
                    for name, weights in priors
                ],
            },
        }

    def _export(self, exporter, payload):
        exporter.export_bfs([{"name": "D 41 out", "payload": payload, "notes": ""}])

    def test_an_unchanged_bf_has_nothing_structural_written(self):
        bf = _FakeResqBf()
        exporter = self._exporter(bf)

        self._export(exporter, self._payload())

        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)
        self.assertEqual(bf.calls, [])
        self.assertEqual(bf.PriorRatioWeightSelection, 0)
        self.assertEqual(exporter.written_details, [])
        self.assertEqual((bf.saved, exporter.counts["bfs_written"]), (1, 1))

    def test_a_bf_whose_latest_percentage_developed_and_priors_all_differ_takes_arcrhos(self):
        bf = _FakeResqBf(priors=("D 92",), origin_length=3, output_type="D 42")
        exporter = self._exporter(bf)

        self._export(exporter, self._payload(latest="D 92", developed="D 51 out", priors=(("D 82", None),)))

        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)
        self.assertEqual(bf.OutputVector.DatasetType.Name, "D 41")
        self.assertEqual(bf.OriginLength, 12)
        self.assertEqual((bf.Latest.Name, bf.LatestType), ("D 92", 1))  # a vector latest
        # The dataset goes in before the type, which ResQ's dataset put had moved to 3.
        self.assertEqual((bf.PercentageDeveloped.Name, bf.PercentageDevelopedType), ("D 51 out", 2))
        self.assertLess(bf.calls.index(("PercentageDeveloped", "D 51 out")), bf.calls.index(("PercentageDevelopedType", 2)))
        self.assertEqual([prior.Vector.Name for prior in bf.priors], ["D 82"])
        self.assertIn(("RemovePriorVector", 1), bf.calls)
        self.assertIn(("AddPriorVector", "D 82", 0), bf.calls)
        self.assertEqual(
            exporter.written_details[-1]["message"],
            "output type D 42 -> D 41, origin length 3 -> 12, latest Paid Loss -> D 92, "
            "percentage developed D 50 out -> D 51 out, priors D 92 -> D 82",
        )
        self.assertEqual(bf.saved, 1)

    def test_a_bf_with_two_priors_keeps_the_shared_first_and_writes_both_weights(self):
        bf = _FakeResqBf(priors=("D 82",))
        exporter = self._exporter(bf)

        self._export(exporter, self._payload(priors=(("D 82", [0.25, 0.25, None]), ("D 91", [0.75, 0.75, 0.5]))))

        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)
        self.assertEqual([prior.Vector.Name for prior in bf.priors], ["D 82", "D 91"])
        self.assertNotIn("RemovePriorVector", [call[0] for call in bf.calls])
        self.assertEqual(bf.PriorRatioWeightSelection, 1)
        # A blank ArcRho weight is 1, which ResQ already holds, so it is not written.
        self.assertEqual(bf.priors[0].weight_puts, [(1, 0.25), (2, 0.25)])
        self.assertEqual(bf.priors[1].weights, [0.75, 0.75, 0.5])
        self.assertEqual(exporter.written_details[-1]["message"], "priors D 82 -> D 82, D 91")

    def test_a_resq_type_other_than_arcrhos_is_restored_without_moving_the_dataset(self):
        bf = _FakeResqBf(developed_type=3)
        exporter = self._exporter(bf)

        self._export(exporter, self._payload())

        self.assertEqual(bf.calls, [("PercentageDevelopedType", 2)])
        self.assertEqual(exporter.written_details[-1]["message"], "percentage developed type 3 -> 2")

    def test_a_bf_whose_prior_resq_lacks_is_skipped_before_any_write(self):
        bf = _FakeResqBf(priors=("D 92",), origin_length=3)
        exporter = self._exporter(bf)

        self._export(exporter, self._payload(priors=(("D 99 missing", None),)))

        self.assertEqual(exporter.skipped, {"missing_input": 1})
        self.assertIn("prior dataset D 99 missing not found in ResQ", exporter.skip_details[-1]["message"])
        self.assertEqual((bf.calls, bf.OriginLength, bf.saved), ([], 3, 0))

    def test_a_refused_change_is_an_error_naming_what_was_done(self):
        bf = _FakeResqBf(priors=("D 92",), origin_length=3)

        def refuse(_vector, _prior_type):
            raise RuntimeError("ResQ said no")

        bf.AddPriorVector = refuse
        exporter = self._exporter(bf)

        self._export(exporter, self._payload())

        self.assertEqual(exporter.counts["errors"], 1)
        self.assertEqual(
            exporter.error_details[-1]["message"],
            "ResQ refused a change to the BF's inputs after origin length 3 -> 12: ResQ said no",
        )
        self.assertEqual(bf.saved, 0)


class _FakeResqResultSelection:
    """A ResQ Result Selection. ``AddDataset`` puts the dataset first, never
    where it was asked, because ResQ orders ``Dataset(i)`` itself (case C4)."""

    def __init__(self, datasets, *, origins=3, output_type="D 99", origin_length=12):
        self.datasets = [_FakeNamed(name) for name in datasets]
        self.weights = {name: [0.5] * origins for name in datasets}
        self.OriginCount = origins
        self.OriginLength = origin_length
        self.OutputVector = types.SimpleNamespace(Name="D 99 out", DatasetType=_FakeNamed(output_type))
        self.Notes = ""
        self.calls = []

    @property
    def DatasetCount(self):
        return len(self.datasets)

    def Dataset(self, index):
        return self.datasets[index - 1]

    def AddDataset(self, dataset):
        self.calls.append(("AddDataset", dataset.Name))
        self.datasets.insert(0, dataset)
        self.weights[dataset.Name] = [0.0] * self.OriginCount

    def RemoveDataset(self, dataset):
        if isinstance(dataset, int):
            raise TypeError("RemoveDataset takes the dataset, not an index")
        self.calls.append(("RemoveDataset", dataset.Name))
        self.datasets.remove(dataset)
        del self.weights[dataset.Name]

    def SetWeights(self, dataset_index, origin_index, weight):
        self.weights[self.datasets[dataset_index - 1].Name][origin_index - 1] = weight

    def ClearOverriddenUltimates(self):
        self.calls.append(("ClearOverriddenUltimates",))

    def SetUltimates(self, origin_index, origin_length, value):
        self.calls.append(("SetUltimates", origin_index, origin_length, value))

    def Save(self):
        self.calls.append(("Save",))


class ExportMacroResultSelectionTests(unittest.TestCase):
    """Exporting an existing Result Selection makes its loaded datasets ArcRho's."""

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, rs, held=("A", "B", "C", "X")):
        exporter = self.module.ResQReservingClassExporter(
            _migration(), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )
        exporter.reserving_class = types.SimpleNamespace(ResultSelections=lambda: "rss")
        exporter._find_method_by_output = Mock(return_value=rs)
        exporter._find_dataset = lambda name: _FakeNamed(name) if name in held else None
        exporter._find_dataset_type = lambda name: _FakeNamed(name) if name in ("D 98", "D 99") else None
        return exporter

    @staticmethod
    def _payload(loaded, **details):
        details.setdefault("name", "D 99 out")
        details.setdefault("output_type", "D 99")
        details.setdefault("origin_length", 12)
        return {
            "details_tab": details,
            "method_tab": {"loaded_datasets": [{"name": name, "weights": weights} for name, weights in loaded]},
        }

    def test_an_extra_dataset_is_removed_and_a_missing_one_added_before_the_weights(self):
        rs = _FakeResqResultSelection(["A", "B", "X"], output_type="D 98")
        exporter = self._exporter(rs)

        exporter.export_result_selections([{
            "name": "D 99 out",
            "payload": self._payload([("A", [0.2, 0.2, 0.2]), ("B", [0.3, 0.3, 0.3]), ("C", [0.5, 0.5, 0.5])]),
        }])

        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)
        self.assertEqual(exporter.skipped, {})
        self.assertEqual(rs.OutputVector.DatasetType.Name, "D 99")
        self.assertEqual([dataset.Name for dataset in rs.datasets], ["C", "A", "B"])
        # The save that follows the remove and the add comes before any weight.
        self.assertEqual(rs.calls[:3], [("RemoveDataset", "X"), ("AddDataset", "C"), ("Save",)])
        # Weights follow each dataset to ResQ's own index for it.
        self.assertEqual(rs.weights, {"A": [0.2] * 3, "B": [0.3] * 3, "C": [0.5] * 3})
        self.assertEqual(exporter.written_details[-1]["message"], "output type D 98 -> D 99, removed X, added C")
        self.assertEqual(exporter.counts["result_selections_written"], 1)

    def test_matching_datasets_are_neither_removed_nor_added_nor_saved_twice(self):
        rs = _FakeResqResultSelection(["A", "B"])
        exporter = self._exporter(rs)

        exporter.export_result_selections([{"name": "D 99 out", "payload": self._payload([("A", [1, 1, 1]), ("B", [0, 0, 0])])}])

        self.assertEqual([call for call in rs.calls if call[0] in ("RemoveDataset", "AddDataset")], [])
        self.assertEqual(rs.calls.count(("Save",)), 1)
        self.assertEqual(exporter.written_details, [])

    def test_an_arcrho_list_with_no_names_removes_nothing(self):
        rs = _FakeResqResultSelection(["A", "B"])
        exporter = self._exporter(rs)

        exporter.export_result_selections([{"name": "D 99 out", "payload": self._payload([])}])

        self.assertEqual([dataset.Name for dataset in rs.datasets], ["A", "B"])
        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)


class ExportMacroBsCraTests(unittest.TestCase):
    """A B&S Case Reserve Adequacy method carries its Avg. Selections tab into ResQ."""

    INFLATION_TYPES = {0: "case_column", 1: "case_all", 2: "paid_column", 3: "paid_all", 4: "user"}
    AVERAGE_TYPES = {0: "latest", 1: "monotone", 2: "loess", 3: "user"}

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, method):
        exporter = self.module.ResQReservingClassExporter(
            _migration(
                BS_CRA_INFLATION_TYPES=self.INFLATION_TYPES,
                BS_CRA_AVERAGE_CASE_RESERVE_TYPES=self.AVERAGE_TYPES,
                _find_berquist_sherman_for_triangle=Mock(return_value=("cra", method) if method else None),
            ),
            arcrho_project_name="Project",
            rc_path="Line/Class",
            server_root=Path("."),
        )
        exporter.reserving_class = types.SimpleNamespace()
        return exporter

    def _entry(self, **method_tab):
        return {
            "name": "Gross Loss--Paid - B&S Case Reserve Adequacy Adjustment",
            "payload": {
                "details_tab": {"name": "Gross Loss--Paid - B&S Case Reserve Adequacy Adjustment"},
                "method_tab": method_tab,
            },
            "notes": "Inflation from the Excel link.",
        }

    def test_both_grids_write_the_user_value_row_then_the_selected_estimator_per_column(self):
        method = Mock()
        method.Notes = ""
        exporter = self._exporter(method)
        entry = self._entry(
            inflation_selection=["user", "paid_all", "case_column"],
            # A formula cell is stored as the number it evaluated to; the text
            # lives in user_inflation_inputs and never reaches ResQ.
            user_inflation=[0.0525, 0.0, 0.0],
            user_inflation_inputs=["=ROUND(0.05 + 0.0025, 4)", "", ""],
            average_case_reserve_selection=["latest", "user", "loess"],
            user_average_case_reserves=[0.0, 1250.5, 0.0],
        )

        exporter.export_bs_cras([entry])

        self.assertEqual(
            method.SetUserAvgInflation.call_args_list,
            [((1, 0.0525),), ((2, 0.0),), ((3, 0.0),)],
        )
        self.assertEqual(
            method.SetSelectedAvgInflation.call_args_list,
            [((1, 4),), ((2, 3),), ((3, 0),)],
        )
        self.assertEqual(
            method.SetUserAvgCaseReserves.call_args_list,
            [((1, 0.0),), ((2, 1250.5),), ((3, 0.0),)],
        )
        self.assertEqual(
            method.SetSelectedAvgCaseReserves.call_args_list,
            [((1, 0),), ((2, 3),), ((3, 2),)],
        )
        # Values precede selections, so a "user" selection finds its number.
        calls = [call[0] for call in method.mock_calls]
        self.assertLess(calls.index("SetUserAvgInflation"), calls.index("SetSelectedAvgInflation"))
        self.assertEqual(method.Notes, "Inflation from the Excel link.")
        self.assertEqual(calls[-1], "Save")
        self.assertEqual(exporter.counts["bs_cras_written"], 1)
        self.assertEqual(exporter.counts["methods_saved"], 0)

    def test_the_method_is_found_through_the_migration_by_its_arcrho_name(self):
        method = Mock()
        exporter = self._exporter(method)

        exporter.export_bs_cras([self._entry(inflation_selection=["paid_all"], user_inflation=[0.0])])

        exporter.migration._find_berquist_sherman_for_triangle.assert_called_once_with(
            exporter.reserving_class,
            "Gross Loss--Paid - B&S Case Reserve Adequacy Adjustment",
            self.module.RESQ_METHOD_TYPE_BS_CRA,
        )

    def test_a_method_resq_does_not_hold_is_a_skip(self):
        exporter = self._exporter(None)

        exporter.export_bs_cras([self._entry(inflation_selection=["paid_all"])])

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(exporter.skip_details[-1]["kind"], "B&S Case Reserve Adequacy")
        self.assertEqual(exporter.counts["bs_cras_written"], 0)

    def test_a_failed_write_is_recorded_as_an_error_and_nothing_is_saved(self):
        method = Mock()
        method.SetSelectedAvgInflation.side_effect = RuntimeError("Invalid index")
        exporter = self._exporter(method)

        exporter.export_bs_cras([self._entry(inflation_selection=["paid_all"], user_inflation=[0.0])])

        self.assertEqual(exporter.counts["errors"], 1)
        self.assertEqual(exporter.error_details[-1]["message"], "Invalid index")
        method.Save.assert_not_called()
        self.assertEqual(exporter.counts["bs_cras_written"], 0)


class ExportMacroResultsTableTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro()

    def test_results_become_a_read_only_table_in_write_order_with_counts(self):
        payload = self.module.export_result_table_payload({
            "status": "completed_with_errors",
            "project_name": "Demo",
            "rc_path": r"Auto\PP",
            "connection_name": "ResQ Demo",
            "results": [
                {"id": "paid loss", "name": "Paid Loss", "kind": "Dataset", "outcome": "exported", "message": "Written to ResQ."},
                {"id": "paid ldf", "name": "Paid LDF", "kind": "DFM", "outcome": "exported", "message": "Written to ResQ."},
                {"id": "bf ult", "name": "BF Ult", "kind": "Bornhuetter Ferguson", "outcome": "saved", "message": "Written to ResQ."},
                {"id": "orphan", "name": "Orphan", "kind": "Dataset", "outcome": "skipped", "message": "The Arco dataset CSV cache is missing."},
                {"id": "sel", "name": "Selected Ult", "kind": "Result Selection", "outcome": "failed", "message": "COM error"},
            ],
        })

        self.assertEqual(payload["title"], "ResQ Export Results")
        self.assertEqual(payload["host"], "projectInstance")
        self.assertFalse(payload["selectable"])
        self.assertEqual(payload["acceptLabel"], "Close")
        self.assertIn("Export to ResQ completed with errors.", payload["summary"])
        self.assertIn("Project: Demo | Reserving class: Auto\\PP | ResQ: ResQ Demo", payload["summary"])
        self.assertIn("Exported 2 dataset/method item(s); saved 1 method(s); skipped 1; failed 1.", payload["summary"])
        self.assertEqual([row["id"] for row in payload["rows"]], [f"result-{index}" for index in range(1, 6)])
        cells = [row["cells"] for row in payload["rows"]]
        self.assertEqual([cell["name"] for cell in cells], ["Paid Loss", "Paid LDF", "BF Ult", "Orphan", "Selected Ult"])
        self.assertEqual(
            [cell["outcome"] for cell in cells],
            [
                {"text": "Exported", "tone": "ok"},
                {"text": "Exported", "tone": "ok"},
                {"text": "Saved", "tone": "ok"},
                {"text": "Skipped", "tone": "warn"},
                {"text": "Failed", "tone": "error"},
            ],
        )
        self.assertEqual(cells[3]["detail"], "The Arco dataset CSV cache is missing.")

    def test_the_results_say_what_was_saved_for_the_next_review_to_compare_against(self):
        def summary(baseline):
            return self.module.export_result_table_payload({
                "status": "completed",
                "baseline": baseline,
                "results": [{"id": "a", "name": "A", "kind": "Dataset", "outcome": "exported", "message": ""}],
            })["summary"]

        self.assertIn(
            "Saved the Arco and ResQ timestamps of 3 written item(s)",
            summary({"recorded": 3, "absorbed": 0, "error": ""}),
        )
        self.assertIn(
            "2 further item(s) ResQ recalculated from those writes were saved with them.",
            summary({"recorded": 3, "absorbed": 2, "error": ""}),
        )
        self.assertIn(
            "The Arco and ResQ timestamps were not saved",
            summary({"recorded": 0, "absorbed": 0, "error": "The share went away."}),
        )
        self.assertIn("because nothing was written", summary({}))

    def test_a_clean_export_reports_completion_without_errors(self):
        payload = self.module.export_result_table_payload({
            "status": "completed",
            "results": [{"id": "a", "name": "A", "kind": "Dataset", "outcome": "exported", "message": "Written to ResQ."}],
        })

        self.assertTrue(payload["summary"].startswith("Export to ResQ completed.\n"))
        self.assertIn("Exported 1 dataset/method item(s); saved 0 method(s); skipped 0; failed 0.", payload["summary"])

    def test_the_header_counts_the_methods_the_export_created(self):
        payload = self.module.export_result_table_payload({
            "status": "completed",
            "results": [
                {"id": "a", "name": "A", "kind": "Dataset", "outcome": "exported", "message": "Written to ResQ."},
                {"id": "d", "name": "D 99", "kind": "DFM", "outcome": "exported", "message": "Created in ResQ.", "created": True},
            ],
        })

        self.assertIn("Exported 2 dataset/method item(s), 1 of them created in ResQ; saved 0 method(s)", payload["summary"])
        self.assertEqual(payload["rows"][1]["cells"]["outcome"], {"text": "Exported", "tone": "ok"})
        self.assertEqual(payload["rows"][1]["cells"]["detail"], "Created in ResQ.")


class _FakeCollection:
    """A 1-based ResQ collection: ``Count`` and ``Item(i)``."""

    def __init__(self, items):
        self.items = list(items)

    @property
    def Count(self):
        return len(self.items)

    def Item(self, index):
        return self.items[index - 1]


class _FakeDatasetType:
    def __init__(self, name="", category="", unique=True):
        self.Name = name
        self.Category = _FakeNamed(category) if category else None
        self.Unique = unique
        self.Aggregated = True  # what DatasetTypes().Add() starts with
        self.DataFormat = 0
        self.DecimalPlaces = -1
        self.saved = 0
        self.deleted = False

    def Save(self):
        self.saved += 1

    def Delete(self):
        self.deleted = True


class _FakeInputTriangle:
    def __init__(self, name, category="D Gross Loss"):
        self.Name = name
        self.DatasetType = _FakeDatasetType(name, category)


class ExportMacroCreateTests(unittest.TestCase):
    """A DFM, BF or Result Selection ResQ lacks is created, then written the way an existing one is."""

    DFM_ROWS = ExportMacroDfmStructureTests.ARCRHO_ROWS

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, *, methods=(), triangles=(), vectors=(), dataset_types=(), categories=("D Gross Loss",),
                  arcrho_types=(), class_vectors=()):
        """An exporter over a fake class whose ``AddMethod`` hands out ``methods`` in turn."""

        exporter = self.module.ResQReservingClassExporter(
            _migration(_dataset_type_rows=lambda: [dict(row) for row in arcrho_types]),
            arcrho_project_name="Project",
            rc_path="Line/Class",
            server_root=Path("."),
        )
        exporter.create_missing_methods = True
        self.added_methods = []
        self.added_types = []
        pending = list(methods)
        known_types = {item.Name: item for item in dataset_types}
        known = {
            "triangles": {item.Name: item for item in triangles},
            "vectors": {item.Name: item for item in vectors},
            "categories": {name: _FakeNamed(name) for name in categories},
            "dataset_types": known_types,
        }

        def add_method(code):
            method = pending.pop(0)
            self.added_methods.append((code, method))
            return method

        def add_type():
            dataset_type = _FakeDatasetType()
            self.added_types.append(dataset_type)
            return dataset_type

        def find_in(key, _factory, name):
            if key in ("dfm_methods",):
                return None
            if key == "dataset_types":
                return next((item for item in list(known_types.values()) + self.added_types if item.Name == name), None)
            return known.get(key, {}).get(name)

        exporter._find_in = find_in
        exporter._find_method_by_output = lambda _collection, _name: None
        exporter.reserving_class = types.SimpleNamespace(
            AddMethod=add_method,
            DFMMethods=lambda: [],
            BFMethods=lambda: [],
            ResultSelections=lambda: [],
            Triangles=lambda: [],
            Vectors=lambda: _FakeCollection(class_vectors),
        )
        exporter.project = types.SimpleNamespace(
            DatasetTypes=lambda: types.SimpleNamespace(Add=add_type),
            Categories=lambda: [],
        )
        return exporter

    @staticmethod
    def _new_dfm():
        dfm = _FakeResqDfm([(f"Volume - {n}", 0, 1, n, 0) for n in range(1, 6)], input_name="", output_type="")
        dfm.Name = ""
        dfm.Delete = Mock()
        return dfm

    def _dfm_entry(self, **details):
        details.setdefault("input_triangle", "Paid Loss")
        details.setdefault("output_type", "D 50")
        payload = ExportMacroDfmStructureTests._payload(self.DFM_ROWS, origin_length=12, development_length=12, **details)
        return {"name": "D 50", "payload": payload}

    def test_a_missing_dfm_is_created_with_its_input_and_then_takes_arcrhos_rows(self):
        dfm = self._new_dfm()
        paid = _FakeInputTriangle("Paid Loss")
        exporter = self._exporter(methods=[dfm], triangles=[paid], dataset_types=[_FakeDatasetType("D 50", "D Gross Loss")])

        exporter.export_dfms([self._dfm_entry()])

        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)
        self.assertEqual(exporter.skipped, {}, exporter.skip_details)
        self.assertEqual([code for code, _method in self.added_methods], [self.module.RESQ_METHOD_TYPE_DFM])
        self.assertEqual((dfm.Name, dfm.OutputVector.Name, dfm.OutputVector.DatasetType.Name), ("D 50", "D 50", "D 50"))
        self.assertIs(dfm.InputTriangle, paid)
        # One save creates it; the second writes the rest the way an existing DFM is written.
        self.assertEqual(dfm.saved, 2)
        self.assertEqual([average.Name for average in dfm.averages], [row[0] for row in self.DFM_ROWS])
        self.assertEqual((exporter.counts["methods_created"], exporter.counts["dfms_written"]), (1, 1))
        self.assertEqual(exporter.written_details, [{"kind": "DFM", "name": "D 50", "created": True, "message": ""}])
        self.assertEqual(self.added_types, [])

    def test_the_output_is_named_after_the_arcrho_output_dataset_when_it_differs(self):
        dfm = self._new_dfm()
        exporter = self._exporter(methods=[dfm], triangles=[_FakeInputTriangle("Paid Loss")],
                                  dataset_types=[_FakeDatasetType("D 50", "D Gross Loss")])

        exporter.export_dfms([self._dfm_entry(output_dataset="D 50 - Paid CDF")])

        self.assertEqual((dfm.Name, dfm.OutputVector.Name), ("D 50", "D 50 - Paid CDF"))

    def test_a_dfm_whose_input_resq_lacks_is_skipped_before_anything_is_created(self):
        exporter = self._exporter(methods=[self._new_dfm()], dataset_types=[_FakeDatasetType("D 50", "D Gross Loss")])

        exporter.export_dfms([self._dfm_entry(input_triangle="Nowhere")])

        self.assertEqual(exporter.skipped, {"missing_input": 1})
        self.assertIn("input triangle Nowhere not found in ResQ", exporter.skip_details[-1]["message"])
        self.assertEqual((self.added_methods, exporter.counts["methods_created"]), ([], 0))

    def test_a_missing_output_type_is_created_from_the_arcrho_definition(self):
        dfm = self._new_dfm()
        exporter = self._exporter(
            methods=[dfm],
            triangles=[_FakeInputTriangle("Paid Loss")],
            arcrho_types=[{"name": "D 50", "data_format": "Vector", "category": "D Gross Loss"}],
        )

        exporter.export_dfms([self._dfm_entry(decimal_places=2)])

        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)
        [dataset_type] = self.added_types
        self.assertEqual(
            (dataset_type.Name, dataset_type.Category.Name, dataset_type.DataFormat, dataset_type.DecimalPlaces,
             dataset_type.Unique, dataset_type.Aggregated, dataset_type.saved),
            ("D 50", "D Gross Loss", self.module.RESQ_DATA_FORMAT_ORIGIN_VECTOR, 2, True, False, 1),
        )
        self.assertIs(dfm.OutputVector.DatasetType, dataset_type)
        self.assertEqual(exporter.written_details[-1]["message"], "new output type D 50")

    def test_an_output_type_whose_category_resq_lacks_skips_the_method(self):
        exporter = self._exporter(
            methods=[self._new_dfm()],
            triangles=[_FakeInputTriangle("Paid Loss")],
            arcrho_types=[{"name": "D 50", "data_format": "Vector", "category": "Z Nowhere"}],
        )

        exporter.export_dfms([self._dfm_entry()])

        self.assertEqual(exporter.skipped, {"missing_category": 1})
        self.assertIn("needs the category Z Nowhere", exporter.skip_details[-1]["message"])
        self.assertEqual((self.added_methods, self.added_types), ([], []))

    def test_an_output_type_neither_side_defines_skips_the_method(self):
        exporter = self._exporter(methods=[self._new_dfm()], triangles=[_FakeInputTriangle("Paid Loss")])

        exporter.export_dfms([self._dfm_entry()])

        self.assertEqual(exporter.skipped, {"missing_output_type": 1})
        self.assertEqual(self.added_methods, [])

    def test_an_output_type_another_vector_holds_skips_the_method(self):
        holder = types.SimpleNamespace(Name="D 50 - Old CDF", DatasetType=_FakeNamed("D 50"))
        exporter = self._exporter(
            methods=[self._new_dfm()],
            triangles=[_FakeInputTriangle("Paid Loss")],
            dataset_types=[_FakeDatasetType("D 50", "D Gross Loss")],
            class_vectors=[holder],
        )

        exporter.export_dfms([self._dfm_entry()])

        self.assertEqual(exporter.skipped, {"output_type_in_use": 1})
        self.assertIn("already used by D 50 - Old CDF", exporter.skip_details[-1]["message"])
        self.assertEqual(self.added_methods, [])

    def test_a_refused_creation_names_the_categories_and_leaves_nothing_behind(self):
        dfm = self._new_dfm()

        def refuse():
            raise RuntimeError('There cannot be more than one "C 52 - CWOP DFM" Vector in a Reserving Class')

        dfm.Save = refuse
        exporter = self._exporter(
            methods=[dfm],
            triangles=[_FakeInputTriangle("Claim Counts", category="C Claim Count")],
            arcrho_types=[{"name": "D 50", "data_format": "Vector", "category": "D Gross Loss"}],
        )

        exporter.export_dfms([self._dfm_entry(input_triangle="Claim Counts")])

        self.assertEqual(exporter.counts["errors"], 1)
        self.assertEqual(
            exporter.error_details[-1]["message"],
            "ResQ refused to create the DFM: its output type is in category D Gross Loss, "
            "but its input Claim Counts is in C Claim Count",
        )
        dfm.Delete.assert_called_once_with()
        self.assertTrue(self.added_types[0].deleted)
        self.assertEqual(exporter.counts["methods_created"], 0)

    def test_a_missing_bf_is_created_with_its_inputs_and_priors(self):
        bf = _FakeResqBf(latest="", developed="", developed_type=0, priors=(), output_type="")
        bf.Name = ""
        exporter = self._exporter(methods=[bf], dataset_types=[_FakeDatasetType("D 41", "D Gross Loss")])
        exporter._find_triangle = lambda name: _FakeInputTriangle(name) if name == "Paid Loss" else None
        exporter._find_vector = lambda name: _FakeNamed(name) if name in ("D 50 out", "D 82", "D 91") else None
        payload = ExportMacroBfTests._payload(priors=(("D 82", [0.25, 0.25, 0.25]), ("D 91", [0.75, 0.75, 0.75])))

        exporter.export_bfs([{"name": "D 41 out", "payload": payload, "notes": "New."}])

        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)
        self.assertEqual(self.added_methods[0][0], self.module.RESQ_METHOD_TYPE_BF)
        self.assertEqual((bf.Name, bf.OutputVector.Name, bf.OutputVector.DatasetType.Name), ("D 41 out", "D 41 out", "D 41"))
        self.assertEqual((bf.Latest.Name, bf.LatestType), ("Paid Loss", 0))
        self.assertEqual((bf.PercentageDeveloped.Name, bf.PercentageDevelopedType), ("D 50 out", 2))
        self.assertEqual([prior.Vector.Name for prior in bf.priors], ["D 82", "D 91"])
        self.assertEqual([prior.weights for prior in bf.priors], [[0.25] * 3, [0.75] * 3])
        # The inputs go in before the first save, the way the probe created one.
        self.assertEqual(bf.saved, 2)
        self.assertEqual(bf.Notes, "New.")
        self.assertEqual(exporter.counts["methods_created"], 1)
        self.assertTrue(exporter.written_details[-1]["created"])

    def test_a_bf_whose_prior_resq_lacks_is_skipped_before_anything_is_created(self):
        exporter = self._exporter(methods=[], dataset_types=[_FakeDatasetType("D 41", "D Gross Loss")])
        exporter._find_triangle = lambda name: _FakeInputTriangle(name) if name == "Paid Loss" else None
        exporter._find_vector = lambda name: _FakeNamed(name) if name == "D 50 out" else None

        exporter.export_bfs([{"name": "D 41 out", "payload": ExportMacroBfTests._payload()}])

        self.assertEqual(exporter.skipped, {"missing_input": 1})
        self.assertIn("prior dataset D 82 not found in ResQ", exporter.skip_details[-1]["message"])
        self.assertEqual(self.added_methods, [])

    def test_a_missing_result_selection_is_created_loading_every_arcrho_dataset(self):
        rs = _FakeResqResultSelection([], output_type="")
        rs.Name = ""
        exporter = self._exporter(methods=[rs], dataset_types=[_FakeDatasetType("D 99", "D Gross Loss")])
        exporter._find_dataset = lambda name: _FakeNamed(name) if name in ("A", "B") else None
        payload = ExportMacroResultSelectionTests._payload([("A", [0.4, 0.4, 0.4]), ("B", [0.6, 0.6, 0.6])])

        exporter.export_result_selections([{"name": "D 99 out", "payload": payload}])

        self.assertEqual(exporter.counts["errors"], 0, exporter.error_details)
        self.assertEqual(self.added_methods[0][0], self.module.RESQ_METHOD_TYPE_RESULT_SELECTION)
        self.assertEqual((rs.Name, rs.OutputVector.Name, rs.OutputVector.DatasetType.Name), ("D 99 out", "D 99 out", "D 99"))
        self.assertEqual(sorted(dataset.Name for dataset in rs.datasets), ["A", "B"])
        self.assertEqual(rs.weights, {"A": [0.4] * 3, "B": [0.6] * 3})
        self.assertEqual(exporter.counts["methods_created"], 1)

    def test_a_result_selection_loading_a_dataset_resq_lacks_is_not_created(self):
        exporter = self._exporter(methods=[], dataset_types=[_FakeDatasetType("D 99", "D Gross Loss")])
        exporter._find_dataset = lambda name: _FakeNamed(name) if name == "A" else None
        payload = ExportMacroResultSelectionTests._payload([("A", [1, 1, 1]), ("Gone", [0, 0, 0])])

        exporter.export_result_selections([{"name": "D 99 out", "payload": payload}])

        self.assertEqual(exporter.skipped, {"missing_input": 1})
        self.assertIn("loaded dataset Gone not found in ResQ", exporter.skip_details[-1]["message"])
        self.assertEqual(self.added_methods, [])

    def test_the_sync_apply_path_still_creates_nothing(self):
        exporter = self._exporter(methods=[self._new_dfm()], triangles=[_FakeInputTriangle("Paid Loss")],
                                  dataset_types=[_FakeDatasetType("D 50", "D Gross Loss")])
        exporter.create_missing_methods = False

        exporter.export_dfms([self._dfm_entry()])

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(self.added_methods, [])

    def test_a_failure_after_the_creation_says_the_method_is_in_resq(self):
        dfm = self._new_dfm()
        dfm.locked = False
        exporter = self._exporter(methods=[dfm], triangles=[_FakeInputTriangle("Paid Loss")],
                                  dataset_types=[_FakeDatasetType("D 50", "D Gross Loss")])
        exporter._sync_dfm_selected_ratios = Mock(side_effect=RuntimeError("Invalid index"))

        exporter.export_dfms([self._dfm_entry()])

        self.assertEqual(exporter.error_details[-1]["message"], "created in ResQ, then Invalid index")
        self.assertEqual(exporter.counts["methods_created"], 1)


class _Button:
    def __init__(self, button):
        self.button = button


def _preview_row(name, *, kind="Dataset", transfer_supported=True, selected=True, **fields):
    """One row as the Bridge's transfer preview reports it."""

    row = {
        "id": name.casefold(),
        "key": name.casefold(),
        "name": name,
        "kind": kind,
        "presence": "both",
        "arcrho_timestamp": "2026-08-28 10:00:00",
        "resq_timestamp": "2026-08-28 11:00:00",
        "newer_side": "resq",
        "transfer_supported": transfer_supported,
        "selected": selected,
    }
    row.update(fields)
    return row


class _ShellUI:
    """A shell that hosts the preview table, the results window, and any message box."""

    def __init__(self, button="Export Anyway", dirty=False):
        self.button = button
        self.messages = []
        self.progress = Mock()
        window = Mock()
        window.get_properties.return_value = types.SimpleNamespace(dirty=dirty)
        self.project_instance = types.SimpleNamespace(
            context=lambda timeout_sec: {"projectName": "Demo", "selectedPath": r"Auto\PP"},
            active_window=lambda timeout_sec: window,
        )

    def message_box(self, text, **kwargs):
        self.messages.append((text, kwargs))
        return _Button(self.button)

    def progress_bar(self, **kwargs):
        return self.progress


class ExportMacroRunTests(unittest.TestCase):
    """The client reviews the comparison, publishes one export request, and shows what the Bridge reports."""

    def setUp(self):
        self.module = _load_macro()

    def _run(
        self,
        ui,
        *,
        phase_result=None,
        phase_error=None,
        preview_rows=None,
        preview_error=None,
        accepted=True,
        ticked_ids=None,
    ):
        def run_phase(**kwargs):
            if kwargs["phase"] == resq_sync_queue.PHASE_TRANSFER_PREVIEW:
                if preview_error:
                    raise preview_error
                return {
                    "preview": list(preview_rows or []),
                    "connection_name": "ResQ Demo",
                    "direction": "export",
                    "class_direction": {
                        "arcrho_timestamp": "2026-08-28 10:00:00",
                        "resq_timestamp": "2026-08-28 11:00:00",
                    },
                    "selection": {"names": [], "updated_at": "", "updated_by": ""},
                }
            if phase_error:
                raise phase_error
            return dict(phase_result or {})

        def review_table(_ui, payload, **_kwargs):
            if payload.get("title") == self.module.TITLE:
                ticked = [row["id"] for row in payload["rows"] if row["selected"]]
                return {
                    "status": "completed",
                    "accepted": accepted,
                    "selectedRowIds": ticked if ticked_ids is None else list(ticked_ids),
                }
            return {"status": "completed", "accepted": True}

        run_phase = Mock(side_effect=run_phase)
        review = Mock(side_effect=review_table)
        with (
            patch.object(arcrho_api, "ArcRhoUI", lambda: ui),
            patch.object(arcrho_api, "get_server_root", lambda required: Path("server")),
            patch.object(resq_sync_queue, "run_bridge_phase", run_phase),
            patch.object(ui_module, "await_review_table", review),
        ):
            result = self.module.run_macro()
        return result, run_phase, review

    def test_an_accepted_preview_publishes_the_export_phase_and_shows_the_results_window(self):
        ui = _ShellUI()
        rows = [_preview_row("Paid Loss")]
        bridge_result = {
            "status": "completed",
            "project_name": "Demo",
            "rc_path": r"Auto\PP",
            "connection_name": "ResQ Demo",
            "results": [{"id": "a", "name": "A", "kind": "Dataset", "outcome": "exported", "message": "Written to ResQ."}],
        }

        result, run_phase, review = self._run(ui, preview_rows=rows, phase_result=bridge_result)

        # The comparison is reviewed first, and only then is the export published.
        self.assertEqual(
            [call.kwargs["phase"] for call in run_phase.call_args_list],
            ["transfer_preview", "export"],
        )
        self.assertEqual(run_phase.call_args_list[0].kwargs["direction"], "export")
        self.assertEqual(run_phase.call_args_list[0].kwargs["timeout_sec"], resq_sync_queue.PREVIEW_TIMEOUT_SEC)
        kwargs = run_phase.call_args.kwargs
        self.assertEqual((kwargs["project_name"], kwargs["rc_path"], kwargs["phase"]), ("Demo", r"Auto\PP", "export"))
        self.assertEqual(kwargs["timeout_sec"], resq_sync_queue.WRITE_TIMEOUT_SEC)
        self.assertEqual(kwargs["selected_names"], ["Paid Loss"])
        self.assertIs(kwargs["on_poll"], self.module._report_activity)
        preview_payload = review.call_args_list[0].args[1]
        self.assertEqual(preview_payload["title"], self.module.TITLE)
        self.assertEqual(preview_payload["rows"][0]["cells"]["name"], "Paid Loss")
        self.assertEqual(preview_payload["rows"][0]["cells"]["newer"]["text"], "ResQ")
        payload = review.call_args.args[1]
        self.assertEqual(payload["title"], "ResQ Export Results")
        self.assertEqual(payload["rows"][0]["cells"]["name"], "A")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["message"], payload["summary"])
        self.assertEqual(result["preview"], rows)
        # The preview table is the only confirmation; no message box is shown.
        self.assertEqual(ui.messages, [])

    def test_a_cancelled_preview_publishes_no_export(self):
        ui = _ShellUI()

        result, run_phase, review = self._run(ui, preview_rows=[_preview_row("Paid Loss")], accepted=False)

        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["transfer_preview"])
        self.assertEqual(review.call_count, 1)
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["reason"], "review_cancelled")

    def test_a_review_that_ticked_nothing_publishes_no_export(self):
        ui = _ShellUI()

        result, run_phase, _review = self._run(
            ui, preview_rows=[_preview_row("Paid Loss")], ticked_ids=[]
        )

        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["transfer_preview"])
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["reason"], "empty_selection")

    def test_only_the_ticked_rows_reach_the_export_request(self):
        ui = _ShellUI()
        rows = [_preview_row("Paid Loss"), _preview_row("Reported Loss", selected=False)]

        _result, run_phase, _review = self._run(
            ui,
            preview_rows=rows,
            phase_result={"status": "completed", "results": []},
        )

        self.assertEqual(run_phase.call_args.kwargs["selected_names"], ["Paid Loss"])

    def test_a_failed_comparison_asks_before_exporting_rather_than_blocking(self):
        ui = _ShellUI()

        result, run_phase, review = self._run(
            ui,
            preview_error=resq_sync_queue.BridgeRequestError("preview failed"),
            phase_result={"status": "completed", "results": []},
        )

        text, kwargs = ui.messages[0]
        self.assertIn("preview failed", text)
        self.assertEqual(kwargs["buttons"], ["Export Anyway", "Cancel"])
        self.assertEqual(kwargs["kind"], "warning")
        self.assertEqual(
            [call.kwargs["phase"] for call in run_phase.call_args_list],
            ["transfer_preview", "export"],
        )
        # Without a review there is nothing ticked, so the whole class is pushed.
        self.assertIsNone(run_phase.call_args.kwargs["selected_names"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(review.call_count, 1)

    def test_cancelling_a_failed_comparison_publishes_no_export(self):
        ui = _ShellUI(button="Cancel")

        result, run_phase, review = self._run(
            ui, preview_error=resq_sync_queue.BridgeRequestError("preview failed")
        )

        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["transfer_preview"])
        review.assert_not_called()
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["review"]["status"], "failed")

    def test_an_unsaved_window_stops_the_export_before_the_comparison(self):
        ui = _ShellUI(dirty=True)

        result, run_phase, _review = self._run(ui)

        run_phase.assert_not_called()
        self.assertEqual(result["reason"], "active_window_dirty")
        self.assertEqual(len(ui.messages), 1)

    def test_a_missing_bridge_is_a_warning_rather_than_a_crash(self):
        ui = _ShellUI()

        result, _run_phase, review = self._run(
            ui, preview_error=resq_sync_queue.BridgeUnavailableError("No active Arco Bridge worker")
        )

        # An unreachable Bridge is a precondition, not a comparison the person can skip.
        review.assert_not_called()
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(ui.messages[-1][1]["kind"], "warning")
        self.assertNotIn("buttons", {key: value for key, value in ui.messages[-1][1].items() if value})
        self.assertIn("No active Arco Bridge worker", ui.messages[-1][0])

    def test_a_bridge_that_disappears_after_the_review_is_reported_the_same_way(self):
        ui = _ShellUI()

        result, run_phase, _review = self._run(
            ui,
            preview_rows=[_preview_row("Paid Loss")],
            phase_error=resq_sync_queue.BridgeUnavailableError("No active Arco Bridge worker"),
        )

        self.assertEqual(
            [call.kwargs["phase"] for call in run_phase.call_args_list],
            ["transfer_preview", "export"],
        )
        self.assertEqual(result["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
