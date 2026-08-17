"""Client-side transport selection and route wiring for workspace reads."""

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

from fastapi import HTTPException

from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS

from app_server import config

# ``app_server.api`` re-exports each APIRouter under its module's name, so the
# route modules themselves are reached through the import system.
import app_server.api  # noqa: F401  (registers the submodules)
bootstrap_router = sys.modules["app_server.api.bootstrap_router"]
bornhuetter_ferguson_router = sys.modules["app_server.api.bornhuetter_ferguson_router"]
berquist_sherman_router = sys.modules["app_server.api.berquist_sherman_router"]
cape_cod_router = sys.modules["app_server.api.cape_cod_router"]
dataset_router = sys.modules["app_server.api.dataset_router"]
dfm_method_index_router = sys.modules["app_server.api.dfm_method_index_router"]
dfm_method_router = sys.modules["app_server.api.dfm_method_router"]
result_selection_router = sys.modules["app_server.api.result_selection_router"]
table_summary_router = sys.modules["app_server.api.table_summary_router"]
from app_server.schemas.bootstrap import BootstrapIdentityRequest
from app_server.schemas.berquist_sherman import BerquistShermanLoadRequest
from app_server.schemas.bornhuetter_ferguson import BornhuetterFergusonIdentityRequest
from app_server.schemas.cape_cod import CapeCodIdentityRequest
from app_server.schemas.dataset import DatasetCacheLoadRequest
from app_server.schemas.dfm_method import DfmMethodIdentityRequest
from app_server.schemas.result_selection import ResultSelectionLoadRequest
from app_server.services import workspace_read_client


class RebaseWorkspacePathsTests(unittest.TestCase):
    def test_server_paths_move_under_the_client_root(self) -> None:
        payload = {
            "path": "E:\\ArcRho Server\\projects\\Demo\\data\\COL\\datasets\\Paid.csv",
            "folder_paths": {"data": "e:/arcrho server/projects/Demo/data/COL"},
            "values": [[1.0, None], ["E:\\ArcRho Server", "unrelated E:\\Other\\x"]],
            "count": 3,
        }
        rebased = workspace_read_client.rebase_workspace_paths(
            payload, "E:\\ArcRho Server\\", "\\\\NE7SASWPN02\\e\\ArcRho Server"
        )
        self.assertEqual(
            rebased["path"],
            "\\\\NE7SASWPN02\\e\\ArcRho Server\\projects\\Demo\\data\\COL\\datasets\\Paid.csv",
        )
        self.assertEqual(
            rebased["folder_paths"]["data"],
            "\\\\NE7SASWPN02\\e\\ArcRho Server\\projects\\Demo\\data\\COL",
        )
        self.assertEqual(rebased["values"][0], [1.0, None])
        self.assertEqual(rebased["values"][1][0], "\\\\NE7SASWPN02\\e\\ArcRho Server")
        self.assertEqual(rebased["values"][1][1], "unrelated E:\\Other\\x")
        self.assertEqual(rebased["count"], 3)

    def test_same_root_is_a_no_op(self) -> None:
        payload = {"path": "E:\\ArcRho Server\\x"}
        self.assertIs(
            workspace_read_client.rebase_workspace_paths(payload, "E:\\ArcRho Server", "e:\\arcrho server\\"),
            payload,
        )

    def test_missing_roots_leave_payload_alone(self) -> None:
        payload = {"path": "E:\\ArcRho Server\\x"}
        self.assertIs(workspace_read_client.rebase_workspace_paths(payload, "", "C:\\x"), payload)
        self.assertIs(workspace_read_client.rebase_workspace_paths(payload, "E:\\ArcRho Server", ""), payload)


class CapabilityTests(unittest.TestCase):
    def test_kind_support_requires_an_advertised_list(self) -> None:
        self.assertFalse(workspace_read_client.gateway_supports_read_kind(None, "dataset_index"))
        self.assertFalse(workspace_read_client.gateway_supports_read_kind({}, "dataset_index"))
        self.assertTrue(
            workspace_read_client.gateway_supports_read_kind(
                {"workspace_read_kinds": ["dataset_index"]}, "dataset_index"
            )
        )
        self.assertFalse(
            workspace_read_client.gateway_supports_read_kind(
                {"workspace_read_kinds": ["dataset_index"]}, "table_summary"
            )
        )


