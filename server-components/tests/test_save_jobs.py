from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_COMPONENTS_SRC = REPO_ROOT / "server-components" / "src"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
TESTS_DIR = Path(__file__).resolve().parent
for path in (SERVER_COMPONENTS_SRC, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from fastapi import HTTPException

from arcrho_engine_save_contract import (
    build_save_job_request,
    claim_save_job,
    read_save_job_result,
    read_save_job_status,
    save_job_claim_path,
    save_job_request_path,
    write_save_job_status,
)
from arcrho_engine import save_jobs


@contextmanager
def _noop_context():
    yield


def _identity_stub(bound: list):
    """Stand in for the canonical acting-identity binding.

    ``bound`` holds the identity only while it is in scope, so a save can
    assert it ran *inside* the binding rather than merely next to it.
    """

    @contextmanager
    def acting_identity(login_name, display_name=""):
        identity = {
            "login_name": str(login_name or "").strip(),
            "display_name": str(display_name or "").strip()
            or str(login_name or "").strip(),
        }
        bound.append(identity)
        try:
            yield identity
        finally:
            bound.pop()

    return SimpleNamespace(acting_identity=acting_identity)


def _fake_app_server(save_function, save_plan_service=None, bound_identities=None):
    fake_services = types.ModuleType("app_server.services")
    fake_services.dfm_service = SimpleNamespace(save_dfm_method=save_function)
    fake_services.dependent_propagation_service = SimpleNamespace(
        suspended_reserving_class_hold_check=_noop_context,
        inline_engine_propagation=_noop_context,
    )
    fake_services.save_plan_service = save_plan_service or SimpleNamespace()
    fake_services.user_identity_service = _identity_stub(
        bound_identities if bound_identities is not None else []
    )
    fake_app_server = types.ModuleType("app_server")
    fake_app_server.services = fake_services
    return {
        "app_server": fake_app_server,
        "app_server.services": fake_services,
        "app_server.services.dfm_service": fake_services.dfm_service,
        "app_server.services.save_plan_service": fake_services.save_plan_service,
        "app_server.services.user_identity_service": fake_services.user_identity_service,
    }


class HostedSaveJobTests(unittest.TestCase):
    REQUEST_ID = "feedfacefeedfacefeedfacefeedface"

    def setUp(self) -> None:
        logs_tmp = TESTS_DIR / "logs" / "tmp"
        logs_tmp.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(logs_tmp))
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _publish_request(self, **overrides) -> tuple[Path, dict]:
        overrides.setdefault("user_name", "tester")
        request = build_save_job_request(
            request_id=self.REQUEST_ID,
            save_kind="dfm_method",
            project_name="Demo",
            path="HPPREF\\HOL",
            args=["Demo", "HPPREF\\HOL", {"json_format": "dfm"}],
            kwargs={"notes": "note"},
            **overrides,
        )
        path = save_job_request_path(self.root, self.REQUEST_ID)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(request), encoding="utf-8")
        return path, request

    def test_claimed_save_runs_the_service_and_publishes_the_result(self) -> None:
        calls: list[tuple] = []

        def fake_save(*args, **kwargs):
            calls.append((args, kwargs))
            return {"ok": True, "propagation": {"status": "completed", "ok": True}}

        path, request = self._publish_request()
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(fake_save)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertTrue(completed)
        self.assertFalse(path.exists(), "the request must be claimed by delete")
        self.assertEqual(
            calls, [(("Demo", "HPPREF\\HOL", {"json_format": "dfm"}), {"notes": "note"})]
        )
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "success")
        result = read_save_job_result(self.root, self.REQUEST_ID)
        self.assertEqual(result["propagation"]["status"], "completed")
        self.assertEqual(status["response"], result)

    def test_the_log_times_each_walk_stage_the_service_reports(self) -> None:
        progress_hooks: list = []

        @contextmanager
        def inline_save_progress(publisher):
            progress_hooks.append(publisher)
            yield

        def fake_save(*args, **kwargs):
            report = progress_hooks[-1]
            for stage in ("marking", "dfm", "dfm", "index"):
                report(stage, 0, 0, stage)
            return {
                "ok": True,
                "propagation": {"status": "completed", "ok": True,
                                "refreshed_datasets": ["C 30 - Ultimate"]},
            }

        modules = _fake_app_server(fake_save)
        modules["app_server.services"].dependent_propagation_service.inline_save_progress = (
            inline_save_progress
        )
        path, request = self._publish_request()
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, modules),
        ):
            self.assertTrue(save_jobs.process_hosted_save_request(self.root, path, request))

        log_text = (self.root / "runtime" / "logs" / "hosted_saves.log").read_text(
            encoding="utf-8"
        )
        success_line = next(line for line in log_text.splitlines() if " success in " in line)
        self.assertIn("walk refreshed 1: C 30 - Ultimate; stages: before walk ", success_line)
        self.assertEqual(
            success_line.count(", dfm "), 1, "a stage's repeated progress calls are one mark"
        )
        self.assertIn(", index ", success_line)
        self.assertIn("; publish ", success_line)

    def test_the_claim_marker_admits_exactly_one_executor(self) -> None:
        # Five Engine instances race every request; the exclusive-create
        # marker is the arbiter, so a second claim for the same id loses no
        # matter how the queue file itself was observed or handled.
        self.assertTrue(claim_save_job(self.root, self.REQUEST_ID))
        self.assertFalse(claim_save_job(self.root, self.REQUEST_ID))

    def test_a_duplicate_execution_is_refused_by_the_claim(self) -> None:
        # The queue file reappearing (a watcher re-offer, a share hiccup)
        # must not run the save twice: the first claim's marker refuses it.
        def fake_save(*args, **kwargs):
            return {"ok": True}

        path, request = self._publish_request()
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(fake_save)),
        ):
            self.assertTrue(
                save_jobs.process_hosted_save_request(self.root, path, request)
            )
            # Re-create the queue file as a duplicate delivery would.
            path.write_text(json.dumps(request), encoding="utf-8")
            self.assertFalse(
                save_jobs.process_hosted_save_request(self.root, path, request)
            )
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "success")

    def test_a_late_error_never_overwrites_a_terminal_success(self) -> None:
        # Production once saw a duplicate run's 409 replace the success the
        # client was about to read; a terminal status is now written once.
        def fake_save(*args, **kwargs):
            return {"ok": True}

        path, request = self._publish_request()
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(fake_save)),
        ):
            self.assertTrue(
                save_jobs.process_hosted_save_request(self.root, path, request)
            )
            # A rogue duplicate bypassing the claim still cannot demote the
            # published outcome.
            save_job_claim_path(self.root, self.REQUEST_ID).unlink()
            path.write_text(json.dumps(request), encoding="utf-8")

            def conflicting_save(*args, **kwargs):
                raise HTTPException(409, "changed on disk")

            with patch.dict(sys.modules, _fake_app_server(conflicting_save)):
                self.assertFalse(
                    save_jobs.process_hosted_save_request(self.root, path, request)
                )
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "success")

    def test_the_save_runs_as_the_user_who_submitted_it(self) -> None:
        # Instances run under their own service profiles, so without this the
        # sidecar would name whichever instance claimed the request.
        bound: list = []
        seen: list = []

        def fake_save(*_args, **_kwargs):
            seen.append(list(bound))
            return {"ok": True}

        path, request = self._publish_request(
            user_name="xwei", user_display_name="Wei, Xiao"
        )
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(fake_save, bound_identities=bound)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertTrue(completed)
        self.assertEqual(
            seen, [[{"login_name": "xwei", "display_name": "Wei, Xiao"}]]
        )
        self.assertEqual(bound, [], "the binding must not outlive the save")

    def test_a_request_without_a_display_name_binds_the_login_to_resolve(self) -> None:
        # A producer that predates UserDisplayName still identifies its user;
        # the canonical binding resolves that login through the username index.
        bound: list = []
        seen: list = []

        def fake_save(*_args, **_kwargs):
            seen.append(list(bound))
            return {"ok": True}

        path, request = self._publish_request(user_name="xwei")
        request.pop("UserDisplayName")
        path.write_text(json.dumps(request), encoding="utf-8")
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(fake_save, bound_identities=bound)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertTrue(completed)
        self.assertEqual(seen, [[{"login_name": "xwei", "display_name": "xwei"}]])

    def test_service_http_exceptions_keep_their_status_codes(self) -> None:
        def conflicting_save(*_args, **_kwargs):
            raise HTTPException(409, "DFM changed on disk; reload it before saving.")

        path, request = self._publish_request()
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(conflicting_save)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertFalse(completed)
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["status_code"], 409)
        self.assertIn("reload it before saving", status["message"])
        self.assertIsNone(read_save_job_result(self.root, self.REQUEST_ID))

    def test_contract_invalid_request_is_dropped_with_a_rejection(self) -> None:
        path, request = self._publish_request()
        request = {**request, "SaveKind": "not_a_kind"}
        path.write_text(json.dumps(request), encoding="utf-8")
        completed = save_jobs.process_hosted_save_request(self.root, path, request)
        self.assertFalse(completed)
        self.assertFalse(path.exists())
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["status_code"], 400)

    def test_busy_reserving_class_reports_423_instead_of_waiting_forever(self) -> None:
        from arcrho_dependent_propagation_contract import acquire_reserving_class_lease

        holder = acquire_reserving_class_lease(self.root, "Demo", "HPPREF\\HOL")
        self.assertIsNotNone(holder)
        path, request = self._publish_request()
        try:
            with (
                patch.object(save_jobs, "configure_canonical_runtime"),
                patch.object(save_jobs, "SAVE_JOB_LEASE_WAIT_SECONDS", 0.5),
                patch.dict(sys.modules, _fake_app_server(lambda *a, **k: {"ok": True})),
            ):
                completed = save_jobs.process_hosted_save_request(
                    self.root, path, request
                )
        finally:
            from arcrho_dependent_propagation_contract import (
                release_reserving_class_lease,
            )

            release_reserving_class_lease(holder)
        self.assertFalse(completed)
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["status_code"], 423)


