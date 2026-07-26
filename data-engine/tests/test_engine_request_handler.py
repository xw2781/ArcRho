from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch


ENGINE_SRC = Path(__file__).resolve().parents[1] / "src"
TEST_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

from arcrho_engine import main as engine_main  # noqa: E402


def _request(**overrides):
    payload = {
        "Function": "ArcRhoTri",
        "ProjectName": "Demo",
        "Path": r"Auto\PP",
        "DatasetName": "Paid Loss",
        "OriginLength": 12,
        "DevelopmentLength": 12,
        "Cumulative": True,
        "Transposed": False,
        "Calendar": False,
        "DataPath": r"E:\ArcRho Server\output.csv",
        "UserName": "tester",
        "RequestId": "request-123",
        "StatusPath": r"E:\ArcRho Server\status.json",
    }
    payload.update(overrides)
    return payload


class EngineRequestHandlerTests(unittest.TestCase):
    def setUp(self):
        TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TMP_ROOT))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_created_and_moved_json_events_use_the_same_processor(self):
        handler = engine_main.RequestHandler()
        handler.process_file = Mock()

        handler.on_created(
            SimpleNamespace(is_directory=False, src_path=r"E:\requests\request-created.json")
        )
        handler.on_moved(
            SimpleNamespace(
                is_directory=False,
                src_path=r"E:\requests\request.tmp",
                dest_path=r"E:\requests\request-moved.json",
            )
        )
        handler.on_created(
            SimpleNamespace(is_directory=False, src_path=r"E:\requests\request.tmp")
        )

        self.assertEqual(
            handler.process_file.call_args_list,
            [
                call(r"E:\requests\request-created.json"),
                call(r"E:\requests\request-moved.json"),
            ],
        )

    def test_request_must_be_claimed_before_project_validation(self):
        handler = engine_main.RequestHandler()
        events = []

        with (
            patch.object(engine_main, "read_json", return_value=_request()),
            patch.object(
                engine_main,
                "safe_remove",
                side_effect=lambda _path: events.append("claim") or False,
            ),
            patch.object(
                engine_main,
                "project_exists",
                side_effect=lambda _name: events.append("validate") or True,
            ),
            patch.object(engine_main, "write_json") as write_status,
        ):
            handler.process_file(r"E:\requests\request.json")

        self.assertEqual(events, ["claim"])
        write_status.assert_not_called()

    def test_status_protocol_is_atomic_optional_and_tracks_success(self):
        handler = engine_main.RequestHandler()
        status_path = Path(self.temp_dir.name) / "job" / "status.json"
        request = _request(StatusPath=str(status_path))

        with (
            patch.object(engine_main, "read_json", return_value=request),
            patch.object(engine_main, "safe_remove", return_value=True),
            patch.object(engine_main, "project_exists", return_value=True),
            patch.object(engine_main, "get_project_table_path", return_value="source.csv"),
            patch.object(engine_main, "UDF_ADASTri") as udf,
            patch.object(engine_main, "debug_mode", 0),
        ):
            handler.process_file(r"E:\requests\request.json")

        payload = json.loads(status_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["request_id"], "request-123")
        self.assertIn("updated_at", payload)
        self.assertNotIn("message", payload)
        self.assertEqual(tuple(status_path.parent.glob("*.tmp")), ())
        udf.assert_called_once_with(request)

        legacy_request = _request()
        legacy_request.pop("RequestId")
        legacy_request.pop("StatusPath")
        with patch.object(engine_main, "write_json") as write_status:
            self.assertTrue(
                engine_main._write_request_status(legacy_request, "processing")
            )
        write_status.assert_not_called()

    def test_processing_status_is_written_immediately_after_claim(self):
        handler = engine_main.RequestHandler()
        events = []
        request = _request()

        def record_status(_path, payload):
            events.append(payload["status"])
            return True

        with (
            patch.object(engine_main, "read_json", return_value=request),
            patch.object(
                engine_main,
                "safe_remove",
                side_effect=lambda _path: events.append("claim") or True,
            ),
            patch.object(engine_main, "write_json", side_effect=record_status),
            patch.object(
                engine_main,
                "project_exists",
                side_effect=lambda _name: events.append("validate") or True,
            ),
            patch.object(engine_main, "get_project_table_path", return_value="source.csv"),
            patch.object(engine_main, "UDF_ADASTri"),
            patch.object(engine_main, "debug_mode", 0),
        ):
            handler.process_file(r"E:\requests\request.json")

        self.assertEqual(events, ["claim", "processing", "validate", "success"])

    def test_status_aware_request_stops_when_processing_marker_cannot_be_written(self):
        handler = engine_main.RequestHandler()

        with (
            patch.object(engine_main, "read_json", return_value=_request()),
            patch.object(engine_main, "safe_remove", return_value=True),
            patch.object(engine_main, "_write_request_status", return_value=False),
            patch.object(engine_main, "project_exists") as project_exists,
            patch.object(engine_main, "UDF_ADASTri") as udf,
        ):
            handler.process_file(r"E:\requests\request.json")

        project_exists.assert_not_called()
        udf.assert_not_called()

    def test_all_worker_error_branches_publish_terminal_status_and_legacy_csv(self):
        scenarios = (
            (
                "project_missing",
                {},
                {"project_exists": False},
                "(project not found: Demo)",
                [["(project not found: Demo)"]],
            ),
            (
                "configuration_refresh",
                {},
                {
                    "project_config_version": True,
                    "config_error": engine_main.DataProcessingConfigurationError("bad config"),
                },
                "(data processing configuration error: bad config)",
                [["(data processing configuration error: bad config)"]],
            ),
            (
                "invalid_function",
                {"Function": "NotAFunction"},
                {},
                "(invalid function name)",
                [["(invalid function name)"]],
            ),
            (
                "processing_rules",
                {},
                {"udf_error": engine_main.DataProcessingRulesError("bad rules")},
                "(data processing rules error: bad rules)",
                [["(data processing rules error: bad rules)"]],
            ),
            (
                "processing_configuration",
                {},
                {
                    "udf_error": engine_main.DataProcessingConfigurationError(
                        "bad processing config"
                    )
                },
                "(data processing configuration error: bad processing config)",
                [["(data processing configuration error: bad processing config)"]],
            ),
            (
                "project_settings",
                {},
                {"udf_error": engine_main.ProjectSettingsError("dates missing")},
                "project settings not defined: dates missing",
                [["project settings not defined"]],
            ),
            (
                "unexpected",
                {},
                {"udf_error": RuntimeError("boom")},
                "(error: BOOM)",
                [[0]],
            ),
        )

        for name, request_overrides, behavior, message, csv_rows in scenarios:
            with self.subTest(name=name):
                handler = engine_main.RequestHandler()
                request = _request(**request_overrides)
                statuses = []
                csv_calls = []

                def record_status(_path, payload):
                    statuses.append(payload)
                    return True

                project_config = (
                    {"Demo - Version": "old"}
                    if behavior.get("project_config_version")
                    else {}
                )
                config_error = behavior.get("config_error")
                config_probe = (
                    Mock(side_effect=config_error)
                    if config_error is not None
                    else Mock(return_value="old")
                )

                with (
                    patch.object(engine_main, "read_json", return_value=request),
                    patch.object(engine_main, "safe_remove", return_value=True),
                    patch.object(
                        engine_main,
                        "project_exists",
                        return_value=behavior.get("project_exists", True),
                    ),
                    patch.object(
                        engine_main,
                        "get_project_table_path",
                        return_value="source.csv",
                    ),
                    patch.object(engine_main, "write_json", side_effect=record_status),
                    patch.object(
                        engine_main,
                        "write_lists_to_csv",
                        side_effect=lambda path, rows: csv_calls.append((path, rows)),
                    ),
                    patch.object(
                        engine_main,
                        "UDF_ADASTri",
                        side_effect=behavior.get("udf_error"),
                    ),
                    patch.object(
                        engine_main,
                        "_get_vps_last_modified_time",
                        config_probe,
                    ),
                    patch.dict(engine_main.PROJECT_CONFIG, project_config, clear=True),
                    patch.object(engine_main, "debug_mode", 0),
                ):
                    handler.process_file(r"E:\requests\request.json")

                self.assertEqual(
                    [payload["status"] for payload in statuses],
                    ["processing", "error"],
                )
                self.assertEqual(statuses[-1]["request_id"], "request-123")
                self.assertEqual(statuses[-1]["message"], message)
                self.assertEqual(csv_calls, [(request["DataPath"], csv_rows)])

    def test_error_status_survives_error_csv_write_failure(self):
        handler = engine_main.RequestHandler()
        statuses = []

        with (
            patch.object(engine_main, "read_json", return_value=_request()),
            patch.object(engine_main, "safe_remove", return_value=True),
            patch.object(engine_main, "project_exists", return_value=False),
            patch.object(
                engine_main,
                "write_lists_to_csv",
                side_effect=PermissionError("output locked"),
            ),
            patch.object(
                engine_main,
                "write_json",
                side_effect=lambda _path, payload: statuses.append(payload) or True,
            ),
            patch.object(engine_main, "debug_mode", 0),
        ):
            handler.process_file(r"E:\requests\request.json")

        self.assertEqual([item["status"] for item in statuses], ["processing", "error"])
        self.assertIn("failed to write error CSV", statuses[-1]["message"])

    def test_monitor_removes_heartbeat_when_observer_thread_dies(self):
        observer = Mock()
        observer.is_alive.return_value = False

        with (
            patch.object(engine_main, "Observer", return_value=observer),
            patch.object(engine_main, "remove_old_instances"),
            patch.object(engine_main, "write_json", return_value=True),
            patch.object(engine_main, "_remove_instance_heartbeat") as remove_heartbeat,
        ):
            engine_main.start_monitoring(r"E:\ArcRho Server\requests")

        observer.schedule.assert_called_once()
        observer.start.assert_called_once_with()
        remove_heartbeat.assert_called_once_with()
        observer.join.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
