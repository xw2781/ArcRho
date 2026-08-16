"""The /arcrho/tri*, /arcrho/vec*, and precheck routes are hosted engine-calculation operations."""

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

from arcrho_engine_calculation_contract import OPERATION_DATASET_PRECHECK, OPERATION_DATASET_RUN

import app_server.api  # noqa: F401  (registers the submodules)
arcrho_router = sys.modules["app_server.api.arcrho_router"]
from app_server.schemas.arcrho import ArcRhoTriRequest, ArcRhoVecRequest
from app_server.services import arcrho_runtime_service, engine_calculation_service


class ArcRhoRouterHostedOperationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calls: list[dict] = []

        def fake_operation(operation, pairs, data_path, options, *, timeout_sec, local):
            self.calls.append(
                {
                    "operation": operation,
                    "pairs": list(pairs),
                    "data_path": data_path,
                    "options": dict(options),
                    "timeout_sec": timeout_sec,
                }
            )
            return local()

        self.patches = [
            patch.object(engine_calculation_service, "run_hosted_dataset_operation", fake_operation),
            patch.object(arcrho_router, "set_data_path_like_vba", return_value="C:\\mapped\\Paid@6@6@cum@dev.csv"),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in reversed(self.patches):
            item.stop()

    def _tri(self, **overrides) -> ArcRhoTriRequest:
        fields = {
            "ProjectName": "Demo",
            "Path": "COL",
            "TriangleName": "Paid",
            "InstanceName": "Paid",
            "Cumulative": True,
            "Calendar": False,
            "OriginLength": 6,
            "DevelopmentLength": 6,
            "timeout_sec": 15.0,
        }
        fields.update(overrides)
        return ArcRhoTriRequest(**fields)

    def test_tri_run_and_refresh_are_dataset_run_operations(self) -> None:
        seen: list[dict] = []

        def fake_run(pairs, data_path, **kwargs):
            seen.append({"pairs": pairs, "data_path": data_path, **kwargs})
            return {"ok": True, "ds_id": "x"}

        with patch.object(arcrho_runtime_service, "run_arcrho_tri", fake_run):
            arcrho_router.arcrho_tri(self._tri(WriteSidecar=False))
            arcrho_router.arcrho_tri_refresh(self._tri())
        self.assertEqual([call["operation"] for call in self.calls], [OPERATION_DATASET_RUN] * 2)
        self.assertEqual(self.calls[0]["options"]["force_refresh"], False)
        self.assertEqual(self.calls[0]["options"]["write_sidecar"], False)
        self.assertEqual(self.calls[1]["options"]["force_refresh"], True)
        self.assertEqual(self.calls[1]["options"]["write_sidecar"], True)
        self.assertEqual(self.calls[0]["timeout_sec"], 15.0)
        # The local fallback runs the canonical route with the same options.
        self.assertEqual(seen[0]["data_path"], "C:\\mapped\\Paid@6@6@cum@dev.csv")
        self.assertEqual(seen[0]["force_refresh"], False)
        self.assertEqual(seen[0]["write_sidecar"], False)
        self.assertEqual(seen[1]["force_refresh"], True)
        self.assertEqual(seen[0]["timeout_sec"], 15.0)
        self.assertEqual(dict(self.calls[0]["pairs"])["Function"], "ArcRhoTri")

    def test_vec_run_is_a_dataset_run_operation(self) -> None:
        with patch.object(arcrho_runtime_service, "run_arcrho_tri", return_value={"ok": True}):
            arcrho_router.arcrho_vec(
                ArcRhoVecRequest(
                    ProjectName="Demo", Path="COL", VectorName="Counts", Cumulative=True,
                    Calendar=False, PeriodLength=12,
                )
            )
        self.assertEqual(self.calls[0]["operation"], OPERATION_DATASET_RUN)
        self.assertEqual(dict(self.calls[0]["pairs"])["Function"], "ArcRhoVec")

    def test_precheck_is_a_dataset_precheck_operation(self) -> None:
        seen: list[dict] = []

        def fake_precheck(data_path, pairs, **kwargs):
            seen.append({"data_path": data_path, **kwargs})
            return {"ok": True, "need_request": False}

        with patch.object(arcrho_runtime_service, "arcrho_precheck", fake_precheck):
            arcrho_router.arcrho_tri_precheck(self._tri(WriteSidecar=False))
        self.assertEqual(self.calls[0]["operation"], OPERATION_DATASET_PRECHECK)
        self.assertEqual(self.calls[0]["options"]["allow_runtime_cache_provenance"], True)
        self.assertEqual(seen[0]["allow_runtime_cache_provenance"], True)
        self.assertEqual(seen[0]["local_only"], False)


if __name__ == "__main__":
    unittest.main()