class HostedSavePlanJobTests(unittest.TestCase):
    """The plan half of the two-step save, and the commit's staleness recheck."""

    REQUEST_ID = "0bad0bad0bad0bad0bad0bad0bad0bad"

    def setUp(self) -> None:
        logs_tmp = TESTS_DIR / "logs" / "tmp"
        logs_tmp.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(logs_tmp))
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _publish(self, **overrides) -> tuple[Path, dict]:
        request = build_save_job_request(
            request_id=self.REQUEST_ID,
            save_kind="dfm_method",
            project_name="Demo",
            path="HPPREF\\HOL",
            args=["Demo", "HPPREF\\HOL", {"json_format": "dfm"}],
            kwargs={"notes": "note"},
            user_name="tester",
            **overrides,
        )
        path = save_job_request_path(self.root, self.REQUEST_ID)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(request), encoding="utf-8")
        return path, request

    def test_plan_publishes_the_reachable_dependents_without_saving(self) -> None:
        saves: list[tuple] = []
        plan = {
            "ok": True,
            "dependents": [{"dataset_name": "Ultimate Loss", "kind": "Calculated dataset"}],
            "dependent_count": 1,
            "fingerprint": "abc123",
        }
        planner = SimpleNamespace(build_save_plan=lambda *a, **k: plan)

        path, request = self._publish(mode="plan")
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(lambda *a, **k: saves.append(a), planner)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertTrue(completed)
        self.assertEqual(saves, [], "a plan must never run the save")
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "success")
        self.assertEqual(status["response"], plan)
        self.assertEqual(read_save_job_result(self.root, self.REQUEST_ID), plan)

    def test_plan_never_waits_for_the_reserving_class_lease(self) -> None:
        from arcrho_dependent_propagation_contract import (
            acquire_reserving_class_lease,
            release_reserving_class_lease,
        )

        # A plan reads only, so an open confirmation dialog must not queue
        # behind an unrelated walk that already owns the class.
        holder = acquire_reserving_class_lease(self.root, "Demo", "HPPREF\\HOL")
        self.assertIsNotNone(holder)
        planner = SimpleNamespace(
            build_save_plan=lambda *a, **k: {"ok": True, "dependents": [], "dependent_count": 0, "fingerprint": "x"}
        )
        path, request = self._publish(mode="plan")
        try:
            with (
                patch.object(save_jobs, "configure_canonical_runtime"),
                patch.dict(sys.modules, _fake_app_server(lambda *a, **k: {"ok": True}, planner)),
            ):
                completed = save_jobs.process_hosted_save_request(self.root, path, request)
        finally:
            release_reserving_class_lease(holder)

        self.assertTrue(completed)
        self.assertEqual(read_save_job_status(self.root, self.REQUEST_ID)["status"], "success")

    def test_commit_with_a_matching_fingerprint_runs_the_save(self) -> None:
        saves: list[tuple] = []
        planner = SimpleNamespace(
            plan_fingerprint_matches=lambda *a, **k: (True, "abc123")
        )

        def fake_save(*args, **kwargs):
            saves.append((args, kwargs))
            return {"ok": True}

        path, request = self._publish(plan_fingerprint="abc123")
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(fake_save, planner)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertTrue(completed)
        self.assertEqual(len(saves), 1)
        self.assertEqual(read_save_job_status(self.root, self.REQUEST_ID)["status"], "success")

    def test_commit_refuses_409_when_the_reviewed_plan_went_stale(self) -> None:
        saves: list[tuple] = []
        planner = SimpleNamespace(
            plan_fingerprint_matches=lambda *a, **k: (False, "different")
        )

        path, request = self._publish(plan_fingerprint="abc123")
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(lambda *a, **k: saves.append(a), planner)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertFalse(completed)
        self.assertEqual(saves, [], "a stale plan must not reach the save")
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["status_code"], 409)
        self.assertIn("changed while", status["message"])

    def test_commit_without_a_fingerprint_skips_the_recheck(self) -> None:
        def exploding_recheck(*_args, **_kwargs):
            raise AssertionError("a commit with no reviewed plan must not recheck")

        saves: list[tuple] = []
        planner = SimpleNamespace(plan_fingerprint_matches=exploding_recheck)
        path, request = self._publish()
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(lambda *a, **k: saves.append(a) or {"ok": True}, planner)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertTrue(completed)
        self.assertEqual(len(saves), 1)


