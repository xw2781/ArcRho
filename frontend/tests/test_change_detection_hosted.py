"""Change detection runs on the server host.

An open window's fingerprint poll, the writer it names once the fingerprint
moved, and the Project Instance table's index signature are Gateway reads: the
server stats its own disk, which a mapped drive's metadata cache cannot make
stale. When the server cannot be asked the answer is "unknown", never an
error, and a Client PC never stats the share instead.
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
for path in (FRONTEND_ROOT, REPOSITORY_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api import config as api_config  # noqa: E402
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.schemas.object_change_watch import ObjectChangeFingerprintRequest  # noqa: E402
from app_server.services import (  # noqa: E402
    dataset_instance_index_service,
    user_identity_service,
    workspace_read_client,
)

dataset_router = importlib.import_module("app_server.api.dataset_router")
watch_router = importlib.import_module("app_server.api.object_change_watch_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
PROJECT = "Demo Project"
RC = "NJ\\Auto"
METHOD = "Paid DFM"
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}
READ_KINDS = ("object_change_fingerprint", "object_change_attribution", "dataset_index_signature")


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


class ChangeDetectionHostedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        projects = self.root / "projects"
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        env.update({api_config.SERVER_ROOT_ENV: str(self.root), "USERNAME": "alice"})
        self.kinds: list[str] = []
        self.gateway_failure: Exception | None = None
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "PROJECT_SETTINGS_DIR", str(projects)),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(
                workspace_read_client,
                "cached_gateway_capabilities",
                return_value={"workspace_read_kinds": list(READ_KINDS)},
            ),
            patch.object(workspace_read_client, "post_signed_json", side_effect=self._gateway),
            patch.object(workspace_read_client, "_log"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

        (projects / PROJECT).mkdir(parents=True)
        folders = dataset_instance_index_service._folder_paths(PROJECT, RC)
        for name in ("datasets", "methods", "sidecars"):
            Path(folders[name]).mkdir(parents=True, exist_ok=True)
        self.sidecar = Path(folders["sidecars"]) / "Paid Ultimate.json"
        _write_json(self.sidecar, {
            "dataset_name": "Paid Ultimate",
            "source_kind": "method",
            "method_type": "DFM",
            "method_name": METHOD,
            "audit_log": [{"user": "Bob", "action": "Update", "timestamp": "2026-09-27T07:00:00Z"}],
        })
        _write_json(Path(folders["methods"]) / f"DFM@{METHOD}.json", {"method_metadata": {}})
        self.index = Path(dataset_instance_index_service._reserving_class_dir(PROJECT, RC)) / "index.json"
        _write_json(self.index, {"datasets": []})

    def _server_process(self):
        return patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: str(self.root)})

    def _gateway(self, gateway_config, path, request_payload, *, timeout):
        """Run the request as the Gateway does: the registered service, as the signed user."""

        if self.gateway_failure is not None:
            raise self.gateway_failure
        request = json.loads(json.dumps(request_payload))
        self.kinds.append(request["ReadKind"])
        spec = WORKSPACE_READ_KINDS[request["ReadKind"]]
        function = getattr(importlib.import_module(f"app_server.services.{spec.module}"), spec.function)
        with self._server_process(), user_identity_service.acting_identity(request["UserName"]):
            answer = jsonable_encoder(function(**request["Kwargs"]))
        return answer, str(self.root), 0

    def _identity(self) -> ObjectChangeFingerprintRequest:
        return ObjectChangeFingerprintRequest(
            project_name=PROJECT,
            reserving_class=RC,
            kind="method",
            name=METHOD,
            method_type="DFM",
            output_dataset="Paid Ultimate",
        )

    def _reads(self):
        return [
            ("object_change_fingerprint", lambda: watch_router.get_object_change_fingerprint(self._identity())),
            ("object_change_attribution", lambda: watch_router.get_object_change_attribution(self._identity())),
            ("dataset_index_signature", lambda: dataset_router.get_cached_dataset_index_signature(PROJECT, RC)),
        ]

    def test_every_kind_names_a_service_that_takes_its_arguments(self) -> None:
        for kind in READ_KINDS:
            with self.subTest(kind):
                spec = WORKSPACE_READ_KINDS[kind]
                module = importlib.import_module(f"app_server.services.{spec.module}")
                signature = inspect.signature(getattr(module, spec.function))
                signature.bind(**{name: "x" for name in spec.required})
                signature.bind(**{name: "x" for name in spec.allowed})

    def test_each_read_answers_the_same_through_the_gateway_as_on_the_server(self) -> None:
        for kind, route in self._reads():
            with self.subTest(route=kind):
                with self._server_process():
                    local = jsonable_encoder(route())
                self.kinds.clear()
                hosted = route()

                self.assertEqual(self.kinds, [kind])
                self.assertEqual(hosted, local)
                self.assertNotIn("unknown", hosted)

    def test_a_server_write_moves_the_fingerprint_the_client_sees(self) -> None:
        before = watch_router.get_object_change_fingerprint(self._identity())["token"]
        _write_json(self.sidecar, {"dataset_name": "Paid Ultimate", "rewritten": True})
        after = watch_router.get_object_change_fingerprint(self._identity())["token"]
        self.assertNotEqual(before, after)
        self.assertEqual(self.kinds, ["object_change_fingerprint"] * 2)

    def test_without_the_gateway_every_read_answers_unknown_and_stats_nothing(self) -> None:
        cases = {
            "disabled": patch.object(config, "load_gateway_config", return_value={"enabled": False}),
            "unreachable": patch.object(workspace_read_client, "cached_gateway_capabilities", return_value=None),
        }
        for label, gateway_patch in cases.items():
            for kind, route in self._reads():
                with self.subTest(gateway=label, route=kind), gateway_patch, \
                        patch.object(os, "stat", side_effect=AssertionError("stat on a Client PC")):
                    answer = route()
                    self.assertIs(answer["unknown"], True)
                    self.assertIs(answer["ok"], True)
        self.assertEqual(self.kinds, [])

    def test_a_dropped_or_slow_gateway_answers_unknown(self) -> None:
        for failure in (
            workspace_read_client.GatewayTransportFailure("gateway_unreachable"),
            workspace_read_client.GatewayTransportFailure("gateway_timeout", timed_out=True),
        ):
            self.gateway_failure = failure
            for kind, route in self._reads():
                with self.subTest(failure=failure.reason, route=kind):
                    self.assertIs(route()["unknown"], True)

    def test_the_unknown_answers_fit_their_response_shapes(self) -> None:
        with patch.object(config, "load_gateway_config", return_value={"enabled": False}):
            fingerprint = watch_router.get_object_change_fingerprint(self._identity())
            attribution = watch_router.get_object_change_attribution(self._identity())
            signature = dataset_router.get_cached_dataset_index_signature(PROJECT, RC)
        schemas = importlib.import_module("app_server.schemas.object_change_watch")
        schemas.ObjectChangeFingerprintResponse(**fingerprint)
        schemas.ObjectChangeAttributionResponse(**attribution)
        self.assertEqual(fingerprint["token"], "")
        self.assertEqual(attribution["attribution"]["user"], "")
        self.assertEqual(attribution["attribution"]["subject"], "method")
        self.assertEqual(signature["signature"], "")

    def test_a_refusal_from_the_read_itself_is_not_unknown(self) -> None:
        with self.assertRaises(HTTPException) as refused:
            watch_router.get_object_change_fingerprint(
                ObjectChangeFingerprintRequest(
                    project_name=PROJECT, reserving_class=RC, kind="method", name=METHOD, method_type="Nope",
                )
            )
        self.assertEqual(refused.exception.status_code, 400)

    def test_a_server_process_reads_its_own_disk(self) -> None:
        with self._server_process(), patch.object(config, "load_gateway_config", return_value={"enabled": False}):
            for kind, route in self._reads():
                with self.subTest(route=kind):
                    self.assertNotIn("unknown", jsonable_encoder(route()))
        self.assertEqual(self.kinds, [])


if __name__ == "__main__":
    unittest.main()
