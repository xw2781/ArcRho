"""Bootstrap refresh, dataset notes and empty-dataset create are hosted saves.

Each one writes a method, a sidecar or a CSV, so it runs on Arco Engine under
the reserving-class lease like a page's own Save and never from the client
process. These tests pin the registered kinds, the arguments each route sends,
the roots each save walks from, and that the routes nothing called are gone.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
API_SOURCE = FRONTEND_ROOT.parent / "python-api" / "src"
for path in (FRONTEND_ROOT, API_SOURCE):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_engine_save_contract import SAVE_JOB_KINDS

import app_server.api  # noqa: F401  (registers the route submodules)

from app_server.schemas.bootstrap import BootstrapIdentityRequest
from app_server.schemas.dataset import DatasetNotesSaveRequest, EmptyDatasetCacheCreateRequest
from app_server.services import (
    bootstrap_service,
    calculated_dataset_service,
    dataset_service,
    save_plan_service,
)

bootstrap_router = sys.modules["app_server.api.bootstrap_router"]
dataset_router = sys.modules["app_server.api.dataset_router"]
bornhuetter_ferguson_router = sys.modules["app_server.api.bornhuetter_ferguson_router"]
cape_cod_router = sys.modules["app_server.api.cape_cod_router"]


def _hosted(response=None):
    return patch.object(
        dataset_router.engine_hosted_save_service,
        "run_hosted_save",
        return_value=response or {"ok": True},
    )


class RegisteredKindTests(unittest.TestCase):
    def test_each_kind_names_its_hosted_entry_point(self) -> None:
        for kind, module in (
            ("bootstrap_refresh", bootstrap_service),
            ("dataset_notes", dataset_service),
            ("empty_dataset_create", dataset_service),
        ):
            module_name, function_name = SAVE_JOB_KINDS[kind]
            self.assertEqual(module_name, module.__name__.rsplit(".", 1)[-1])
            self.assertTrue(callable(getattr(module, function_name)), kind)


class BootstrapRefreshTests(unittest.TestCase):
    def test_the_route_runs_a_hosted_save_and_never_refreshes_locally(self) -> None:
        request = BootstrapIdentityRequest(project_name="Demo", reserving_class="COL", method_name="BST")
        with (
            _hosted({"ok": True, "updated": True}) as hosted,
            patch.object(bootstrap_service, "refresh_bootstrap_method") as local,
        ):
            response = bootstrap_router.refresh_bootstrap(request)
        local.assert_not_called()
        self.assertTrue(response["updated"])
        hosted.assert_called_once_with(
            "bootstrap_refresh", "Demo", "COL", args=["Demo", "COL", {"method_name": "BST"}]
        )

    def test_the_entry_point_refreshes_the_named_method(self) -> None:
        with patch.object(bootstrap_service, "refresh_bootstrap_method", return_value={"ok": True}) as target:
            bootstrap_service.refresh_bootstrap_method_save("Demo", "COL", {"method_name": "BST"})
        target.assert_called_once_with("Demo", "COL", "BST")

    def test_the_roots_are_the_stored_methods_output(self) -> None:
        stored = {"details_tab": {"name": "BST", "output_type": "BST Type"}}
        with (
            patch.object(bootstrap_service, "_method_path", return_value="BST.json") as method_path,
            patch.object(bootstrap_service, "_read_json", return_value=stored),
        ):
            roots = save_plan_service.resolve_save_roots(
                "bootstrap_refresh", ["Demo", "COL", {"method_name": "BST"}], {}
            )
        method_path.assert_called_once_with("Demo", "COL", "BST")
        self.assertEqual(roots, [{"dataset_name": "BST", "dataset_type": "BST Type"}])


class DatasetNotesTests(unittest.TestCase):
    def test_the_route_runs_a_hosted_save(self) -> None:
        request = DatasetNotesSaveRequest(
            project_name="Demo", reserving_class="COL", dataset_name="Paid", notes="n"
        )
        with (
            _hosted() as hosted,
            patch.object(dataset_service, "save_dataset_notes") as local,
        ):
            dataset_router.save_dataset_notes(request)
        local.assert_not_called()
        hosted.assert_called_once_with(
            "dataset_notes",
            "Demo",
            "COL",
            args=["Demo", "COL", {"dataset_name": "Paid", "notes": "n"}],
        )

    def test_the_entry_point_saves_the_notes(self) -> None:
        with patch.object(dataset_service, "save_dataset_notes", return_value={"ok": True}) as target:
            dataset_service.save_dataset_notes_request(
                "Demo", "COL", {"dataset_name": "Paid", "notes": "n"}
            )
        target.assert_called_once_with("Demo", "COL", "Paid", "n")

    def test_a_notes_save_walks_nothing(self) -> None:
        roots = save_plan_service.resolve_save_roots(
            "dataset_notes", ["Demo", "COL", {"dataset_name": "Paid", "notes": "n"}], {}
        )
        self.assertEqual(roots, [])


class EmptyDatasetCreateTests(unittest.TestCase):
    REQUEST = {
        "dataset_name": "Paid Copy",
        "dataset_type": "Paid",
        "instance_name": "Paid Copy",
        "data_format": "Vector",
        "origin_length": 12,
        "development_length": 12,
        "cumulative": True,
        "calendar": False,
    }

    def test_the_route_runs_a_hosted_save(self) -> None:
        request = EmptyDatasetCacheCreateRequest(
            project_name="Demo",
            reserving_class="COL",
            dataset_type="Paid",
            instance_name="Paid Copy",
            data_format="Vector",
        )
        with (
            _hosted() as hosted,
            patch.object(dataset_service, "create_empty_cached_dataset") as local,
        ):
            dataset_router.create_empty_cached_dataset(request)
        local.assert_not_called()
        self.assertEqual(hosted.call_args.args, ("empty_dataset_create", "Demo", "COL"))
        self.assertEqual(hosted.call_args.kwargs["args"], ["Demo", "COL", self.REQUEST])

    def test_the_entry_point_creates_the_dataset(self) -> None:
        with patch.object(dataset_service, "create_empty_cached_dataset", return_value={"ok": True}) as target:
            dataset_service.create_empty_cached_dataset_request("Demo", "COL", dict(self.REQUEST))
        target.assert_called_once_with(
            "Demo",
            "COL",
            "Paid",
            instance_name="Paid Copy",
            data_format="Vector",
            origin_length=12,
            development_length=12,
            cumulative=True,
            calendar=False,
        )

    def _roots(self, calculated_rows):
        with (
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[]),
            patch.object(calculated_dataset_service, "_app_calculated_rows", return_value=calculated_rows),
        ):
            return dataset_service.save_propagation_roots("Demo", "COL", dict(self.REQUEST))

    def test_an_input_create_walks_from_the_new_instance(self) -> None:
        self.assertEqual(self._roots([]), [("Paid Copy", "Paid")])

    def test_a_calculated_create_walks_from_its_type(self) -> None:
        self.assertEqual(self._roots([{"name": "paid"}]), [("Paid", "Paid")])


class RemovedRouteTests(unittest.TestCase):
    def _paths(self, module) -> set[str]:
        return {route.path for route in module.router.routes}

    def test_the_uncalled_refresh_and_patch_routes_are_gone(self) -> None:
        self.assertNotIn("/bornhuetter-ferguson/refresh", self._paths(bornhuetter_ferguson_router))
        self.assertNotIn("/cape-cod/refresh", self._paths(cape_cod_router))
        self.assertNotIn("/dataset/{ds_id}/patch", self._paths(dataset_router))
        self.assertFalse(hasattr(dataset_service, "patch_dataset"))
        # Bootstrap refresh stays, now hosted.
        self.assertIn("/bootstrap/refresh", self._paths(bootstrap_router))


if __name__ == "__main__":
    unittest.main()