class SaveJobContractModeTests(unittest.TestCase):
    def test_a_request_written_before_two_step_saves_reads_as_a_commit(self) -> None:
        from arcrho_engine_save_contract import validate_save_job_request

        legacy = {
            "Function": "ArcRhoHostedSave",
            "ContractVersion": 1,
            "RequestId": "a" * 32,
            "SaveKind": "dataset_sidecar",
            "ProjectName": "Demo",
            "Path": "HPPREF\\HOL",
            "Args": [],
            "Kwargs": {},
            "UserName": "tester",
        }
        normalized = validate_save_job_request(legacy)
        self.assertEqual(normalized["Mode"], "commit")
        self.assertEqual(normalized["PlanFingerprint"], "")
        # No display name to trust: the Engine resolves the login itself.
        self.assertEqual(normalized["UserDisplayName"], "")

    def test_a_plan_may_not_carry_a_reviewed_fingerprint(self) -> None:
        from arcrho_engine_save_contract import SaveJobContractError

        with self.assertRaises(SaveJobContractError):
            build_save_job_request(
                request_id="b" * 32,
                save_kind="dataset_sidecar",
                project_name="Demo",
                path="HPPREF\\HOL",
                args=[],
                kwargs={},
                mode="plan",
                plan_fingerprint="abc123",
            )

    def test_an_unknown_mode_is_rejected(self) -> None:
        from arcrho_engine_save_contract import SaveJobContractError

        with self.assertRaises(SaveJobContractError):
            build_save_job_request(
                request_id="c" * 32,
                save_kind="dataset_sidecar",
                project_name="Demo",
                path="HPPREF\\HOL",
                args=[],
                kwargs={},
                mode="dry-run",
            )


