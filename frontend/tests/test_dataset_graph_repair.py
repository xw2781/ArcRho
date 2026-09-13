"""The one-off repair of an existing project's generated-formula links.

Every regeneration now recomputes a dataset's two link lists, so an import
repairs whatever it rebuilds. The projects that already exist were written
before that, and a dataset nothing rebuilds keeps the lists it was first
written with, so they are repaired once by
``calculated_dataset_service.repair_reserving_class_graph_fields`` --
the dataset-type change job's "graphs" stage over every Engine instance of a
class instead of the ones a plan named.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRONTEND_ROOT.parent
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import calculated_dataset_service, dataset_sidecar_status_service


PROJECT = "Demo"
METHOD = "D 13 - Paid DFM"
FORMULA_OUTPUT = "Total Earned Premium"
INPUTS = ("Earned Premium", "Remaining Budget Premium")

# The fake project's confirmed example: two source columns the Engine fills
# from the master table, and one formula over them the Engine evaluates.
ROWS = [
    {"name": "Earned Premium", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Earned_Premium", "generated": True},
    {"name": "Remaining Budget Premium", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Remaining_Budget_Premium", "generated": True},
    {"name": FORMULA_OUTPUT, "data_format": "Triangle", "calculated": True, "formula": '"Earned Premium" + "Remaining Budget Premium"', "source": "Earned_Premium + Remaining_Budget_Premium", "generated": True},
]
EXISTING = {"earned premium", "remaining budget premium", "total earned premium"}


def _sidecar(
    name: str,
    reserving_class: str,
    *,
    precedents: tuple[str, ...] = (),
    dependents: tuple[str, ...] = (),
    method: bool = False,
) -> dict:
    """One complete sidecar of the shape a reserving class holds."""

    return {
        "json_format": "arcrho-dataset-sidecar-v4",
        "dataset_name": name,
        "dataset_type": name,
        "reserving_class": reserving_class,
        "project_name": PROJECT,
        "source_kind": "dfm" if method else "engine",
        "calculated": False,
        "data_format": "Triangle",
        "method_type": "DFM" if method else "None",
        "status": 0,
        "number_format": "#,##0",
        "decimal_places": 0,
        "show_subtotal": False,
        "csv_file": f"{name}@12@12@cum@dev.csv",
        "origin_length": 12,
        "development_length": 12,
        "stored_origin_length": 12,
        "stored_development_length": 12,
        "cumulative": True,
        "calendar": False,
        "created": "2026-01-01T00:00:00.000Z",
        "modified_by": "Tester",
        "updated_at": "2026-01-02T00:00:00.000Z",
        "precedents": [{"dataset_name": item} for item in precedents],
        "dependents": [{"dataset_name": item} for item in dependents],
        "audit_log": [],
    }


class GeneratedFormulaGraphRepairTests(unittest.TestCase):
    """Two classes: one whose links are stale, one already correct."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name) / "data"
        self._write_class("Auto", stale=True)
        self._write_class("Home", stale=False)

        for name, value in (
            ("get_project_data_dir", lambda _project: str(self.data_dir)),
            (
                "get_project_dataset_sidecar_dir",
                lambda _project, reserving_class: str(self.data_dir / reserving_class / "sidecars"),
            ),
        ):
            patcher = patch.object(config, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, value in (
            ("_dataset_type_rows", lambda _project: [dict(row) for row in ROWS]),
            ("_existing_dataset_keys", lambda _project, _reserving_class: set(EXISTING)),
        ):
            patcher = patch.object(calculated_dataset_service, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    # -- fixtures ---------------------------------------------------------

    def _write_class(self, reserving_class: str, *, stale: bool) -> None:
        folder = self.data_dir / reserving_class / "sidecars"
        folder.mkdir(parents=True, exist_ok=True)
        for name in INPUTS:
            dataset_sidecar_status_service.write_sidecar(
                str(folder / f"{name}.json"),
                _sidecar(
                    name,
                    reserving_class,
                    dependents=() if stale else (FORMULA_OUTPUT,),
                ),
            )
        dataset_sidecar_status_service.write_sidecar(
            str(folder / f"{FORMULA_OUTPUT}.json"),
            _sidecar(
                FORMULA_OUTPUT,
                reserving_class,
                precedents=() if stale else INPUTS,
                dependents=(METHOD,),
            ),
        )
        dataset_sidecar_status_service.write_sidecar(
            str(folder / f"{METHOD}.json"),
            _sidecar(METHOD, reserving_class, precedents=(FORMULA_OUTPUT,), method=True),
        )

    def _path(self, reserving_class: str, name: str) -> Path:
        return self.data_dir / reserving_class / "sidecars" / f"{name}.json"

    def _read(self, reserving_class: str, name: str) -> dict:
        return json.loads(self._path(reserving_class, name).read_text(encoding="utf-8"))

    def _links(self, reserving_class: str, name: str) -> tuple[list[str], list[str]]:
        payload = self._read(reserving_class, name)
        return (
            dataset_sidecar_status_service.entry_names(payload.get("precedents")),
            dataset_sidecar_status_service.entry_names(payload.get("dependents")),
        )

    def _repair(self, reserving_class: str, **kwargs) -> dict:
        return calculated_dataset_service.repair_reserving_class_graph_fields(
            PROJECT, reserving_class, **kwargs
        )

    # -- tests ------------------------------------------------------------

    def test_the_stale_class_is_repaired_and_the_correct_one_is_left_alone(self) -> None:
        before = {
            name: self._path("Auto", name).read_bytes()
            for name in (*INPUTS, FORMULA_OUTPUT, METHOD)
        }
        untouched = self._path("Home", FORMULA_OUTPUT).read_bytes()

        stale = self._repair("Auto")
        correct = self._repair("Home")

        self.assertEqual(stale["sidecars_read"], 4)
        self.assertEqual(stale["sidecars_written"], 3)
        self.assertEqual(sorted(stale["written"]), sorted([*INPUTS, FORMULA_OUTPUT]))
        self.assertEqual(stale["unreadable"], [])
        # The class whose links are already right is read and not written.
        self.assertEqual((correct["sidecars_read"], correct["sidecars_written"]), (4, 0))
        self.assertEqual(self._path("Home", FORMULA_OUTPUT).read_bytes(), untouched)

        self.assertEqual(self._links("Auto", FORMULA_OUTPUT), ([*INPUTS], [METHOD]))
        for name in INPUTS:
            self.assertEqual(self._links("Auto", name), ([], [FORMULA_OUTPUT]))
        # A method sidecar is not an Engine dataset and is never opened for a
        # rewrite, so the method that reads the formula keeps its own file.
        self.assertEqual(self._path("Auto", METHOD).read_bytes(), before[METHOD])

        # Nothing but the two link lists moved: no timestamp, no audit record.
        for name in (*INPUTS, FORMULA_OUTPUT):
            was = json.loads(before[name].decode("utf-8"))
            now = self._read("Auto", name)
            self.assertEqual(list(was), list(now))
            for field in set(was) - {"precedents", "dependents"}:
                self.assertEqual(was[field], now[field], f"{name}.{field}")

    def test_a_second_run_writes_nothing(self) -> None:
        self._repair("Auto")
        repaired = {
            name: self._path("Auto", name).read_bytes()
            for name in (*INPUTS, FORMULA_OUTPUT, METHOD)
        }

        again = self._repair("Auto")

        self.assertEqual((again["sidecars_read"], again["sidecars_written"]), (4, 0))
        for name, payload in repaired.items():
            self.assertEqual(self._path("Auto", name).read_bytes(), payload, name)

    def test_a_report_only_run_changes_no_file(self) -> None:
        before = {
            name: self._path("Auto", name).read_bytes()
            for name in (*INPUTS, FORMULA_OUTPUT, METHOD)
        }

        reported = self._repair("Auto", apply=False)

        self.assertEqual(reported["sidecars_written"], 3)
        self.assertEqual(sorted(reported["written"]), sorted([*INPUTS, FORMULA_OUTPUT]))
        for name, payload in before.items():
            self.assertEqual(self._path("Auto", name).read_bytes(), payload, name)

    def test_a_sidecar_that_cannot_be_read_is_reported_and_the_rest_repaired(self) -> None:
        self._path("Auto", "Earned Premium").write_text("{ not json", encoding="utf-8")

        outcome = self._repair("Auto")

        self.assertEqual(
            [entry["dataset_name"] for entry in outcome["unreadable"]], ["Earned Premium"]
        )
        self.assertEqual(outcome["sidecars_read"], 3)
        self.assertEqual(sorted(outcome["written"]), ["Remaining Budget Premium", FORMULA_OUTPUT])
        self.assertEqual(self._links("Auto", "Remaining Budget Premium"), ([], [FORMULA_OUTPUT]))

    def test_a_class_with_no_sidecar_folder_is_no_work(self) -> None:
        outcome = self._repair("Motor")

        self.assertEqual((outcome["sidecars_read"], outcome["sidecars_written"]), (0, 0))
        self.assertEqual(outcome["unreadable"], [])


class ProjectReservingClassTests(unittest.TestCase):
    """The class's own index owns its name; the folder name is the fallback."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name) / "data"
        self.data_dir.mkdir(parents=True)
        patcher = patch.object(
            config, "get_project_data_dir", lambda _project: str(self.data_dir)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_index_names_the_class_and_the_folder_stands_in(self) -> None:
        indexed = self.data_dir / config.sanitize_reserving_class_folder("HPPREF\\HO+DF")
        indexed.mkdir()
        (indexed / "index.json").write_text(
            json.dumps({"reserving_class": "HPPREF\\HO+DF", "files": []}), encoding="utf-8"
        )
        unindexed = self.data_dir / config.sanitize_reserving_class_folder("Auto\\NJ")
        unindexed.mkdir()

        self.assertEqual(
            sorted(calculated_dataset_service.project_reserving_classes(PROJECT)),
            ["Auto\\NJ", "HPPREF\\HO+DF"],
        )

    def test_a_project_with_no_data_folder_has_no_classes(self) -> None:
        with patch.object(
            config, "get_project_data_dir", lambda _project: str(self.data_dir / "absent")
        ):
            self.assertEqual(calculated_dataset_service.project_reserving_classes(PROJECT), [])


if __name__ == "__main__":
    unittest.main()
