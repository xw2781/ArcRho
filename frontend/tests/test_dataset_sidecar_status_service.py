from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import dataset_sidecar_status_service as status_service


class DatasetSidecarStatusServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.sidecars = Path(self.temp_dir.name) / "sidecars"
        self.sidecars.mkdir()
        self.sidecar_dir_patch = patch.object(
            config,
            "get_project_dataset_sidecar_dir",
            return_value=str(self.sidecars),
        )
        self.sidecar_dir_patch.start()

    def tearDown(self) -> None:
        self.sidecar_dir_patch.stop()
        self.temp_dir.cleanup()

    def write_sidecar(
        self,
        name: str,
        *,
        method_type: str,
        source_kind: str,
        dependents: list[str],
        status: int = status_service.STATUS_CURRENT,
    ) -> None:
        status_service.write_sidecar(
            status_service.sidecar_path("Project", "Class", name),
            {
                "dataset_name": name,
                "dataset_type": name,
                "project_name": "Project",
                "reserving_class": "Class",
                "method_type": method_type,
                "source_kind": source_kind,
                "status": status,
                "precedents": [],
                "dependents": status_service.name_entries(dependents),
            },
        )

    def status(self, name: str) -> int:
        path = status_service.sidecar_path("Project", "Class", name)
        return int(json.loads(Path(path).read_text(encoding="utf-8"))["status"])

    def test_transitive_review_alerts_skip_plain_vectors_and_cover_all_method_types(self) -> None:
        self.write_sidecar(
            "Input",
            method_type=status_service.METHOD_TYPE_NONE,
            source_kind="input",
            dependents=["C61 Calculated Vector"],
        )
        self.write_sidecar(
            "C61 Calculated Vector",
            method_type=status_service.METHOD_TYPE_NONE,
            source_kind="calculated",
            dependents=["DFM Output", "B&S CRA Output"],
        )
        self.write_sidecar(
            "DFM Output",
            method_type=status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
            dependents=["B&S SR Output"],
        )
        self.write_sidecar(
            "B&S CRA Output",
            method_type=status_service.METHOD_TYPE_BERQUIST_SHERMAN_CRA,
            source_kind=status_service.SOURCE_KIND_BERQUIST_SHERMAN_CRA,
            dependents=["BF Output"],
        )
        self.write_sidecar(
            "B&S SR Output",
            method_type=status_service.METHOD_TYPE_BERQUIST_SHERMAN_SR,
            source_kind=status_service.SOURCE_KIND_BERQUIST_SHERMAN_SR,
            dependents=["BF Output"],
        )
        self.write_sidecar(
            "BF Output",
            method_type=status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON,
            source_kind="bornhuetter_ferguson",
            dependents=["CC Output"],
        )
        self.write_sidecar(
            "CC Output",
            method_type=status_service.METHOD_TYPE_CAPE_COD,
            source_kind="cape_cod",
            dependents=["BST Output"],
        )
        self.write_sidecar(
            "BST Output",
            method_type=status_service.METHOD_TYPE_BOOTSTRAP,
            source_kind="bootstrap",
            dependents=["RS Output"],
        )
        self.write_sidecar(
            "RS Output",
            method_type=status_service.METHOD_TYPE_RESULT_SELECTION,
            source_kind="result_selection",
            dependents=[],
        )

        updates = status_service.refresh_method_statuses_for_dependents(
            "Project",
            "Class",
            ["Input"],
        )

        self.assertEqual(self.status("Input"), status_service.STATUS_CURRENT)
        self.assertEqual(self.status("C61 Calculated Vector"), status_service.STATUS_CURRENT)
        for name in (
            "DFM Output",
            "B&S CRA Output",
            "B&S SR Output",
            "BF Output",
            "CC Output",
            "BST Output",
            "RS Output",
        ):
            self.assertEqual(self.status(name), status_service.STATUS_REVIEW_NEEDED)
        self.assertCountEqual(
            [item["dataset_name"] for item in updates],
            [
                "DFM Output",
                "B&S CRA Output",
                "B&S SR Output",
                "BF Output",
                "CC Output",
                "BST Output",
                "RS Output",
            ],
        )
        self.assertEqual(
            status_service.refresh_method_statuses_for_dependents(
                "Project",
                "Class",
                ["Input"],
            ),
            [],
        )

    def test_direct_only_marks_the_first_method_tier_through_plain_vectors(self) -> None:
        self.write_sidecar(
            "Input",
            method_type=status_service.METHOD_TYPE_NONE,
            source_kind="input",
            dependents=["Vector"],
        )
        self.write_sidecar(
            "Vector",
            method_type=status_service.METHOD_TYPE_NONE,
            source_kind="calculated",
            dependents=["DFM Output"],
        )
        self.write_sidecar(
            "DFM Output",
            method_type=status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
            dependents=["BF Output"],
        )
        self.write_sidecar(
            "BF Output",
            method_type=status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON,
            source_kind="bornhuetter_ferguson",
            dependents=[],
        )

        updates = status_service.refresh_method_statuses_for_dependents(
            "Project",
            "Class",
            ["Input"],
            direct_only=True,
        )

        # The walk passes through the plain vector to the nearest method,
        # then stops: the marked method's own downstream belongs to the
        # Engine job's full-closure marking.
        self.assertEqual(
            [item["dataset_name"] for item in updates], ["DFM Output"]
        )
        self.assertEqual(self.status("Vector"), status_service.STATUS_CURRENT)
        self.assertEqual(
            self.status("DFM Output"), status_service.STATUS_REVIEW_NEEDED
        )
        self.assertEqual(self.status("BF Output"), status_service.STATUS_CURRENT)

    def test_review_needed_precedents_are_deduplicated_and_keep_input_order(self) -> None:
        self.write_sidecar(
            "Current Method",
            method_type=status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
            dependents=[],
        )
        self.write_sidecar(
            "Review Method",
            method_type=status_service.METHOD_TYPE_RESULT_SELECTION,
            source_kind="result_selection",
            dependents=[],
            status=status_service.STATUS_REVIEW_NEEDED,
        )
        self.write_sidecar(
            "Plain Input",
            method_type=status_service.METHOD_TYPE_NONE,
            source_kind="input",
            dependents=[],
            status=status_service.STATUS_REVIEW_NEEDED,
        )

        self.assertEqual(
            status_service.review_needed_precedent_names(
                "Project",
                "Class",
                ["Review Method", "Current Method", "review method", "Plain Input", "Missing"],
            ),
            ["Review Method"],
        )


if __name__ == "__main__":
    unittest.main()