class InlineWalkSummaryTests(unittest.TestCase):
    """The inline walk leaves no queue record, so the save log is the only one."""

    def test_method_save_names_what_the_walk_refreshed(self) -> None:
        summary = save_jobs._inline_walk_summary({
            "propagation": {"ok": True, "status": "completed",
                            "refreshed_datasets": ["C 30 - Ultimate", "C 31 - IBNR"]},
        })
        self.assertEqual(summary, "walk refreshed 2: C 30 - Ultimate, C 31 - IBNR")

    def test_dataset_sidecar_save_reports_its_nested_payload(self) -> None:
        summary = save_jobs._inline_walk_summary({
            "data": {"calculated_updates": {"ok": True, "status": "completed",
                                            "refreshed_datasets": ["C 30 - Ultimate"]}},
        })
        self.assertEqual(summary, "walk refreshed 1: C 30 - Ultimate")

    def test_dataset_sidecar_save_reports_its_top_level_payload(self) -> None:
        # ``dataset_service.save_dataset_sidecar`` returns ``calculated_updates``
        # at the top of its own dict; the ``data`` wrapper is the HTTP client's.
        # A save whose walk failed used to log only "success" with no reason.
        summary = save_jobs._inline_walk_summary({
            "ok": True,
            "dataset_name": "Net Loss--Incurred Adjusted*",
            "calculated_updates": {
                "ok": False, "status": "completed",
                "refreshed_datasets": ["F 23 C - Adjusted Incurred DFM"],
                "message": "Method refresh failure(s): F 41 A - BF Incurred: Prior vector refresh failed",
            },
        })
        self.assertEqual(
            summary,
            "walk refreshed 1: F 23 C - Adjusted Incurred DFM; walk FAILED: "
            "Method refresh failure(s): F 41 A - BF Incurred: Prior vector refresh failed",
        )

    def test_a_walk_that_touched_nothing_still_records_that(self) -> None:
        self.assertEqual(
            save_jobs._inline_walk_summary({"propagation": {"ok": True, "refreshed_datasets": []}}),
            "walk refreshed 0",
        )

    def test_an_unchanged_publication_is_distinguished_from_an_empty_walk(self) -> None:
        self.assertEqual(
            save_jobs._inline_walk_summary({"propagation": {"ok": True, "status": "unchanged"}}),
            "walk skipped (publication unchanged)",
        )

    def test_a_failed_walk_keeps_its_reason(self) -> None:
        summary = save_jobs._inline_walk_summary({
            "propagation": {"ok": False, "status": "completed", "refreshed_datasets": [],
                            "message": "Dependent update failed"},
        })
        self.assertEqual(summary, "walk refreshed 0; walk FAILED: Dependent update failed")

    def test_a_long_walk_is_truncated_and_says_so(self) -> None:
        names = [f"C {index}" for index in range(20)]
        summary = save_jobs._inline_walk_summary({
            "propagation": {"ok": True, "refreshed_datasets": names},
        })
        self.assertIn("walk refreshed 20:", summary)
        self.assertIn("(+8 more)", summary)

    def test_an_unexpected_shape_never_raises(self) -> None:
        for response in (None, "text", {}, {"propagation": "not a mapping"},
                         {"data": {"calculated_updates": None}},
                         {"propagation": {"refreshed_datasets": "not a list"}}):
            self.assertEqual(save_jobs._inline_walk_summary(response), "")


class InlineWalkTimingTests(unittest.TestCase):
    """A stalled stage must name itself in the log, not hide inside one total."""

    def test_each_stage_lasts_until_the_next_one_starts(self) -> None:
        marks = [("marking", 10.5), ("dfm", 10.5), ("index", 11.7)]
        self.assertEqual(
            save_jobs._walk_stage_timing(marks, started_at=10.0, finished_at=12.0),
            "stages: before walk 0.5s, marking 0.0s, dfm 1.2s, index 0.3s",
        )

    def test_a_save_without_a_walk_reports_no_stages(self) -> None:
        self.assertEqual(save_jobs._walk_stage_timing([], 1.0, 2.0), "")


if __name__ == "__main__":
    unittest.main()
