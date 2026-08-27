from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
_REPOSITORY_ROOT = _PYTHON_API_ROOT.parent
_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"
for _path in (_PYTHON_API_ROOT / "src", _PYTHON_API_ROOT / "migration"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from resq_migration import sync


def _item(
    name: str = "Paid Loss",
    *,
    timestamp: float | None = 100.0,
    kind: str = "Dataset",
    data_format: str = "Triangle",
    dataset_type: str = "Paid Loss",
    method_name: str = "",
) -> dict:
    return {
        "name": name,
        "kind": kind,
        "data_format": data_format,
        "dataset_type": dataset_type,
        "method_name": method_name,
        "modified_timestamp": timestamp,
        "can_export_to_resq": True,
        "can_import_to_arcrho": True,
        "can_receive_from_arcrho": True,
    }


def _baseline(*, arcrho_timestamp: float = 100.0, resq_timestamp: float = 100.0) -> dict:
    entry = {
        "arcrho_present": True,
        "resq_present": True,
        "arcrho_timestamp": arcrho_timestamp,
        "resq_timestamp": resq_timestamp,
    }
    return {"items": {"paid loss": entry}}


class ResqSyncPlanTests(unittest.TestCase):
    def test_raw_timestamp_comparison_equal_and_unknown_are_fail_closed(self):
        cases = (
            (
                [_item(timestamp=200)],
                [_item(timestamp=100)],
                "ArcRho newer",
                sync.ACTION_ARCRHO_TO_RESQ,
                True,
            ),
            (
                [_item(timestamp=100)],
                [_item(timestamp=200)],
                "ResQ newer",
                sync.ACTION_RESQ_TO_ARCRHO,
                True,
            ),
            (
                [_item(timestamp=100)],
                [_item(timestamp=100)],
                "Same timestamp",
                "",
                False,
            ),
            (
                [_item(timestamp=None)],
                [_item(timestamp=100)],
                "Unknown timestamp",
                "",
                False,
            ),
        )

        for local, remote, status, action, selected in cases:
            with self.subTest(status=status, action=action):
                row = sync.build_sync_plan(local, remote)[0]
                self.assertEqual(row["status"], status)
                self.assertEqual(row["action"], action)
                self.assertEqual(row["selected"], selected)
                self.assertEqual(row["disabled"], not bool(action))

    def test_recorded_baseline_prevents_a_resq_save_timestamp_from_ping_ponging(self):
        state = sync.empty_sync_state("Demo", r"Auto\PP", "Demo")
        state = sync.record_synced_items(
            state,
            ["Paid Loss"],
            [_item(timestamp=100)],
            [_item(timestamp=110)],
            synced_at="2026-08-12T12:00:00+00:00",
        )

        unchanged = sync.build_sync_plan(
            [_item(timestamp=100)],
            [_item(timestamp=110)],
            state,
        )[0]
        self.assertEqual(unchanged["status"], "Synchronized")
        self.assertEqual(unchanged["action"], "")

        local_changed = sync.build_sync_plan(
            [_item(timestamp=120)],
            [_item(timestamp=110)],
            state,
        )[0]
        self.assertEqual(local_changed["status"], "ArcRho changed")
        self.assertEqual(local_changed["action"], sync.ACTION_ARCRHO_TO_RESQ)

    def _baselined_state(self):
        return sync.record_synced_items(
            sync.empty_sync_state("Demo", r"Auto\PP", "ResQ Demo"),
            ["Paid Loss"],
            [_item(timestamp=200)],
            [_item(timestamp=100)],
            synced_at="2026-08-12T12:00:00+00:00",
        )

    def test_a_batch_ripple_is_baselined_only_on_the_side_it_moved(self):
        # Saving a DFM into ResQ makes ResQ recalculate and re-stamp the Result
        # Selection downstream of it; the next review used to call that "ResQ
        # changed" and offer to pull back a copy nobody edited.
        state = self._baselined_state()
        before = sync.build_sync_plan([_item(timestamp=200)], [_item(timestamp=100)], state)
        after = sync.build_sync_plan([_item(timestamp=200)], [_item(timestamp=150)], state)
        self.assertEqual(after[0]["status"], "ResQ changed")

        updated, absorbed = sync.absorb_propagated_changes(
            state, before, after, keys=["paid loss"], synced_at="2026-08-12T12:05:00+00:00"
        )

        self.assertEqual(
            absorbed,
            [{"key": "paid loss", "name": "Paid Loss", "kind": "Dataset", "sides": ["resq"]}],
        )
        entry = updated["items"]["paid loss"]
        self.assertEqual((entry["arcrho_timestamp"], entry["resq_timestamp"]), (200.0, 150.0))
        self.assertEqual(entry["propagated_at"], "2026-08-12T12:05:00+00:00")
        self.assertEqual(entry["synced_at"], "2026-08-12T12:00:00+00:00")
        replan = sync.build_sync_plan([_item(timestamp=200)], [_item(timestamp=150)], updated)
        self.assertEqual(replan[0]["status"], "Synchronized")

    def test_a_change_pending_before_the_batch_survives_the_ripple(self):
        state = self._baselined_state()
        before = sync.build_sync_plan([_item(timestamp=300)], [_item(timestamp=100)], state)
        after = sync.build_sync_plan([_item(timestamp=300)], [_item(timestamp=150)], state)
        self.assertEqual(before[0]["status"], "ArcRho changed")

        updated, absorbed = sync.absorb_propagated_changes(state, before, after, keys=["paid loss"])

        self.assertEqual([item["sides"] for item in absorbed], [["resq"]])
        entry = updated["items"]["paid loss"]
        self.assertEqual((entry["arcrho_timestamp"], entry["resq_timestamp"]), (200.0, 150.0))
        replan = sync.build_sync_plan([_item(timestamp=300)], [_item(timestamp=150)], updated)
        self.assertEqual(replan[0]["status"], "ArcRho changed")

    def test_a_row_without_a_baseline_is_baselined_only_from_matching_timestamps(self):
        empty = sync.empty_sync_state("Demo", r"Auto\PP", "ResQ Demo")
        same_before = sync.build_sync_plan([_item(timestamp=200)], [_item(timestamp=200)])
        same_after = sync.build_sync_plan([_item(timestamp=200)], [_item(timestamp=250)])
        self.assertEqual(same_before[0]["status"], "Same timestamp")

        updated, absorbed = sync.absorb_propagated_changes(
            empty, same_before, same_after, keys=["paid loss"], synced_at="2026-08-12T12:05:00+00:00"
        )

        self.assertEqual([item["sides"] for item in absorbed], [["resq"]])
        entry = updated["items"]["paid loss"]
        self.assertEqual((entry["arcrho_timestamp"], entry["resq_timestamp"]), (200.0, 250.0))
        self.assertEqual(entry["synced_at"], "2026-08-12T12:05:00+00:00")
        replan = sync.build_sync_plan([_item(timestamp=200)], [_item(timestamp=250)], updated)
        self.assertEqual(replan[0]["status"], "Synchronized")

        pending_before = sync.build_sync_plan([_item(timestamp=300)], [_item(timestamp=200)])
        pending_after = sync.build_sync_plan([_item(timestamp=300)], [_item(timestamp=250)])
        untouched, absorbed = sync.absorb_propagated_changes(
            empty, pending_before, pending_after, keys=["paid loss"]
        )
        self.assertEqual(absorbed, [])
        self.assertEqual(untouched["items"], {})

    def test_a_row_that_held_still_is_left_alone(self):
        state = self._baselined_state()
        plan = sync.build_sync_plan([_item(timestamp=200)], [_item(timestamp=100)], state)

        updated, absorbed = sync.absorb_propagated_changes(state, plan, plan, keys=["paid loss", "missing"])

        self.assertEqual(absorbed, [])
        self.assertEqual(updated["items"], state["items"])

    def test_items_on_one_side_only_never_become_rows(self):
        plan = sync.build_sync_plan(
            [_item("Paid Loss"), _item("Only Here"), _item("Twice Here"), _item("Twice Here")],
            [_item("Paid Loss"), _item("Only There")],
        )

        self.assertEqual([row["name"] for row in plan], ["Paid Loss"])

    def test_an_interrupted_run_leaves_the_next_comparison_to_the_recorded_baseline(self):
        row = sync.build_sync_plan(
            [_item(timestamp=200)],
            [_item(timestamp=100)],
            _baseline(),
        )[0]

        self.assertEqual(row["status"], "ArcRho changed")
        self.assertEqual(row["action"], sync.ACTION_ARCRHO_TO_RESQ)
        self.assertFalse(row["conflict"])
        self.assertTrue(row["selected"])

    def test_both_changed_is_an_unselected_conflict_even_when_newer_side_is_known(self):
        row = sync.build_sync_plan(
            [_item(timestamp=150)],
            [_item(timestamp=160)],
            _baseline(),
        )[0]

        self.assertEqual(row["status"], "Both changed; ResQ newer")
        self.assertEqual(row["action"], sync.ACTION_RESQ_TO_ARCRHO)
        self.assertTrue(row["conflict"])
        self.assertFalse(row["selected"])
        self.assertFalse(row["disabled"])

        equal = sync.build_sync_plan(
            [_item(timestamp=150)],
            [_item(timestamp=150)],
            _baseline(),
        )[0]
        self.assertEqual(equal["status"], "Both changed")
        self.assertEqual(equal["action"], "")
        self.assertTrue(equal["conflict"])
        self.assertTrue(equal["disabled"])

    def test_type_format_dataset_type_and_method_mismatches_do_not_offer_actions(self):
        cases = (
            (
                _item(kind="Dataset"),
                _item(kind="DFM", data_format="Vector", method_name="Selected DFM"),
                "Type mismatch",
            ),
            (
                _item(data_format="Triangle"),
                _item(data_format="Vector"),
                "Format mismatch",
            ),
            (
                _item(dataset_type="Paid Loss"),
                _item(dataset_type="Incurred Loss"),
                "Dataset Type mismatch",
            ),
            (
                _item(
                    kind="DFM",
                    data_format="Vector",
                    dataset_type="Ultimate Loss",
                    method_name="Selected DFM",
                ),
                _item(
                    kind="DFM",
                    data_format="Vector",
                    dataset_type="Ultimate Loss",
                    method_name="Alternative DFM",
                ),
                "Method mismatch",
            ),
        )

        for local, remote, status in cases:
            with self.subTest(status=status):
                row = sync.build_sync_plan([local], [remote])[0]
                self.assertEqual(row["status"], status)
                self.assertEqual(row["action"], "")
                self.assertTrue(row["disabled"])
                self.assertFalse(row["selected"])

    def test_state_round_trip_is_scoped_atomic_and_omits_transient_fields(self):
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=_TMP_ROOT) as temp_name:
            root = Path(temp_name)
            state_path = sync.sync_state_path(root, "Demo", r"Auto\PP", "ResQ Demo")
            state = sync.empty_sync_state("Demo", r"Auto\PP", "ResQ Demo")
            state = sync.record_synced_items(
                state,
                ["Paid Loss"],
                [_item(timestamp=101)],
                [_item(timestamp=202)],
                synced_at="2026-08-12T12:00:00+00:00",
            )
            self.assertEqual(state["_recorded_keys"], ["paid loss"])

            written = sync.write_sync_state(state_path, state)
            loaded = sync.read_sync_state(
                written,
                "Demo",
                r"Auto\PP",
                "ResQ Demo",
            )

            self.assertEqual(loaded["items"]["paid loss"]["arcrho_timestamp"], 101.0)
            self.assertEqual(loaded["items"]["paid loss"]["resq_timestamp"], 202.0)
            self.assertNotIn("_recorded_keys", loaded)
            self.assertTrue(written.read_bytes().endswith(b"\n"))
            self.assertEqual(list(written.parent.glob(f".{written.name}.*.tmp")), [])
            self.assertNotIn(r"Auto\PP", str(written))
            self.assertNotIn("ResQ Demo", str(written))

    def test_plan_signatures_detect_stale_observations(self):
        row = sync.build_sync_plan(
            [_item(timestamp=200)],
            [_item(timestamp=100)],
        )[0]
        original = sync.plan_signature(row)
        unchanged = copy.deepcopy(original)
        changed = copy.deepcopy(original)
        changed["resq"]["modified_timestamp"] = 101

        self.assertTrue(sync.signatures_equal(original, unchanged))
        self.assertFalse(sync.signatures_equal(original, changed))

        # Inside a write batch only the side being written from has to hold
        # still; the target side is re-stamped by the batch's earlier writes.
        self.assertTrue(sync.write_signatures_equal(original, changed, source_side="arcrho"))
        self.assertFalse(sync.write_signatures_equal(original, changed, source_side="resq"))
        renamed = copy.deepcopy(original)
        renamed["resq"]["dataset_type"] = "Other"
        self.assertFalse(sync.write_signatures_equal(original, renamed, source_side="arcrho"))
        with self.assertRaises(ValueError):
            sync.write_signatures_equal(original, changed, source_side="elsewhere")

        recorded_state = sync.record_synced_items(
            sync.empty_sync_state("Demo", r"Auto\PP", "ResQ Demo"),
            ["Paid Loss"],
            [_item(timestamp=200)],
            [_item(timestamp=100)],
            synced_at="2026-08-12T12:00:00+00:00",
        )
        baselined_row = sync.build_sync_plan(
            [_item(timestamp=200)],
            [_item(timestamp=100)],
            recorded_state,
        )[0]
        self.assertFalse(
            sync.signatures_equal(original, sync.plan_signature(baselined_row))
        )


if __name__ == "__main__":
    unittest.main()
