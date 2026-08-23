"""The one-round-trip B&S page open, and the app-server save that pairs with it."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
API_SOURCE = FRONTEND_ROOT.parent / "python-api" / "src"
for path in (FRONTEND_ROOT, API_SOURCE):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from fastapi import HTTPException

from arcrho_engine_save_contract import (
    SAVE_JOB_KINDS,
    SAVE_JOB_PLAN_ROOT_FUNCTION,
)
from arcrho_hosted_save_http_contract import HTTP_SAVE_KINDS
from arcrho_workspace_read_contract import (
    HTTP_WORKSPACE_READ_KINDS,
    WORKSPACE_READ_KINDS,
)

from app_server.services import berquist_sherman_service


SR_TYPE = "B&S Settlement Rate Adjustment"
CRA_TYPE = "B&S Case Reserve Adequacy Adjustment"


class ContractRegistrationTests(unittest.TestCase):
    def test_the_read_is_registered_and_advertised(self) -> None:
        self.assertIn("berquist_sherman_load", WORKSPACE_READ_KINDS)
        self.assertIn("berquist_sherman_load", HTTP_WORKSPACE_READ_KINDS)

    def test_the_contract_arguments_are_the_service_signature(self) -> None:
        import inspect

        spec = WORKSPACE_READ_KINDS["berquist_sherman_load"]
        self.assertEqual(spec.module, "berquist_sherman_service")
        self.assertEqual(spec.function, "load_berquist_sherman_method")
        signature = inspect.signature(berquist_sherman_service.load_berquist_sherman_method)
        # A required argument the service does not accept, or a service argument
        # a client cannot pass, breaks the read only on the Gateway.
        self.assertEqual(set(spec.required), set(signature.parameters))
        self.assertEqual(spec.optional, ())

    def test_the_save_is_registered_and_advertised(self) -> None:
        # Registering the kind is the whole move: the Engine's bundled modules,
        # the gateway's advertised kinds, and the plan resolver all derive from
        # this one table, so B&S reaches the server host the way DFM, BF, CC,
        # RS, and Bootstrap already do.
        self.assertEqual(
            SAVE_JOB_KINDS["berquist_sherman_method"],
            ("berquist_sherman_service", "save_berquist_sherman"),
        )
        self.assertIn("berquist_sherman_method", HTTP_SAVE_KINDS)
        self.assertTrue(
            callable(getattr(berquist_sherman_service, SAVE_JOB_PLAN_ROOT_FUNCTION, None))
        )


class MethodPathTests(unittest.TestCase):
    """Both variants must resolve the same file the page's own save path writes."""

    def _path(self, method_type: str) -> Path:
        with patch.object(
            berquist_sherman_service.dataset_sidecar_status_service.config,
            "get_project_method_data_dir",
            return_value=r"X:\ws\projects\P\data\COL\methods",
        ):
            return Path(
                berquist_sherman_service.berquist_sherman_method_path(
                    "P", "COL", method_type, "M"
                )
            )

    def test_each_variant_takes_its_own_filename_prefix(self) -> None:
        sr = self._path(SR_TYPE)
        cra = self._path(CRA_TYPE)
        self.assertTrue(sr.name.startswith("BSSR@"), str(sr))
        self.assertTrue(cra.name.startswith("BSCRA@"), str(cra))
        self.assertEqual(sr.parent, cra.parent)

    def test_a_source_kind_names_the_same_file_as_its_method_type(self) -> None:
        self.assertEqual(self._path("berquist_sherman_cra"), self._path(CRA_TYPE))

    def test_a_non_berquist_sherman_method_type_is_refused(self) -> None:
        # This read runs on the server host under the caller's identity, so the
        # browser must not be able to steer it at another method type's JSON.
        for method_type in ("DFM", "Bornhuetter Ferguson", "Nonsense", ""):
            with self.subTest(method_type=method_type), self.assertRaises(HTTPException) as caught:
                self._path(method_type)
            self.assertEqual(caught.exception.status_code, 400)
            self.assertIn("Berquist Sherman", str(caught.exception.detail))

    def test_an_unresolvable_project_is_not_reported_as_a_bad_method_type(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            berquist_sherman_service.berquist_sherman_method_path(
                "NoSuchProject", "COL", CRA_TYPE, "M"
            )
        self.assertEqual(caught.exception.status_code, 400)
        self.assertNotIn("Berquist Sherman method type", str(caught.exception.detail))


class LoadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sidecar = {"ok": True, "exists": True, "number_format": "0,000", "audit_log": []}

    def _load(self, tmp: Path, method: dict | None, name: str = "M") -> dict:
        method_path = str(tmp / "BSCRA@M.json")
        if method is not None:
            Path(method_path).write_text(json.dumps(method), encoding="utf-8")
        with (
            patch.object(
                berquist_sherman_service,
                "berquist_sherman_method_path",
                return_value=method_path,
            ),
            patch.object(
                berquist_sherman_service.dataset_service,
                "load_dataset_sidecar",
                return_value=self.sidecar,
            ) as sidecar_load,
        ):
            payload = berquist_sherman_service.load_berquist_sherman_method(
                "Demo", "COL", CRA_TYPE, name
            )
        sidecar_load.assert_called_once_with("Demo", "COL", name)
        return payload

    def test_a_saved_method_returns_both_halves_verbatim(self) -> None:
        import tempfile

        method = {"json_format": "berquist_sherman.v1", "method_tab": {"loess_span": 7}}
        with tempfile.TemporaryDirectory() as tmp:
            payload = self._load(Path(tmp), method)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["exists"])
        # The page and the ResQ migration own this schema, so the service must
        # not normalize, default, or drop any part of it.
        self.assertEqual(payload["method"], method)
        self.assertEqual(payload["sidecar"], self.sidecar)

    def test_a_method_that_never_saved_is_not_an_error(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            payload = self._load(Path(tmp), None)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["exists"])
        self.assertIsNone(payload["method"])
        # The sidecar half is still served, so a fresh page still gets the
        # output dataset's number format and audit log.
        self.assertEqual(payload["sidecar"], self.sidecar)

    def test_identity_fields_are_required(self) -> None:
        for args in (("", "COL", CRA_TYPE, "M"), ("Demo", "", CRA_TYPE, "M"), ("Demo", "COL", CRA_TYPE, "")):
            with self.subTest(args=args), self.assertRaises(HTTPException) as caught:
                berquist_sherman_service.load_berquist_sherman_method(*args)
            self.assertEqual(caught.exception.status_code, 400)

    def test_unreadable_method_json_reports_the_file(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "BSCRA@M.json"
            broken.write_text("{not json", encoding="utf-8")
            with (
                patch.object(
                    berquist_sherman_service,
                    "berquist_sherman_method_path",
                    return_value=str(broken),
                ),
                patch.object(
                    berquist_sherman_service.dataset_service,
                    "load_dataset_sidecar",
                    return_value=self.sidecar,
                ),
                self.assertRaises(HTTPException) as caught,
            ):
                berquist_sherman_service.load_berquist_sherman_method("Demo", "COL", CRA_TYPE, "M")
        self.assertEqual(caught.exception.status_code, 500)
        self.assertIn("BSCRA@M.json", str(caught.exception.detail))


class _SaveFixture(unittest.TestCase):
    """A temporary reserving class for the two halves of the save to write into."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.method_path = self.root / "methods" / "BSCRA@M.json"
        patchers = (
            patch.object(
                berquist_sherman_service,
                "berquist_sherman_method_path",
                return_value=str(self.method_path),
            ),
            patch.object(
                berquist_sherman_service.config,
                "get_project_dataset_cache_dir",
                return_value=str(self.root / "datasets"),
            ),
        )
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def _method(self, name: str = "M") -> dict:
        return {
            "json_format": "berquist_sherman_cra.v1",
            "details_tab": {"name": name, "method_type": CRA_TYPE},
            "method_tab": {"selected_adjustment": [[1, 2], [3]], "loess_span": 7},
        }

    def _save(self, method: dict, **kwargs) -> dict:
        return berquist_sherman_service.save_berquist_sherman(
            "Demo", "COL", method, method_type=CRA_TYPE, method_name="M", **kwargs
        )


class SaveTests(_SaveFixture):
    """The method JSON and output CSV are written by the app server, not the renderer."""

    def test_the_method_text_is_the_canonical_persisted_json(self) -> None:
        from arcrho_api.io import persisted_json_text

        method = self._method()
        result = self._save(method, csv_file="M@12@12@cum@dev.csv", output_csv="1,2\n3\n")
        self.assertTrue(result["ok"])
        self.assertEqual(self.method_path.read_bytes(), persisted_json_text(method).encode("utf-8"))
        csv_path = self.root / "datasets" / "M@12@12@cum@dev.csv"
        self.assertEqual(csv_path.read_bytes(), b"1,2\n3\n")
        self.assertEqual(result["output_csv_file"], "M@12@12@cum@dev.csv")
        self.assertEqual(
            {Path(path) for path in result["method_changed_paths"]},
            {self.method_path, csv_path},
        )
        # The payload is stored as the page built it; nothing is normalized away.
        self.assertEqual(json.loads(self.method_path.read_text(encoding="utf-8")), method)

    def test_an_unchanged_file_is_not_rewritten(self) -> None:
        self._save(self._method(), csv_file="M@12@12@cum@dev.csv", output_csv="1\n")
        again = self._save(self._method(), csv_file="M@12@12@cum@dev.csv", output_csv="1\n")
        self.assertEqual(again["method_changed_paths"], [])

    def test_a_method_only_write_leaves_the_csv_alone(self) -> None:
        csv_path = self.root / "datasets" / "M@12@12@cum@dev.csv"
        csv_path.parent.mkdir(parents=True)
        csv_path.write_text("old\n", encoding="utf-8")
        result = self._save(self._method())
        self.assertEqual(result["output_csv_path"], "")
        self.assertEqual(csv_path.read_text(encoding="utf-8"), "old\n")
        self.assertTrue(self.method_path.is_file())

    def test_the_payload_must_name_the_method_being_saved(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            self._save(self._method("Other"))
        self.assertEqual(caught.exception.status_code, 409)
        self.assertFalse(self.method_path.exists())

    def test_the_csv_name_cannot_carry_a_path(self) -> None:
        for csv_file in ("..\\M.csv", "sub/M.csv", "M.txt", ""):
            with self.subTest(csv_file=csv_file), self.assertRaises(HTTPException) as caught:
                self._save(self._method(), csv_file=csv_file, output_csv="1\n")
            self.assertEqual(caught.exception.status_code, 400)


class OutputSidecarTests(_SaveFixture):
    """The output sidecar is published by the same call that writes the method."""

    def _sidecar_body(self, **overrides) -> dict:
        body = {
            "project_name": "Demo",
            "reserving_class": "COL",
            "dataset_name": "M",
            "dataset_type": "Gross Loss - ad hoc",
            "origin_length": 12,
            "development_length": 12,
            "csv_file": "M@12@12@cum@dev.csv",
        }
        body.update(overrides)
        return body

    def _patched(self, published=None, writable=None):
        return (
            patch.object(
                berquist_sherman_service.dataset_service,
                "save_dataset_sidecar",
                side_effect=published
                if callable(published)
                else (lambda *a, **k: {"ok": True, "path": "S", "audit_log": []}),
            ),
            patch.object(
                berquist_sherman_service.dependent_propagation_service,
                "require_reserving_class_writable",
                side_effect=writable if callable(writable) else (lambda *a, **k: None),
            ),
        )

    def test_one_call_writes_the_method_and_publishes_the_sidecar(self) -> None:
        seen = {}

        def publish(project, reserving, dataset_name, **kwargs):
            seen.update(
                project=project,
                reserving=reserving,
                dataset_name=dataset_name,
                kwargs=kwargs,
                method_written=self.method_path.is_file(),
            )
            return {"ok": True, "path": "S", "audit_log": [], "calculated_updates": {"ok": True}}

        saved, _writable = self._patched(published=publish)
        with saved, _writable:
            result = self._save(
                self._method(),
                csv_file="M@12@12@cum@dev.csv",
                output_csv="1\n",
                sidecar=self._sidecar_body(),
            )
        self.assertEqual((seen["project"], seen["reserving"]), ("Demo", "COL"))
        self.assertEqual(seen["dataset_name"], "M")
        # The method half lands first, exactly as the two separate calls did.
        self.assertTrue(seen["method_written"])
        # The project, the class, the name, and the plan fingerprint are the
        # enclosing save's, so they never travel twice.
        for owned_elsewhere in ("project_name", "reserving_class", "dataset_name", "plan_fingerprint"):
            self.assertNotIn(owned_elsewhere, seen["kwargs"])
        self.assertEqual(seen["kwargs"]["dataset_type"], "Gross Loss - ad hoc")
        # The page reads the sidecar half's response, with the written paths beside it.
        self.assertEqual(result["calculated_updates"], {"ok": True})
        self.assertEqual(Path(result["method_path"]), self.method_path)
        self.assertTrue(result["output_csv_path"].endswith("M@12@12@cum@dev.csv"))

    def test_the_method_half_cannot_overwrite_a_sidecar_field(self) -> None:
        published = {
            "ok": True,
            "path": "S",
            "csv_file": "sidecar-owned.csv",
            "audit_log": [{"action": "Update"}],
        }
        saved, writable = self._patched(published=lambda *a, **k: dict(published))
        with saved, writable:
            result = self._save(
                self._method(),
                csv_file="M@12@12@cum@dev.csv",
                output_csv="1\n",
                sidecar=self._sidecar_body(),
            )
        for key, value in published.items():
            self.assertEqual(result[key], value, key)
        self.assertEqual(result["output_csv_file"], "M@12@12@cum@dev.csv")

    def test_the_sidecar_half_cannot_write_a_second_output_csv(self) -> None:
        saved, writable = self._patched()
        for field in ("values", "mask"):
            with (
                self.subTest(field=field),
                saved,
                writable,
                self.assertRaises(HTTPException) as caught,
            ):
                self._save(
                    self._method(),
                    csv_file="M@12@12@cum@dev.csv",
                    output_csv="1\n",
                    sidecar=self._sidecar_body(**{field: [[1.0]]}),
                )
            self.assertEqual(caught.exception.status_code, 400)
            self.assertFalse(self.method_path.exists())

    def test_a_busy_reserving_class_refuses_before_the_method_is_written(self) -> None:
        def busy(*_args, **_kwargs):
            raise HTTPException(423, "A dependent update is still running.")

        saved, writable = self._patched(writable=busy)
        with saved, writable, self.assertRaises(HTTPException) as caught:
            self._save(
                self._method(),
                csv_file="M@12@12@cum@dev.csv",
                output_csv="1\n",
                sidecar=self._sidecar_body(),
            )
        self.assertEqual(caught.exception.status_code, 423)
        # Both halves are behind one refusal now, so a busy class can no longer
        # leave a method file ahead of the sidecar that describes it.
        self.assertFalse(self.method_path.exists())

    def test_a_method_only_write_publishes_nothing(self) -> None:
        saved, writable = self._patched()
        with saved as publish, writable as require_writable:
            result = self._save(self._method())
        publish.assert_not_called()
        require_writable.assert_not_called()
        self.assertNotIn("calculated_updates", result)

    def test_the_plan_roots_are_the_published_output_dataset(self) -> None:
        self.assertEqual(
            berquist_sherman_service.save_propagation_roots(
                "Demo", "COL", self._method(), sidecar=self._sidecar_body()
            ),
            [("M", "Gross Loss - ad hoc")],
        )
        # A dataset type the page left blank falls back to the dataset's own name.
        self.assertEqual(
            berquist_sherman_service.save_propagation_roots(
                "Demo", "COL", self._method(), sidecar=self._sidecar_body(dataset_type="")
            ),
            [("M", "M")],
        )
        # A method-only write changes nothing anything downstream can see.
        self.assertEqual(
            berquist_sherman_service.save_propagation_roots("Demo", "COL", self._method()),
            [],
        )


if __name__ == "__main__":
    unittest.main()
