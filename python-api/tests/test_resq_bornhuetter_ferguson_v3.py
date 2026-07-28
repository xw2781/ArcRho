from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


_PYTHON_API = Path(__file__).resolve().parents[1]
_REPO_ROOT = _PYTHON_API.parent
_NODE = _REPO_ROOT / "frontend" / "node-portable" / "node.exe"
_FRONTEND_CONTRACT = (
    _REPO_ROOT
    / "frontend"
    / "ui"
    / "method_pages"
    / "bornhuetter_ferguson"
    / "bornhuetter_ferguson_json_contract.js"
)
sys.path.insert(0, str(_PYTHON_API / "src"))
sys.path.insert(0, str(_PYTHON_API / "migration"))

from arcrho_api.bornhuetter_ferguson_contract import (  # noqa: E402
    BF_JSON_FORMAT,
    build_bornhuetter_ferguson_output_sidecar,
    normalize_bornhuetter_ferguson_method,
)
from resq_migration import extractors  # noqa: E402
from resq_migration.number_formats import configure_number_formats_path  # noqa: E402


class _DatasetType:
    Name = "Ultimate Loss"
    DataFormat = 1
    Category = type("Category", (), {"Name": "Loss"})()


class _Vector:
    def __init__(self, name: str, values: list[float], *, output: bool = False):
        self.Name = name
        self._values = values
        self.OriginCount = len(values)
        self.PeriodLength = 12
        self.DatasetType = _DatasetType()
        self.Modified = "2026-01-02T00:00:00Z"
        self.Created = "2025-01-01T00:00:00Z"
        self.User = "migration-user"
        self.MethodType = 2 if output else 0
        self.Status = 2 if output else 0
        self.Formula = ""

    def OriginLabel(self, index: int):
        return ["2020", "2021"][index - 1]

    def ValuesByIndex(self, index: int):
        return self._values[index - 1]


class _Triangle:
    Name = "Paid Loss"

    def __init__(self):
        self._values = [[80, 100], [150, 200]]

    def DevelopmentCount(self, *args, **kwargs):
        del args, kwargs
        return 2

    def ValuesByIndex(self, origin_index: int, dev_index: int):
        return self._values[origin_index - 1][dev_index - 1]


class _BfMethod:
    OriginLength = 12
    OriginCount = 2
    Notes = "Migrated BF note"
    Latest = _Triangle()
    PercentageDeveloped = _Vector("Paid DFM Ultimate", [200, 400])
    Prior = _Vector("Plan Ultimate", [300, 600])
    OutputVector = _Vector("BF Ultimate", [250, 500], output=True)

    def OriginLabel(self, *args, **kwargs):
        index = kwargs.get("OriginIndex") if kwargs else args[0]
        return ["2020", "2021"][index - 1]


