"""Cover the saved ResQ transfer selection and the partial-import merge rule.

The document is what makes the shared review table open with the same rows
ticked for everyone, so what it stores, what it refuses, and what it falls
back to are the whole contract. The merge rule beside it is what stops a
partial import from deleting the datasets it was told to leave alone.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
for _path in (_PYTHON_API_ROOT / "src", _PYTHON_API_ROOT / "migration"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from resq_migration import sync as sync_contract  # noqa: E402
from resq_migration import transfer_selection  # noqa: E402


class TransferSelectionDocumentTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.scope = ("Demo", r"Auto\PP", "ResQ Test")

    def _path(self) -> Path:
        return transfer_selection.selection_path(self.root, *self.scope)

    def _read(self) -> dict:
        return transfer_selection.read_selection(self._path(), *self.scope)

    def test_it_sits_beside_the_synchronization_baseline_under_the_same_scope(self):
        baseline = sync_contract.sync_state_path(self.root, *self.scope)
        path = self._path()

        self.assertEqual(path.parent, baseline.parent)
        self.assertEqual(path.name, f"{baseline.stem}.selection.json")
        self.assertEqual(path.parent.parts[-2:], ("sync", "resq"))

    def test_a_different_reserving_class_or_connection_is_a_different_document(self):
        self.assertNotEqual(self._path(), transfer_selection.selection_path(self.root, "Demo", r"Auto\CA", "ResQ Test"))
        self.assertNotEqual(self._path(), transfer_selection.selection_path(self.root, "Demo", r"Auto\PP", "ResQ Prod"))

    def test_nothing_saved_reads_back_as_nothing_selected_in_either_direction(self):
        document = self._read()

        self.assertEqual(transfer_selection.selected_names(document, "import"), [])
        self.assertEqual(transfer_selection.selected_names(document, "export"), [])

    def test_each_direction_keeps_its_own_list(self):
        transfer_selection.save_selection(self.root, *self.scope, "import", ["Paid Loss", "ResQ Only"])
        transfer_selection.save_selection(self.root, *self.scope, "export", ["Paid Loss"], updated_by="ali")

        document = self._read()
        self.assertEqual(transfer_selection.selected_names(document, "import"), ["Paid Loss", "ResQ Only"])
        self.assertEqual(transfer_selection.selected_names(document, "export"), ["Paid Loss"])
        self.assertEqual(document["selections"]["export"]["updated_by"], "ali")
        self.assertEqual(document["selections"]["import"]["updated_by"], "")

    def test_saving_one_direction_leaves_the_other_untouched(self):
        transfer_selection.save_selection(self.root, *self.scope, "import", ["Paid Loss"])
        transfer_selection.save_selection(self.root, *self.scope, "export", ["Reported Loss"])
        transfer_selection.save_selection(self.root, *self.scope, "export", ["Claim Counts"])

        document = self._read()
        self.assertEqual(transfer_selection.selected_names(document, "import"), ["Paid Loss"])
        self.assertEqual(transfer_selection.selected_names(document, "export"), ["Claim Counts"])

    def test_names_are_de_duplicated_by_the_identity_that_pairs_the_two_sides(self):
        transfer_selection.save_selection(
            self.root, *self.scope, "export", ["Paid  Loss", "paid loss", "  ", "Claim Counts"]
        )

        self.assertEqual(
            transfer_selection.selected_names(self._read(), "export"), ["Claim Counts", "Paid Loss"]
        )

    def test_an_unknown_direction_is_refused(self):
        for direction in ("", "sideways", None):
            with self.subTest(direction=direction):
                with self.assertRaisesRegex(ValueError, "Direction must be one of"):
                    transfer_selection.save_selection(self.root, *self.scope, direction, ["Paid Loss"])

    def test_a_document_from_another_scope_is_read_as_nothing_saved(self):
        transfer_selection.save_selection(self.root, *self.scope, "export", ["Paid Loss"])
        payload = json.loads(self._path().read_text(encoding="utf-8"))
        payload["reserving_class"] = r"Auto\CA"
        self._path().write_text(json.dumps(payload), encoding="utf-8")

        self.assertEqual(transfer_selection.selected_names(self._read(), "export"), [])

    def test_an_unreadable_document_is_read_as_nothing_saved_rather_than_raising(self):
        path = self._path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ not json", encoding="utf-8")

        self.assertEqual(transfer_selection.selected_names(self._read(), "import"), [])

    def test_a_document_of_another_version_is_read_as_nothing_saved(self):
        transfer_selection.save_selection(self.root, *self.scope, "export", ["Paid Loss"])
        payload = json.loads(self._path().read_text(encoding="utf-8"))
        payload["version"] = transfer_selection.TRANSFER_SELECTION_VERSION + 1
        self._path().write_text(json.dumps(payload), encoding="utf-8")

        self.assertEqual(transfer_selection.selected_names(self._read(), "export"), [])

    def test_the_document_is_written_through_the_canonical_persisted_json_text(self):
        from arcrho_api.io import persisted_json_text

        transfer_selection.save_selection(self.root, *self.scope, "export", ["Paid Loss"])

        text = self._path().read_text(encoding="utf-8")
        self.assertEqual(text, persisted_json_text(json.loads(text)))
        self.assertFalse(list(self._path().parent.glob(".*.tmp")))


class PartialImportMergeTests(unittest.TestCase):
    """A live group the import never asked for must survive the commit."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.live = self.root / "live"
        self.stage = self.root / "stage"

    def _dataset(self, rc_dir: Path, name: str, *, values: str, modified: str):
        from resq_migration.core import DATASET_CACHE_DIR, DATASET_SIDECAR_DIR

        (rc_dir / DATASET_CACHE_DIR).mkdir(parents=True, exist_ok=True)
        (rc_dir / DATASET_SIDECAR_DIR).mkdir(parents=True, exist_ok=True)
        (rc_dir / DATASET_CACHE_DIR / f"{name}.csv").write_text(values, encoding="utf-8")
        (rc_dir / DATASET_SIDECAR_DIR / f"{name}.json").write_text(
            json.dumps({"dataset_name": name, "dataset_type": name, "updated_at": modified}),
            encoding="utf-8",
        )

    def test_a_live_group_outside_the_request_is_kept_whatever_the_stage_holds(self):
        from resq_migration.core import DATASET_CACHE_DIR
        from resq_migration.merge import merge_preserved_arcrho_artifacts

        self._dataset(self.live, "Paid Loss", values="live paid", modified="2026-08-28T10:00:00+00:00")
        self._dataset(self.live, "Reported Loss", values="live reported", modified="2026-08-28T10:00:00+00:00")
        # The stage holds only what the import was asked for, and its copy of
        # that item is older than the live one, so overwrite must still win.
        self._dataset(self.stage, "Paid Loss", values="resq paid", modified="2026-08-01T10:00:00+00:00")

        result = merge_preserved_arcrho_artifacts(
            self.live, self.stage, overwrite=True, requested_names=["Paid Loss"]
        )

        self.assertEqual(result["names"], ["Reported Loss"])
        self.assertEqual(
            (self.stage / DATASET_CACHE_DIR / "Paid Loss.csv").read_text(encoding="utf-8"), "resq paid"
        )
        self.assertEqual(
            (self.stage / DATASET_CACHE_DIR / "Reported Loss.csv").read_text(encoding="utf-8"),
            "live reported",
        )

    def test_an_unreviewed_live_group_counts_as_requested(self):
        """A calculated or engine-generated group is never in the request, yet the import carries it."""
        from unittest.mock import patch

        from resq_migration import merge
        from resq_migration.core import DATASET_CACHE_DIR

        self._dataset(self.live, "Paid Loss", values="live paid", modified="2026-08-28T10:00:00+00:00")
        self._dataset(self.live, "Reported CDF", values="live cdf", modified="2026-08-28T10:00:00+00:00")
        self._dataset(self.stage, "Paid Loss", values="resq paid", modified="2026-08-01T10:00:00+00:00")
        self._dataset(self.stage, "Reported CDF", values="resq cdf", modified="2026-08-01T10:00:00+00:00")

        with patch.object(
            merge, "_is_unreviewed_dataset", side_effect=lambda name, _type: name == "Reported CDF"
        ):
            result = merge.merge_preserved_arcrho_artifacts(
                self.live, self.stage, overwrite=True, requested_names=["Paid Loss"]
            )

        self.assertEqual(result["names"], [])
        self.assertEqual(
            (self.stage / DATASET_CACHE_DIR / "Reported CDF.csv").read_text(encoding="utf-8"), "resq cdf"
        )

    def test_without_a_request_the_older_rule_stands(self):
        from resq_migration.core import DATASET_CACHE_DIR
        from resq_migration.merge import merge_preserved_arcrho_artifacts

        self._dataset(self.live, "Paid Loss", values="live paid", modified="2026-08-28T10:00:00+00:00")
        self._dataset(self.live, "Reported Loss", values="live reported", modified="2026-08-28T10:00:00+00:00")
        self._dataset(self.stage, "Paid Loss", values="resq paid", modified="2026-08-01T10:00:00+00:00")

        result = merge_preserved_arcrho_artifacts(self.live, self.stage, overwrite=True)

        # Nothing was requested, so a live group the stage did not produce is
        # only kept when its dataset type is unknown to the stage.
        self.assertNotIn("Paid Loss", result["names"])
        self.assertEqual(
            (self.stage / DATASET_CACHE_DIR / "Paid Loss.csv").read_text(encoding="utf-8"), "resq paid"
        )


if __name__ == "__main__":
    unittest.main()
