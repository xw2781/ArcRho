"""Cover the review table the Import and Export ResQ macros both open.

The table used to live inside the Export macro and describe one direction. It
now serves both, so the tests follow the direction rather than the macro.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
if str(_PYTHON_API_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(_PYTHON_API_ROOT / "src"))

from arcrho_api import resq_transfer_review as review  # noqa: E402


def _row(name, *, kind="Dataset", presence="both", newer_side="resq",
         transfer_supported=True, selected=True, **fields):
    row = {
        "id": name.casefold(),
        "key": name.casefold(),
        "name": name,
        "kind": kind,
        "presence": presence,
        "arcrho_timestamp": "2026-08-28 10:00:00",
        "resq_timestamp": "2026-08-28 11:00:00",
        "newer_side": newer_side,
        "transfer_supported": transfer_supported,
        "selected": selected,
        "detail": "",
    }
    row.update(fields)
    return row


def _verdict(changed, *, detail=""):
    """The baseline verdict the Bridge sends with a paired row."""

    return {"changed": changed, "status": changed, "detail": detail}


def _payload(rows, direction, **options):
    return review.transfer_review_payload(
        rows,
        direction=direction,
        title="Transfer",
        accept_label="Go",
        project_name="Demo",
        rc_path=r"Auto\PP",
        connection_name="ResQ Demo",
        class_direction={"arcrho_timestamp": "2026-08-28 10:00:00", "resq_timestamp": "2026-08-28 11:00:00"},
        selection=options.pop("selection", {"names": [], "updated_at": "", "updated_by": ""}),
        **options,
    )


class TransferReviewTableTests(unittest.TestCase):
    def test_the_table_is_tickable_and_carries_one_set_of_columns(self):
        payload = _payload([_row("Paid Loss")], "export")

        self.assertEqual(
            [column["key"] for column in payload["columns"]],
            ["kind", "name", "presence", "arcrho_timestamp", "resq_timestamp",
             "newer", "changed", "plan", "detail"],
        )
        self.assertEqual(payload["acceptLabel"], "Go")
        self.assertEqual(payload["cancelLabel"], "Cancel")
        self.assertEqual(payload["host"], "projectInstance")
        self.assertNotIn("selectable", payload)

    def test_a_row_the_direction_cannot_carry_is_shown_disabled(self):
        payload = _payload(
            [_row("Paid Loss"), _row("Boot", transfer_supported=False, selected=False)], "export"
        )

        self.assertEqual([row["disabled"] for row in payload["rows"]], [False, True])
        self.assertEqual([row["selected"] for row in payload["rows"]], [True, False])

    def test_the_ticked_state_comes_from_the_row_the_bridge_sent(self):
        payload = _payload([_row("Paid Loss"), _row("Reported Loss", selected=False)], "export")

        self.assertEqual([row["selected"] for row in payload["rows"]], [True, False])

    def test_each_side_says_where_the_item_lives(self):
        payload = _payload(
            [
                _row("Paid Loss"),
                _row("ArcRho Only", presence="arcrho", resq_timestamp="", newer_side=""),
                _row("ResQ Only", presence="resq", arcrho_timestamp="", newer_side=""),
            ],
            "import",
        )

        cells = [row["cells"] for row in payload["rows"]]
        self.assertEqual([cell["presence"]["text"] for cell in cells], ["Both", "ArcRho only", "ResQ only"])
        self.assertEqual([cell["arcrho_timestamp"] for cell in cells][2], "-")
        self.assertEqual([cell["resq_timestamp"] for cell in cells][1], "-")
        # An unpaired row has no comparison to report on either column.
        self.assertEqual([cell["newer"]["text"] for cell in cells][1:], ["-", "-"])
        self.assertEqual([cell["changed"]["text"] for cell in cells][1:], ["-", "-"])


class ExportPlanColumnTests(unittest.TestCase):
    def test_the_baseline_decides_the_warning_not_the_newer_timestamp(self):
        payload = _payload(
            [
                _row("Paid Loss", export_review=_verdict("none", detail="Neither side changed.")),
                _row("Reported Loss", export_review=_verdict("arcrho")),
                _row("Case Reserves", export_review=_verdict("resq")),
                _row("Claim Counts", export_review=_verdict("both")),
            ],
            "export",
        )

        cells = [row["cells"] for row in payload["rows"]]
        self.assertEqual([cell["changed"]["text"] for cell in cells], ["None", "ArcRho", "ResQ", "Both"])
        self.assertEqual(
            [cell["plan"]["text"] for cell in cells],
            [
                "Overwrites ResQ copy",
                "Overwrites ResQ copy",
                "Overwrites newer ResQ copy",
                "Overwrites newer ResQ copy",
            ],
        )
        # Every row still carries the plain fact about its two timestamps.
        self.assertEqual({cell["newer"]["text"] for cell in cells}, {"ResQ"})
        self.assertEqual(cells[0]["detail"], "Neither side changed.")

    def test_without_a_baseline_the_timestamps_stand_in(self):
        payload = _payload(
            [_row("Paid Loss"), _row("Reported Loss", newer_side="arcrho")], "export"
        )

        cells = [row["cells"] for row in payload["rows"]]
        self.assertEqual([cell["changed"]["text"] for cell in cells], ["No baseline yet", "No baseline yet"])
        self.assertEqual(
            [cell["plan"]["text"] for cell in cells],
            ["Overwrites newer ResQ copy", "Overwrites ResQ copy"],
        )

    def test_an_item_the_export_cannot_carry_says_so(self):
        payload = _payload([_row("Boot", transfer_supported=False)], "export")

        self.assertEqual(payload["rows"][0]["cells"]["plan"], {"text": "Not exported", "tone": "muted"})


class ImportPlanColumnTests(unittest.TestCase):
    def test_a_resq_only_item_is_added_rather_than_overwritten(self):
        payload = _payload(
            [_row("ResQ Only", presence="resq", arcrho_timestamp="", newer_side="")], "import"
        )

        self.assertEqual(payload["rows"][0]["cells"]["plan"]["text"], "Added to ArcRho")

    def test_overwrite_warns_about_the_arcrho_edit_and_merge_says_it_is_kept(self):
        rows = [_row("Paid Loss", export_review=_verdict("arcrho"))]

        overwriting = _payload(rows, "import", overwrite=True)["rows"][0]["cells"]["plan"]
        merging = _payload(rows, "import", overwrite=False)["rows"][0]["cells"]["plan"]

        self.assertEqual(overwriting, {"text": "Overwrites newer ArcRho copy", "tone": "warn"})
        self.assertEqual(merging, {"text": "Keeps the newer ArcRho copy", "tone": "ok"})

    def test_an_untouched_arcrho_copy_is_simply_overwritten(self):
        payload = _payload([_row("Paid Loss", export_review=_verdict("resq"))], "import", overwrite=True)

        self.assertEqual(payload["rows"][0]["cells"]["plan"]["text"], "Overwrites ArcRho copy")

    def test_an_item_arcrho_cannot_receive_says_so(self):
        payload = _payload(
            [_row("Odd Type", transfer_supported=False, detail="Dataset Type X is not configured in ArcRho.")],
            "import",
        )

        cells = payload["rows"][0]["cells"]
        self.assertEqual(cells["plan"], {"text": "Not imported", "tone": "muted"})
        self.assertEqual(cells["detail"], "Dataset Type X is not configured in ArcRho.")


class TransferReviewSummaryTests(unittest.TestCase):
    def test_the_header_counts_what_can_move_what_is_ticked_and_what_is_at_risk(self):
        payload = _payload(
            [
                _row("Paid Loss", export_review=_verdict("resq")),
                _row("Reported Loss", export_review=_verdict("none")),
                _row("Claim Counts", export_review=_verdict("resq"), selected=False),
                _row("Boot", transfer_supported=False, selected=False),
            ],
            "export",
        )

        summary = payload["summary"]
        self.assertIn("Project: Demo | Reserving class: Auto\\PP | ResQ: ResQ Demo", summary)
        self.assertIn("Compared 4 item(s); 3 can be written to ResQ and 2 are selected", summary)
        self.assertIn("1 carry a ResQ change this run would overwrite", summary)

    def test_the_header_says_where_the_ticked_state_came_from(self):
        empty = _payload([_row("Paid Loss")], "export")["summary"]
        saved = _payload(
            [_row("Paid Loss")],
            "export",
            selection={"names": ["Paid Loss"], "updated_at": "2026-08-29T09:00:00", "updated_by": "ali"},
        )["summary"]

        self.assertIn("No selection has been saved for this reserving class yet", empty)
        self.assertIn("Ticked from the last selection saved for this reserving class by ali", saved)
        self.assertIn("on 2026-08-29T09:00:00.", saved)

    def test_an_import_header_names_arcrho_as_the_side_at_risk(self):
        summary = _payload([_row("Paid Loss", export_review=_verdict("arcrho"))], "import")["summary"]

        self.assertIn("1 can be written to ArcRho", summary)
        self.assertIn("carry an ArcRho change this run would overwrite", summary)


class AcceptedNamesTests(unittest.TestCase):
    def test_the_ticked_ids_come_back_as_the_names_the_request_is_written_with(self):
        rows = [_row("Paid Loss"), _row("Reported Loss"), _row("Claim Counts")]

        names = review.accepted_names(
            rows, {"selectedRowIds": ["reported loss", "paid loss", "  ", "gone"]}
        )

        # The table's own order, not the order the ids arrived in.
        self.assertEqual(names, ["Paid Loss", "Reported Loss"])

    def test_a_snake_case_completion_is_read_the_same_way(self):
        names = review.accepted_names([_row("Paid Loss")], {"selected_row_ids": ["paid loss"]})

        self.assertEqual(names, ["Paid Loss"])

    def test_nothing_ticked_is_an_empty_list_rather_than_everything(self):
        self.assertEqual(review.accepted_names([_row("Paid Loss")], {"selectedRowIds": []}), [])


if __name__ == "__main__":
    unittest.main()
