from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from pydantic import ValidationError

from app_server import config
from app_server.schemas.arcrho import ArcRhoTriRequest
from app_server.services import (
    arcrho_runtime_service,
    dataset_instance_index_service,
    engine_calculation_service,
)


class ArcRhoTemporaryViewCacheTests(unittest.TestCase):
    project_name = "Example Project"
    reserving_class = "Example Reserving Class"
    session_id = "0d928a30-5594-4e2f-b82d-8d0df6f1d0b1"
    later_session_id = "c3c0deae-055f-4c79-80d3-9d8781f6533a"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.project_data_dir = self.root / "Example Project" / "data"
        self.canonical_path = (
            self.project_data_dir
            / "Example Reserving Class"
            / "datasets"
            / "Net Paid@12@12@cum@dev.csv"
        )
        self.temporary_cache_dir = self.canonical_path.parent / config.TEMPORARY_VIEW_DATASET_CACHE_DIR
        self.temporary_path = self.temporary_cache_dir / self.canonical_path.name
        self.sidecar_path = self.canonical_path.parent.parent / config.DATASET_SIDECAR_DIR / "Net Paid.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _pairs(self) -> list[tuple[str, str]]:
        return [
            ("Function", "ArcRhoTri"),
            ("Path", self.reserving_class),
            ("DatasetName", "Net Paid"),
            ("InstanceName", "Net Paid"),
            ("Cumulative", "True"),
            ("Calendar", "False"),
            ("ProjectName", self.project_name),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
        ]

    def _temporary_cache_dir_patch(self):
        return patch.object(
            config,
            "get_project_temporary_view_dataset_cache_dir",
            return_value=str(self.temporary_cache_dir),
        )

    def _missing_cache(self) -> dict[str, object]:
        return {
            "ok": False,
            "status": "missing_sidecar",
            "manual_source_found": False,
            "generated_source_found": False,
            "local_source_found": False,
        }

    def test_temporary_generation_persists_and_reuses_the_hidden_cache(self) -> None:
        self.canonical_path.parent.mkdir(parents=True, exist_ok=True)
        self.canonical_path.write_text("durable cache without a sidecar\n", encoding="utf-8")

        def write_temporary_cache(path: str, timeout_sec: float) -> bool:
            del timeout_sec
            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("1,2\n3,4\n", encoding="utf-8")
            return True

        with (
            self._temporary_cache_dir_patch(),
            patch.dict(config.DATASETS, {}, clear=True),
            patch.object(arcrho_runtime_service, "resolve_local_triangle_cache", return_value=self._missing_cache()),
            patch.object(engine_calculation_service, "send_request_like_vba", return_value="request.txt") as send_request,
            patch.object(engine_calculation_service, "wait_for_file", side_effect=write_temporary_cache),
            patch.object(arcrho_runtime_service, "_write_dataset_sidecar") as write_sidecar,
            patch.object(arcrho_runtime_service, "_refresh_dataset_instance_index_after_cache_write") as refresh_index,
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self._pairs(),
                str(self.canonical_path),
                timeout_sec=0.1,
                temporary_session_id=self.session_id,
            )

            self.assertTrue(result["ok"])
            self.assertTrue(result["temporary_cache"])
            self.assertEqual(result["data_path"], str(self.temporary_path))
            self.assertTrue(self.temporary_path.is_file())
            self.assertEqual(self.canonical_path.read_text(encoding="utf-8"), "durable cache without a sidecar\n")
            self.assertEqual(config.DATASETS[result["ds_id"]], str(self.temporary_path))
            self.assertIn(f"DataPath = {self.temporary_path}", send_request.call_args.args[0])
            self.assertFalse(self.sidecar_path.exists())
            write_sidecar.assert_not_called()
            refresh_index.assert_not_called()

            reused = arcrho_runtime_service.run_arcrho_tri(
                self._pairs(),
                str(self.canonical_path),
                timeout_sec=0.1,
                temporary_session_id=self.later_session_id,
            )
            self.assertTrue(reused["ok"])
            self.assertFalse(reused["need_request"])
            self.assertEqual(reused["data_path"], str(self.temporary_path))
            self.assertEqual(send_request.call_count, 1)

    def test_temporary_request_reuses_a_valid_canonical_cache_first(self) -> None:
        canonical_cache = {
            "ok": True,
            "status": "cache_exact",
            "data_path": str(self.canonical_path),
            "manual_source_found": False,
            "generated_source_found": True,
        }
        with (
            self._temporary_cache_dir_patch(),
            patch.dict(config.DATASETS, {}, clear=True),
            patch.object(arcrho_runtime_service, "resolve_local_triangle_cache", return_value=canonical_cache),
            patch.object(engine_calculation_service, "send_request_like_vba") as send_request,
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self._pairs(),
                str(self.canonical_path),
                timeout_sec=0.1,
                temporary_session_id=self.session_id,
            )

            self.assertTrue(result["ok"])
            self.assertFalse(result["temporary_cache"])
            self.assertEqual(result["data_path"], str(self.canonical_path))
            self.assertEqual(config.DATASETS[result["ds_id"]], str(self.canonical_path))
            self.assertFalse(self.temporary_path.exists())
            send_request.assert_not_called()

    def test_temporary_derivation_writes_hidden_cache_without_rebuilding_index(self) -> None:
        derivable = {
            "ok": True,
            "status": "cache_derivable",
            "data_path": str(self.canonical_path),
            "manual_source_found": False,
            "generated_source_found": True,
        }

        def resolve_cache(*args, **kwargs):
            if not kwargs.get("materialize"):
                return derivable
            target = Path(kwargs["materialize_path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("1,2\n", encoding="utf-8")
            return {
                **derivable,
                "status": "cache_derived",
                "data_path": str(target),
                "derived": {"source_path": "source.csv"},
            }

        with (
            self._temporary_cache_dir_patch(),
            patch.dict(config.DATASETS, {}, clear=True),
            patch.object(arcrho_runtime_service, "resolve_local_triangle_cache", side_effect=resolve_cache) as resolve_cache_mock,
            patch.object(arcrho_runtime_service, "_write_dataset_sidecar") as write_sidecar,
            patch.object(arcrho_runtime_service, "_refresh_dataset_instance_index_after_cache_write") as refresh_index,
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self._pairs(),
                str(self.canonical_path),
                timeout_sec=0.1,
                temporary_session_id=self.session_id,
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["data_path"], str(self.temporary_path))
            self.assertTrue(self.temporary_path.is_file())
            materialize_call = resolve_cache_mock.call_args_list[1]
            self.assertEqual(materialize_call.kwargs["materialize_path"], str(self.temporary_path))
            self.assertFalse(materialize_call.kwargs["refresh_index_on_materialize"])
            write_sidecar.assert_not_called()
            refresh_index.assert_not_called()

    def test_temporary_precheck_recognizes_the_persistent_hidden_cache(self) -> None:
        self.temporary_path.parent.mkdir(parents=True, exist_ok=True)
        self.temporary_path.write_text("1,2\n", encoding="utf-8")
        with (
            self._temporary_cache_dir_patch(),
            patch.dict(config.DATASETS, {}, clear=True),
            patch.object(arcrho_runtime_service, "resolve_local_triangle_cache", return_value=self._missing_cache()),
        ):
            result = arcrho_runtime_service.arcrho_precheck(
                str(self.canonical_path),
                self._pairs(),
                temporary_session_id=self.session_id,
            )

            self.assertTrue(result["cache_exists"])
            self.assertFalse(result["need_request"])
            self.assertTrue(result["temporary_cache"])
            self.assertEqual(result["data_path"], str(self.temporary_path))
            self.assertFalse(config.DATASETS)


class ArcRhoTemporarySessionSchemaTests(unittest.TestCase):
    def test_temporary_session_id_is_uuid_validated(self) -> None:
        session_id = "0d928a30-5594-4e2f-b82d-8d0df6f1d0b1"
        request = ArcRhoTriRequest(
            Path="Example Reserving Class",
            TriangleName="Net Paid",
            ProjectName="Example Project",
            TemporarySessionId=session_id,
        )
        self.assertEqual(str(request.TemporarySessionId), session_id)
        with self.assertRaises(ValidationError):
            ArcRhoTriRequest(
                Path="Example Reserving Class",
                TriangleName="Net Paid",
                ProjectName="Example Project",
                TemporarySessionId="not-a-uuid",
            )


class DatasetIndexTemporaryViewCacheTests(unittest.TestCase):
    def test_index_scan_ignores_nested_temporary_view_csv_caches(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            data_dir = Path(temp_dir)
            temporary_cache_dir = data_dir / config.DATASET_CACHE_DIR / config.TEMPORARY_VIEW_DATASET_CACHE_DIR
            temporary_cache_dir.mkdir(parents=True)
            (temporary_cache_dir / "Net Paid@12@12@cum@dev.csv").write_text("1\n", encoding="utf-8")

            entries = dataset_instance_index_service._enumerate_cached_files({
                "data": str(data_dir),
                "datasets": str(data_dir / config.DATASET_CACHE_DIR),
                "methods": str(data_dir / config.METHOD_DATA_DIR),
                "sidecars": str(data_dir / config.DATASET_SIDECAR_DIR),
            })

            self.assertEqual(entries, [])


if __name__ == "__main__":
    unittest.main()