class _CaptureRead:
    """Stand in for run_workspace_read and record what a route asked for."""

    def __init__(self, payload: dict | None = None, *, remote: bool = False) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.payload = payload if payload is not None else {"ok": True}
        self.remote = remote

    def __call__(self, read_kind, kwargs, *, local, finalize=None):
        self.calls.append((read_kind, dict(kwargs)))
        if self.remote:
            payload = dict(self.payload)
            return finalize(payload) if finalize is not None else payload
        return local()


class RouteWiringTests(unittest.TestCase):
    """Every migrated route names a registered kind and passes only its arguments."""

    def _assert_registered(self, capture: _CaptureRead) -> None:
        for kind, kwargs in capture.calls:
            spec = WORKSPACE_READ_KINDS[kind]
            self.assertTrue(set(kwargs) <= spec.allowed, f"{kind}: {sorted(kwargs)}")
            for name in spec.required:
                self.assertIn(name, kwargs)

    def test_dataset_index_routes(self) -> None:
        capture = _CaptureRead()
        with (
            patch.object(dataset_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(dataset_router.dataset_service, "list_cached_dataset_names", return_value={"ok": True, "via": "service"}) as service,
            patch.object(dfm_method_index_router.dataset_instance_index_service, "get_index", return_value={"ok": True, "via": "index"}) as index,
        ):
            self.assertEqual(dataset_router.list_cached_dataset_names("Demo", "COL", refresh=True)["via"], "service")
            self.assertEqual(dfm_method_index_router.get_dfm_method_index("Demo", "COL")["via"], "index")
        service.assert_called_once_with("Demo", "COL", refresh=True)
        index.assert_called_once_with("Demo", "COL", refresh=False)
        self.assertEqual([kind for kind, _ in capture.calls], ["dataset_index", "dataset_index"])
        self.assertEqual(capture.calls[0][1]["refresh"], True)
        self._assert_registered(capture)

    def test_dataset_cache_load_adopts_a_remote_handle(self) -> None:
        capture = _CaptureRead({"ok": True, "id": "arcrhotri_remote", "path": "\\\\srv\\Paid.csv"}, remote=True)
        request = DatasetCacheLoadRequest(project_name="Demo", reserving_class="COL", dataset_name="Paid")
        with (
            patch.object(dataset_router.workspace_read_client, "run_workspace_read", capture),
            patch.dict(config.DATASETS, {}, clear=True),
        ):
            response = dataset_router.load_dataset_cache(request)
            self.assertEqual(response["id"], "arcrhotri_remote")
            self.assertEqual(config.DATASETS["arcrhotri_remote"], "\\\\srv\\Paid.csv")
        self.assertEqual(capture.calls[0][0], "dataset_cache_load")
        self.assertEqual(capture.calls[0][1]["dataset_name"], "Paid")
        self._assert_registered(capture)

    def test_dataset_grid_load_is_hosted_and_unknown_handle_resolves_locally(self) -> None:
        capture = _CaptureRead({"ok": True, "id": "arcrhotri_x", "values": [[1.0]]}, remote=True)
        with (
            patch.object(dataset_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(dataset_router.dataset_service, "get_dataset", return_value={"id": "arcrhotri_x", "via": "local"}) as service,
        ):
            self.assertEqual(dataset_router.get_dataset("arcrhotri_x", "Demo", 6)["values"], [[1.0]])
        service.assert_not_called()
        self.assertEqual(capture.calls[0][0], "dataset_grid_load")
        self.assertEqual(capture.calls[0][1], {"ds_id": "arcrhotri_x", "project_name": "Demo", "origin_length": 6})
        self._assert_registered(capture)

        # The gateway did not know the handle: an answer without a dataset id
        # means "resolve here", not 404.
        unknown = _CaptureRead({"ok": True, "response": None}, remote=True)
        with (
            patch.object(dataset_router.workspace_read_client, "run_workspace_read", unknown),
            patch.object(dataset_router.dataset_service, "get_dataset", return_value={"id": "arcrhotri_x", "via": "local"}) as service,
        ):
            self.assertEqual(dataset_router.get_dataset("arcrhotri_x", "Demo", 6)["via"], "local")
        service.assert_called_once_with("arcrhotri_x", project_name="Demo", origin_length=6)
        with (
            patch.object(dataset_router.workspace_read_client, "run_workspace_read", _CaptureRead()),
            patch.object(dataset_router.dataset_service, "get_dataset", return_value=None),
        ):
            with self.assertRaises(HTTPException) as caught:
                dataset_router.get_dataset("arcrhotri_missing", "Demo", 6)
        self.assertEqual(caught.exception.status_code, 404)

    def test_dataset_cache_load_local_path_is_the_service(self) -> None:
        capture = _CaptureRead()
        request = DatasetCacheLoadRequest(project_name="Demo", reserving_class="COL", dataset_name="Paid", csv_file="Paid.csv")
        with (
            patch.object(dataset_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(dataset_router.dataset_service, "load_cached_dataset_values", return_value={"ok": True}) as service,
        ):
            dataset_router.load_dataset_cache(request)
        service.assert_called_once_with(
            "Demo", "COL", "Paid",
            csv_file="Paid.csv", origin_length=None, development_length=None,
            cumulative=True, calendar=False,
        )

    def test_method_load_routes(self) -> None:
        capture = _CaptureRead()
        with (
            patch.object(dfm_method_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(result_selection_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(bornhuetter_ferguson_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(cape_cod_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(berquist_sherman_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(bootstrap_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(dfm_method_router.dfm_service, "load_dfm_method", return_value={"ok": True}) as dfm,
            patch.object(result_selection_router.result_selection_service, "load_result_selection", return_value={"ok": True}) as rs,
            patch.object(bornhuetter_ferguson_router.bornhuetter_ferguson_service, "load_bornhuetter_ferguson_method", return_value={"ok": True}) as bf,
            patch.object(cape_cod_router.cape_cod_service, "load_cape_cod_method", return_value={"ok": True}) as cc,
            patch.object(bootstrap_router.bootstrap_service, "load_bootstrap_method", return_value={"ok": True}) as bst,
            patch.object(berquist_sherman_router.berquist_sherman_service, "load_berquist_sherman_method", return_value={"ok": True}) as bs,
        ):
            dfm_method_router.load_dfm_method(
                DfmMethodIdentityRequest(project_name="Demo", reserving_class="COL", method_name="M", output_dataset="Out")
            )
            result_selection_router.load_result_selection(
                ResultSelectionLoadRequest(project_name="Demo", reserving_class="COL", method_name="M", include_method=False)
            )
            bornhuetter_ferguson_router.load_bornhuetter_ferguson(
                BornhuetterFergusonIdentityRequest(project_name="Demo", reserving_class="COL", method_name="M")
            )
            cape_cod_router.load_cape_cod(
                CapeCodIdentityRequest(project_name="Demo", reserving_class="COL", method_name="M")
            )
            bootstrap_router.load_bootstrap(
                BootstrapIdentityRequest(project_name="Demo", reserving_class="COL", method_name="M")
            )
            berquist_sherman_router.load_berquist_sherman(
                BerquistShermanLoadRequest(
                    project_name="Demo",
                    reserving_class="COL",
                    method_type="B&S Case Reserve Adequacy Adjustment",
                    method_name="M",
                )
            )
        dfm.assert_called_once_with("Demo", "COL", "M", output_dataset="Out")
        rs.assert_called_once_with("Demo", "COL", "M", include_method=False)
        bf.assert_called_once_with("Demo", "COL", "M")
        cc.assert_called_once_with("Demo", "COL", "M")
        bst.assert_called_once_with("Demo", "COL", "M")
        bs.assert_called_once_with("Demo", "COL", "B&S Case Reserve Adequacy Adjustment", "M")
        self.assertEqual(
            [kind for kind, _ in capture.calls],
            [
                "dfm_method_load",
                "result_selection_load",
                "bornhuetter_ferguson_load",
                "cape_cod_load",
                "bootstrap_load",
                "berquist_sherman_load",
            ],
        )
        self._assert_registered(capture)

    def test_table_summary_route(self) -> None:
        capture = _CaptureRead()
        with (
            patch.object(table_summary_router.workspace_read_client, "run_workspace_read", capture),
            patch.object(table_summary_router.table_summary_service, "get_table_summary", return_value={"ok": True, "from_cache": True}) as service,
        ):
            self.assertTrue(table_summary_router.get_table_summary("Demo")["from_cache"])
        service.assert_called_once_with("Demo")
        self.assertEqual(capture.calls, [("table_summary", {"project_name": "Demo"})])
        self._assert_registered(capture)


if __name__ == "__main__":
    unittest.main()