class ResqBornhuetterFergusonV3Tests(unittest.TestCase):
    maxDiff = None

    def setUp(self) -> None:
        tmp_root = Path(__file__).resolve().parent / "logs" / "tmp"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(tmp_root))
        self.root = Path(self.tmp.name)
        self.rc_dir = self.root / "data" / "Auto_%5C_PP"
        self.rc_dir.mkdir(parents=True)
        configure_number_formats_path(self.root)
        extractors.configure_extractors(
            project_name="Demo",
            rs_json_format="arcrho-result-selection-method-by-tab-v2",
            bf_json_format=BF_JSON_FORMAT,
            method_data_dir="methods",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _frontend_payload(self, method: dict) -> dict:
        self.assertTrue(_NODE.is_file(), f"Bundled Node runtime is missing: {_NODE}")
        self.assertTrue(
            _FRONTEND_CONTRACT.is_file(),
            f"Frontend BF contract builder is missing: {_FRONTEND_CONTRACT}",
        )
        tab = method["method_tab"]
        metadata = method["method_metadata"]
        builder_input = {
            "details": {
                **method["details_tab"],
                "latest_dataset": tab["latest_dataset"],
                "dfm_dataset": tab["dfm_dataset"],
            },
            "originLabels": tab["origin_labels"],
            "latestValues": tab["latest_values"],
            "dfmUltimateValues": tab["dfm_ultimate_values"],
            "priorSources": tab["prior_datasets"],
            "percentageDeveloped": tab["percentage_developed"],
            "selectedPriorValues": tab["selected_prior_values"],
            "newUltimate": tab["new_ultimate"],
            "showWeights": tab["show_weights"],
            "showEffectiveWeights": tab["show_effective_weights"],
            "methodMetadata": {"data_refreshed": metadata["data_refreshed"]},
            "lastModified": metadata["last_modified"],
        }
        module_url = _FRONTEND_CONTRACT.resolve().as_uri()
        source = (
            f'import {{ buildBornhuetterFergusonMethodPayload as build }} from {json.dumps(module_url)};'
            "let input=''; for await (const chunk of process.stdin) input += chunk;"
            "process.stdout.write(JSON.stringify(build(JSON.parse(input))));"
        )
        completed = subprocess.run(
            [str(_NODE), "--input-type=module", "--eval", source],
            input=json.dumps(builder_input),
            text=True,
            capture_output=True,
            check=True,
            cwd=str(_REPO_ROOT),
            timeout=20,
        )
        return json.loads(completed.stdout)

    def test_resq_export_is_complete_exact_canonical_v3(self) -> None:
        payload = extractors.export_bornhuetter_ferguson(_BfMethod())
        notes = payload.pop("_sidecar_notes")
        status = payload.pop("_sidecar_status")

        self.assertEqual(notes, "Migrated BF note")
        self.assertEqual(status, 2)
        self.assertEqual(payload["json_format"], BF_JSON_FORMAT)
        self.assertEqual(payload, normalize_bornhuetter_ferguson_method(payload))
        method = payload["method_tab"]
        self.assertEqual(method["latest_values"], [100, 200])
        self.assertEqual(method["dfm_ultimate_values"], [200, 400])
        self.assertEqual(method["prior_datasets"][0]["values"], [300, 600])
        self.assertEqual(method["prior_datasets"][0]["weights"], [1, 1])
        self.assertEqual(method["new_ultimate"], [250, 500])
        self.assertFalse(method["show_effective_weights"])
        for key in ("owned_revision", "derived_revision", "publication_revision"):
            self.assertTrue(payload["method_metadata"][key].startswith("sha256:"))

        frontend_shape = self._frontend_payload(payload)
        self.assertEqual(
            normalize_bornhuetter_ferguson_method(frontend_shape),
            payload,
        )

    def test_migration_method_and_sidecar_match_canonical_builders_exactly(self) -> None:
        method_payload = extractors.export_bornhuetter_ferguson(_BfMethod())
        vector_payload = extractors.export_vector(_BfMethod.OutputVector)
        extractors._apply_bornhuetter_ferguson_vector_metadata(vector_payload, method_payload)

        extractors.write_vector_export(
            vector_payload,
            r"Auto\PP",
            self.rc_dir,
            bf_method_payload=method_payload,
        )
        method_path = extractors.write_bornhuetter_ferguson_export(
            method_payload, r"Auto\PP", self.rc_dir
        )
        sidecar_path = self.rc_dir / "sidecars" / "BF Ultimate.json"
        written_method = json.loads(method_path.read_text(encoding="utf-8"))
        written_sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        expected_sidecar = build_bornhuetter_ferguson_output_sidecar(
            method_payload,
            project_name="Demo",
            reserving_class=r"Auto\PP",
            csv_file="BF Ultimate@12.csv",
            existing={},
            notes="Migrated BF note",
            timestamp="2026-01-02T00:00:00Z",
            user="migration-user",
            output_changed=True,
            append_audit=True,
            status=2,
        )

        self.assertEqual(written_method, normalize_bornhuetter_ferguson_method(method_payload))
        self.assertEqual(written_sidecar, expected_sidecar)
        self.assertEqual(
            written_sidecar["publication_revision"],
            written_method["method_metadata"]["publication_revision"],
        )
        self.assertEqual(written_sidecar["dataset_category"], "Loss")
        self.assertEqual(written_sidecar["status"], 2)


if __name__ == "__main__":
    unittest.main()
