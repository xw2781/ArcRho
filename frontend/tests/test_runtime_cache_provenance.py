from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import (
    arcrho_runtime_service,
    engine_calculation_service,
    runtime_cache_provenance_service,
)


class RuntimeCacheProvenanceTests(unittest.TestCase):
    project_name = "Example Project"
    reserving_class = "Example Reserving Class"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.data_path = (
            self.root
            / "data"
            / "Example Reserving Class"
            / config.DATASET_CACHE_DIR
            / "Earned Premium@12@12@cum@dev.csv"
        )
        self.pairs = [
            ("Function", "ArcRhoTri"),
            ("Path", self.reserving_class),
            ("DatasetName", "Earned Premium"),
            ("InstanceName", "Earned Premium"),
            ("ProjectName", self.project_name),
            ("Cumulative", "True"),
            ("Calendar", "False"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
        ]
        self.provenance = {
            "config_hash": "current-config-hash",
            "algorithm_version": "test",
            "rules_format": "test",
            "rules_revision": 1,
        }

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _write_csv(self) -> None:
        self.data_path.parent.mkdir(parents=True, exist_ok=True)
        self.data_path.write_text("1,2\n3,4\n", encoding="utf-8")

    def _processing_patches(self, current_hash: str = "current-config-hash"):
        return (
            patch.object(
                arcrho_runtime_service,
                "get_processing_provenance",
                return_value=self.provenance,
            ),
            patch.object(
                arcrho_runtime_service,
                "get_processing_config_hash",
                return_value=current_hash,
            ),
        )

    def test_background_provenance_makes_a_sidecarless_cache_reusable(self) -> None:
        self._write_csv()
        provenance_path = Path(arcrho_runtime_service._runtime_cache_provenance_path(str(self.data_path)))

        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )
            self.assertFalse(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path),
                    self.pairs,
                )
            )
            self.assertTrue(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path),
                    self.pairs,
                    allow_runtime_cache_provenance=True,
                )
            )

        self.assertTrue(provenance_path.is_file())
        self.assertFalse(Path(arcrho_runtime_service._dataset_sidecar_path(str(self.data_path), self.pairs)).exists())

    def test_runtime_provenance_is_rejected_when_processing_changes(self) -> None:
        self._write_csv()
        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )

        with patch.object(
            arcrho_runtime_service,
            "get_processing_config_hash",
            return_value="changed-config-hash",
        ):
            self.assertFalse(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path),
                    self.pairs,
                    allow_runtime_cache_provenance=True,
                )
            )

    def test_runtime_provenance_is_rejected_when_the_csv_is_replaced(self) -> None:
        self._write_csv()
        original_stat = self.data_path.stat()
        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )
            self.data_path.write_text("9,8\n7,6\n", encoding="utf-8")
            self.assertEqual(self.data_path.stat().st_size, original_stat.st_size)
            os.utime(
                self.data_path,
                ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
            )
            with patch.object(
                runtime_cache_provenance_service,
                "file_fingerprint",
                wraps=runtime_cache_provenance_service.file_fingerprint,
            ) as fingerprint:
                advisory = arcrho_runtime_service.arcrho_precheck(
                    str(self.data_path),
                    self.pairs,
                    allow_runtime_cache_provenance=True,
                )
                self.assertTrue(advisory["cache_exists"])
                fingerprint.assert_not_called()
                self.assertFalse(
                    arcrho_runtime_service.arcrho_tri_cache_matches(
                        str(self.data_path),
                        self.pairs,
                        allow_runtime_cache_provenance=True,
                    )
                )
                self.assertEqual(fingerprint.call_count, 1)

    def test_precheck_skips_content_io_and_authoritative_load_hashes_once(self) -> None:
        self._write_csv()
        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )
            with patch.object(
                runtime_cache_provenance_service,
                "file_fingerprint",
                wraps=runtime_cache_provenance_service.file_fingerprint,
            ) as fingerprint:
                advisory = arcrho_runtime_service.arcrho_precheck(
                    str(self.data_path),
                    self.pairs,
                    allow_runtime_cache_provenance=True,
                )
                self.assertTrue(advisory["cache_exists"])
                fingerprint.assert_not_called()

                authoritative = arcrho_runtime_service.run_arcrho_tri(
                    self.pairs,
                    str(self.data_path),
                    timeout_sec=0.1,
                    write_sidecar=False,
                )

        self.assertTrue(authoritative["ok"])
        self.assertFalse(authoritative["need_request"])
        self.assertEqual(fingerprint.call_count, 1)

    def test_request_scoped_runtime_validation_reuses_one_fingerprint(self) -> None:
        self._write_csv()
        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )
            get_processing_hash = arcrho_runtime_service._processing_hash_getter(
                self.pairs
            )
            get_file_fingerprint = arcrho_runtime_service._file_fingerprint_getter()
            with patch.object(
                runtime_cache_provenance_service,
                "file_fingerprint",
                wraps=runtime_cache_provenance_service.file_fingerprint,
            ) as fingerprint:
                for _ in range(2):
                    self.assertTrue(
                        arcrho_runtime_service._runtime_cache_provenance_matches(
                            str(self.data_path),
                            self.pairs,
                            get_processing_hash,
                            get_file_fingerprint,
                        )
                    )

        self.assertEqual(fingerprint.call_count, 1)

    def test_cache_resolution_reads_the_processing_configuration_once(self) -> None:
        self._write_csv()
        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )

        with patch.object(
            arcrho_runtime_service,
            "get_processing_config_hash",
            return_value="current-config-hash",
        ) as get_hash:
            result = arcrho_runtime_service.resolve_local_triangle_cache(
                str(self.data_path),
                self.pairs,
                allow_runtime_cache_provenance=True,
            )

        self.assertEqual(result["status"], "cache_exact")
        get_hash.assert_called_once_with(self.project_name)

    def test_preferred_derivable_sidecar_cache_avoids_directory_enumeration(self) -> None:
        source_path = self.data_path.with_name(
            "Earned Premium@6@6@cum@dev.csv"
        )
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text("1,2\n3,4\n", encoding="utf-8")
        payload = {
            "dataset_name": "Earned Premium",
            "dataset_type": "Earned Premium",
            "project_name": self.project_name,
            "reserving_class": self.reserving_class,
            "data_format": "Triangle",
            "source_kind": "input",
            "csv_file": source_path.name,
        }

        with (
            patch.object(
                arcrho_runtime_service,
                "_triangle_sidecar_payload",
                return_value=payload,
            ),
            patch.object(
                arcrho_runtime_service.os,
                "listdir",
                side_effect=AssertionError("unexpected listdir"),
            ),
        ):
            candidates = arcrho_runtime_service._local_cache_candidates(
                str(self.data_path),
                self.pairs,
            )

        self.assertEqual([candidate["path"] for candidate in candidates], [str(source_path)])

    def test_processing_configuration_read_failure_keeps_the_csv(self) -> None:
        self._write_csv()
        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )

        with (
            patch.object(
                arcrho_runtime_service,
                "get_processing_config_hash",
                side_effect=OSError("network unavailable"),
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                str(self.data_path),
                timeout_sec=0.1,
                write_sidecar=False,
            )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertTrue(self.data_path.is_file())

    def test_sidecar_read_failure_keeps_the_csv(self) -> None:
        self._write_csv()
        sidecar_path = arcrho_runtime_service._dataset_sidecar_path(
            str(self.data_path),
            self.pairs,
        )
        real_open = open

        def open_with_unavailable_sidecar(path, *args, **kwargs):
            if str(path) == sidecar_path:
                raise OSError("network unavailable")
            return real_open(path, *args, **kwargs)

        with (
            patch("builtins.open", side_effect=open_with_unavailable_sidecar),
            self.assertRaises(HTTPException) as raised,
        ):
            arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                str(self.data_path),
                timeout_sec=0.1,
                write_sidecar=False,
            )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertTrue(self.data_path.is_file())

    def test_technical_provenance_read_failure_keeps_the_csv(self) -> None:
        self._write_csv()
        provenance_path = str(
            arcrho_runtime_service._runtime_cache_provenance_path(str(self.data_path))
        )
        Path(provenance_path).parent.mkdir(parents=True, exist_ok=True)
        Path(provenance_path).write_text("{}", encoding="utf-8")
        sidecar_path = arcrho_runtime_service._dataset_sidecar_path(
            str(self.data_path),
            self.pairs,
        )
        real_open = open

        def open_with_unavailable_provenance(path, *args, **kwargs):
            if str(path) == sidecar_path:
                raise FileNotFoundError(sidecar_path)
            if str(path) == provenance_path:
                raise OSError("network unavailable")
            return real_open(path, *args, **kwargs)

        with (
            patch("builtins.open", side_effect=open_with_unavailable_provenance),
            self.assertRaises(HTTPException) as raised,
        ):
            arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                str(self.data_path),
                timeout_sec=0.1,
                write_sidecar=False,
            )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertTrue(self.data_path.is_file())

    def test_technical_provenance_write_failure_is_visible_and_keeps_the_csv(self) -> None:
        self._write_csv()
        local_result = {
            "ok": True,
            "status": "cache_derived",
            "data_path": str(self.data_path),
            "derived": {"source_path": "source.csv"},
        }
        with (
            patch.object(
                arcrho_runtime_service,
                "resolve_local_triangle_cache",
                return_value=local_result,
            ),
            patch.object(
                arcrho_runtime_service,
                "_write_runtime_cache_provenance",
                return_value=False,
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                str(self.data_path),
                timeout_sec=0.1,
                write_sidecar=False,
            )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertTrue(self.data_path.is_file())

    def test_precheck_reports_a_matching_background_cache_without_requesting_engine_work(self) -> None:
        self._write_csv()
        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )
            result = arcrho_runtime_service.arcrho_precheck(
                str(self.data_path),
                self.pairs,
                allow_runtime_cache_provenance=True,
            )

        self.assertTrue(result["cache_exists"])
        self.assertFalse(result["need_request"])
        self.assertEqual(result["local_cache_status"], "cache_exact")

    def test_background_provenance_leaves_an_existing_source_sidecar_unchanged(self) -> None:
        self._write_csv()
        sidecar_path = Path(arcrho_runtime_service._dataset_sidecar_path(str(self.data_path), self.pairs))
        sidecar_path.parent.mkdir(parents=True, exist_ok=True)
        sidecar_contents = '{"user_setting":"unsaved-value"}\n'
        sidecar_path.write_text(sidecar_contents, encoding="utf-8")

        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )

        self.assertEqual(sidecar_path.read_text(encoding="utf-8"), sidecar_contents)

    def test_background_provenance_supersedes_stale_source_sidecar_processing(self) -> None:
        self._write_csv()
        sidecar_path = Path(arcrho_runtime_service._dataset_sidecar_path(str(self.data_path), self.pairs))
        sidecar_path.parent.mkdir(parents=True, exist_ok=True)
        sidecar_path.write_text(
            json.dumps({
                "dataset_name": "Earned Premium",
                "dataset_type": "Earned Premium",
                "reserving_class": self.reserving_class,
                "project_name": self.project_name,
                "source_kind": "engine",
                "processing_by_csv": {
                    self.data_path.name: {"config_hash": "old-config-hash"},
                },
            }) + "\n",
            encoding="utf-8",
        )

        provenance_patch, hash_patch = self._processing_patches()
        with provenance_patch, hash_patch:
            self.assertTrue(
                arcrho_runtime_service._write_runtime_cache_provenance(
                    str(self.data_path),
                    self.pairs,
                )
            )
            self.assertFalse(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path),
                    self.pairs,
                )
            )
            self.assertTrue(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path),
                    self.pairs,
                    allow_runtime_cache_provenance=True,
                )
            )

    def test_background_generation_records_provenance_and_next_run_reuses_the_csv(self) -> None:
        def write_generated_csv(path: str, timeout_sec: float) -> bool:
            del timeout_sec
            generated_path = Path(path)
            generated_path.parent.mkdir(parents=True, exist_ok=True)
            generated_path.write_text("1,2\n3,4\n", encoding="utf-8")
            return True

        provenance_patch, hash_patch = self._processing_patches()
        with (
            provenance_patch,
            hash_patch,
            patch.dict(config.DATASETS, {}, clear=True),
            patch.object(arcrho_runtime_service, "_recalculate_requested_app_dataset", return_value=None),
            patch.object(engine_calculation_service, "send_request_like_vba", return_value="request.json") as send_request,
            patch.object(engine_calculation_service, "wait_for_file", side_effect=write_generated_csv),
            patch.object(
                arcrho_runtime_service,
                "_refresh_dataset_instance_index_after_cache_write",
            ) as refresh_index,
            patch.object(
                arcrho_runtime_service,
                "_recalculate_dependents_after_cache_write",
                return_value=None,
            ) as recalculate_dependents,
        ):
            first = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                str(self.data_path),
                timeout_sec=0.1,
                write_sidecar=False,
            )
            second = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                str(self.data_path),
                timeout_sec=0.1,
                write_sidecar=False,
            )

        self.assertTrue(first["ok"])
        self.assertTrue(first["need_request"])
        self.assertTrue(first["cache_provenance_recorded"])
        self.assertTrue(second["ok"])
        self.assertFalse(second["need_request"])
        send_request.assert_called_once()
        refresh_index.assert_not_called()
        recalculate_dependents.assert_not_called()

    def test_background_derivation_does_not_rebuild_the_index_or_dependents(self) -> None:
        self._write_csv()
        local_result = {
            "ok": True,
            "status": "cache_derived",
            "data_path": str(self.data_path),
            "derived": {"source_path": "source.csv"},
        }
        with (
            patch.dict(config.DATASETS, {}, clear=True),
            patch.object(
                arcrho_runtime_service,
                "resolve_local_triangle_cache",
                return_value=local_result,
            ) as resolve_cache,
            patch.object(
                arcrho_runtime_service,
                "_write_runtime_cache_provenance",
                return_value=True,
            ),
            patch.object(
                arcrho_runtime_service,
                "_refresh_dataset_instance_index_after_cache_write",
            ) as refresh_index,
            patch.object(
                arcrho_runtime_service,
                "_recalculate_dependents_after_cache_write",
            ) as recalculate_dependents,
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                str(self.data_path),
                timeout_sec=0.1,
                write_sidecar=False,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["local_cache_status"], "cache_derived")
        self.assertFalse(resolve_cache.call_args.kwargs["refresh_index_on_materialize"])
        refresh_index.assert_not_called()
        recalculate_dependents.assert_not_called()


if __name__ == "__main__":
    unittest.main()
