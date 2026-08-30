from __future__ import annotations

import importlib
import inspect
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
# Every test temp directory lives under one gitignored folder at the
# repository root, so a suite that dies before teardown cannot scatter
# tmp folders beside the code.
TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
ENGINE_SOURCE = REPOSITORY_ROOT / "server-components" / "src"
API_SOURCE = REPOSITORY_ROOT / "python-api" / "src"
FRONTEND_ROOT = REPOSITORY_ROOT / "frontend"
for path in (ENGINE_SOURCE, API_SOURCE, FRONTEND_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from fastapi import HTTPException

from arcrho_hosted_save_http_contract import default_gateway_config
from arcrho_workspace_mutation_contract import (
    HTTP_WORKSPACE_MUTATION_KINDS,
    WORKSPACE_MUTATION_CAPABILITY_FIELD,
    WORKSPACE_MUTATION_KINDS,
    WorkspaceMutationContractError,
    build_workspace_mutation_request,
    validate_workspace_mutation_request,
)
from arcrho_gateway import main as gateway_main
from arcrho_gateway import workspace_mutations, workspace_reads
from app_server import config as app_config
from app_server.services import (
    client_save_latency_log_service,
    user_identity_service,
    workspace_mutation_client,
    workspace_read_client,
)


def _request(kind: str = "cached_dataset_delete", **overrides) -> dict:
    kwargs = {
        "project_name": "Demo Project",
        "reserving_class": "PA\\All States\\COL",
        "dataset_names": ["Paid Loss"],
    }
    kwargs.update(overrides)
    return build_workspace_mutation_request(
        request_id="mutation-1",
        mutation_kind=kind,
        kwargs=kwargs,
        user_name="alice",
        user_display_name="Alice Example",
    )


class WorkspaceMutationContractTests(unittest.TestCase):
    def test_every_registered_kind_names_a_real_service_function(self) -> None:
        """The registry is the only table; drift from the services must fail here."""

        for kind, spec in WORKSPACE_MUTATION_KINDS.items():
            module = importlib.import_module(f"app_server.services.{spec.module}")
            function = getattr(module, spec.function)
            parameters = inspect.signature(function).parameters
            for name in spec.required + spec.optional:
                self.assertIn(name, parameters, f"{kind}: {spec.function} lacks {name}")
            for name, parameter in parameters.items():
                if parameter.default is inspect.Parameter.empty and parameter.kind in (
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    inspect.Parameter.KEYWORD_ONLY,
                ):
                    self.assertIn(name, spec.required, f"{kind}: {name} must be required")

    def test_advertised_kinds_are_the_registry(self) -> None:
        self.assertEqual(HTTP_WORKSPACE_MUTATION_KINDS, tuple(sorted(WORKSPACE_MUTATION_KINDS)))

    def test_validation_normalizes_and_trims_the_name_list(self) -> None:
        request = _request(dataset_names=["Paid Loss", "  Selected Ultimate  ", ""])
        self.assertEqual(request["MutationKind"], "cached_dataset_delete")
        self.assertEqual(
            request["Kwargs"]["dataset_names"], ["Paid Loss", "Selected Ultimate"]
        )
        self.assertEqual(request["UserName"], "alice")

    def test_validation_rejects_unknown_kind_and_arguments(self) -> None:
        with self.assertRaises(WorkspaceMutationContractError):
            _request("not_a_mutation")
        with self.assertRaises(WorkspaceMutationContractError):
            _request(refresh=True)
        with self.assertRaises(WorkspaceMutationContractError):
            _request(reserving_class="")

    def test_validation_rejects_a_name_list_that_is_not_a_list(self) -> None:
        """A bare string would otherwise be accepted as one oddly named dataset."""

        with self.assertRaises(WorkspaceMutationContractError):
            _request(dataset_names="Paid Loss")
        with self.assertRaises(WorkspaceMutationContractError):
            _request(dataset_names=[])
        with self.assertRaises(WorkspaceMutationContractError):
            _request(dataset_names=["  "])

    def test_validation_rejects_machine_local_locations(self) -> None:
        with self.assertRaises(WorkspaceMutationContractError):
            _request(reserving_class="E:\\ArcRho Server\\projects\\Demo")
        with self.assertRaises(WorkspaceMutationContractError):
            _request(project_name="CON")

    def test_foreign_payload_is_refused(self) -> None:
        with self.assertRaises(WorkspaceMutationContractError):
            validate_workspace_mutation_request({"Function": "ArcRhoWorkspaceRead"})


class _FakeMutationRuntime:
    """Swap one registered mutation for a fake without touching any workspace."""

    def __init__(self, kind: str, implementation) -> None:
        self.spec = WORKSPACE_MUTATION_KINDS[kind]
        self.module = importlib.import_module(f"app_server.services.{self.spec.module}")
        self.patch = patch.object(self.module, self.spec.function, implementation)

    def __enter__(self):
        self.patch.start()
        return self

    def __exit__(self, *exc) -> None:
        self.patch.stop()


class WorkspaceMutationExecutorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.root = Path(self.temp_dir.name)
        config = default_gateway_config()
        config["host"] = "127.0.0.1"
        config["users"] = {"alice": "alice-secret"}
        gateway_main._write_json_atomic(
            self.root / "config" / "arcrho_gateway.json", config
        )
        self.logged: list[str] = []
        self.executor = workspace_mutations.WorkspaceMutationExecutor(
            self.root,
            load_gateway_config=gateway_main._load_gateway_config,
            log=lambda _root, message: self.logged.append(message),
            ensure_runtime=lambda: None,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_execute_runs_the_registered_service_as_the_requesting_user(self) -> None:
        seen: dict = {}

        def fake_delete(project_name, reserving_class, dataset_names):
            seen.update(
                {
                    "project_name": project_name,
                    "reserving_class": reserving_class,
                    "dataset_names": list(dataset_names),
                    "identity": user_identity_service.get_current_identity(),
                }
            )
            return {"ok": True, "deleted_count": 2, "index": {"ok": True, "files": []}}

        with _FakeMutationRuntime("cached_dataset_delete", fake_delete):
            response = self.executor.execute("alice", _request())

        self.assertEqual(response["deleted_count"], 2)
        self.assertEqual(seen["project_name"], "Demo Project")
        self.assertEqual(seen["reserving_class"], "PA\\All States\\COL")
        self.assertEqual(seen["dataset_names"], ["Paid Loss"])
        self.assertEqual(seen["identity"]["login_name"], "alice")
        self.assertEqual(seen["identity"]["display_name"], "Alice Example")

    def test_structured_refusal_survives_and_only_its_text_is_redacted(self) -> None:
        """The blocked-dependents payload is what the page renders, not a string."""

        def refuse(**_kwargs):
            raise HTTPException(
                409,
                {
                    "error": "dataset_has_dependents",
                    "message": "Blocked while reading E:\\ArcRho Server\\projects\\Demo",
                    "blocked_datasets": [
                        {
                            "dataset_name": "Paid Loss",
                            "dependents": [
                                {"dataset_name": "Paid DFM", "method_type": "DFM"}
                            ],
                        }
                    ],
                },
            )

        with _FakeMutationRuntime("cached_dataset_delete", refuse):
            with self.assertRaises(workspace_reads.WorkspaceReadRefusal) as caught:
                self.executor.execute("alice", _request())

        detail = caught.exception.detail
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIsInstance(detail, dict)
        self.assertEqual(detail["error"], "dataset_has_dependents")
        self.assertNotIn("E:\\", detail["message"])
        self.assertEqual(
            detail["blocked_datasets"],
            [
                {
                    "dataset_name": "Paid Loss",
                    "dependents": [{"dataset_name": "Paid DFM", "method_type": "DFM"}],
                }
            ],
        )

    def test_user_mismatch_and_bad_payload_are_gateway_errors(self) -> None:
        with self.assertRaises(workspace_reads.WorkspaceReadHttpError) as mismatch:
            self.executor.execute("bob", _request())
        self.assertEqual(mismatch.exception.status_code, 403)
        with self.assertRaises(workspace_reads.WorkspaceReadHttpError) as invalid:
            self.executor.execute("alice", {"Function": "ArcRhoWorkspaceMutation"})
        self.assertEqual(invalid.exception.status_code, 400)

    def test_capabilities_advertise_every_registered_kind(self) -> None:
        payload = gateway_main.Gateway(self.root).capabilities()
        self.assertEqual(
            payload[WORKSPACE_MUTATION_CAPABILITY_FIELD],
            list(HTTP_WORKSPACE_MUTATION_KINDS),
        )


class WorkspaceMutationHttpRoundTripTests(unittest.TestCase):
    """The client transport against a live gateway, both ends in this process."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.root = Path(self.temp_dir.name)
        self.server_root = self.root / "server"
        self.client_root = self.root / "client-mapped"
        (self.server_root / "config").mkdir(parents=True)
        config = default_gateway_config()
        config["host"] = "127.0.0.1"
        config["users"] = {"alice": "alice-secret"}
        gateway_main._write_json_atomic(
            self.server_root / "config" / "arcrho_gateway.json", config
        )
        self.gateway = gateway_main.Gateway(self.server_root)
        self.gateway.reads._runtime_ready = True
        self.server = gateway_main.GatewayServer(("127.0.0.1", 0), self.gateway)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.client_config = {
            "enabled": True,
            "url": self.url,
            "user": "alice",
            "secret": "alice-secret",
            "allow_insecure_http": True,
        }
        self.records: list[dict] = []
        self.patches = [
            patch.object(app_config, "load_gateway_config", return_value=self.client_config),
            patch.object(app_config, "get_root_path", return_value=str(self.client_root)),
            patch.object(workspace_read_client, "_is_server_process", return_value=False),
            patch.object(
                client_save_latency_log_service,
                "append_client_read_latency",
                side_effect=lambda record: self.records.append(dict(record)) or True,
            ),
        ]
        for item in self.patches:
            item.start()
        workspace_read_client.reset_capability_cache()

    def tearDown(self) -> None:
        for item in reversed(self.patches):
            item.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        workspace_read_client.reset_capability_cache()
        self.temp_dir.cleanup()

    def _run(self, **overrides):
        kwargs = {
            "project_name": "Demo",
            "reserving_class": "COL",
            "dataset_names": ["Paid Loss"],
        }
        kwargs.update(overrides)
        return workspace_mutation_client.run_workspace_mutation(
            "cached_dataset_delete",
            kwargs,
            local=lambda: self.fail("the mutation must not run locally"),
        )

    def test_delete_runs_on_the_gateway_and_paths_are_rebased(self) -> None:
        server_csv = str(
            self.server_root / "projects" / "Demo" / "data" / "COL" / "datasets" / "Paid Loss.csv"
        )

        def fake_delete(project_name, reserving_class, dataset_names):
            return {
                "ok": True,
                "deleted_count": 1,
                "deleted_files": [{"name": "Paid Loss.csv", "path": server_csv}],
                "index": {
                    "ok": True,
                    "files": [],
                    "folder_paths": {"data": str(self.server_root / "projects" / "Demo")},
                },
            }

        with _FakeMutationRuntime("cached_dataset_delete", fake_delete):
            response = self._run()

        expected_csv = str(
            self.client_root / "projects" / "Demo" / "data" / "COL" / "datasets" / "Paid Loss.csv"
        )
        self.assertEqual(response["deleted_files"][0]["path"], expected_csv)
        self.assertEqual(
            response["index"]["folder_paths"]["data"],
            str(self.client_root / "projects" / "Demo"),
        )
        self.assertEqual(self.records[-1]["transport"], "http_gateway")
        self.assertEqual(self.records[-1]["outcome"], "success")
        self.assertEqual(self.records[-1]["read_kind"], "mutation:cached_dataset_delete")

    def test_blocked_refusal_reaches_the_client_as_an_object(self) -> None:
        """The page switches on `error` and lists `blocked_datasets` as links."""

        blocked = {
            "error": "dataset_has_dependents",
            "message": "'Paid Loss' is used as input by other objects.",
            "blocked_datasets": [
                {
                    "dataset_name": "Paid Loss",
                    "dependents": [{"dataset_name": "Paid DFM", "method_type": "DFM"}],
                }
            ],
        }

        def refuse(**_kwargs):
            raise HTTPException(409, blocked)

        with _FakeMutationRuntime("cached_dataset_delete", refuse):
            with self.assertRaises(HTTPException) as caught:
                self._run()

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail, blocked)
        self.assertEqual(self.records[-1]["transport"], "http_gateway")
        self.assertEqual(self.records[-1]["http_status"], 409)

    def test_kind_not_advertised_runs_locally(self) -> None:
        with patch.object(
            workspace_mutation_client,
            "gateway_supports_mutation_kind",
            return_value=False,
        ):
            response = workspace_mutation_client.run_workspace_mutation(
                "cached_dataset_delete",
                {
                    "project_name": "Demo",
                    "reserving_class": "COL",
                    "dataset_names": ["Paid Loss"],
                },
                local=lambda: {"ok": True, "deleted_count": 0},
            )
        self.assertEqual(response["deleted_count"], 0)
        self.assertEqual(self.records[-1]["transport"], "smb")
        self.assertEqual(self.records[-1]["reason"], "kind_not_advertised")

    def test_an_accepted_request_is_never_re_run_locally(self) -> None:
        """A delete the server may have applied must not be repeated here.

        Reads fall back freely because they change nothing. A mutation whose
        answer was lost after the server had it would, run again locally,
        report on a workspace the first run already changed.
        """

        failure = workspace_read_client.GatewayTransportFailure(
            "gateway_connection_lost", accepted=True
        )
        with patch.object(
            workspace_read_client, "post_signed_json", side_effect=failure
        ):
            with self.assertRaises(HTTPException) as caught:
                self._run()

        self.assertEqual(caught.exception.status_code, 504)
        self.assertIn("Refresh", caught.exception.detail)
        self.assertEqual(self.records[-1]["transport"], "http_gateway")
        self.assertEqual(self.records[-1]["reason"], "gateway_connection_lost")

    def test_a_request_the_contract_refuses_is_answered_by_the_service(self) -> None:
        """Nothing was sent, so the canonical refusal still owns the answer."""

        response = workspace_mutation_client.run_workspace_mutation(
            "cached_dataset_delete",
            {"project_name": "Demo", "reserving_class": "COL", "dataset_names": []},
            local=lambda: {"ok": False, "canonical_refusal": True},
        )
        self.assertEqual(response, {"ok": False, "canonical_refusal": True})
        self.assertEqual(self.records[-1]["transport"], "smb")
        self.assertEqual(self.records[-1]["reason"], "contract_rejected")

    def test_a_failure_before_the_server_could_act_falls_back(self) -> None:
        failure = workspace_read_client.GatewayTransportFailure("gateway_unreachable")
        with patch.object(
            workspace_read_client, "post_signed_json", side_effect=failure
        ):
            response = workspace_mutation_client.run_workspace_mutation(
                "cached_dataset_delete",
                {
                    "project_name": "Demo",
                    "reserving_class": "COL",
                    "dataset_names": ["Paid Loss"],
                },
                local=lambda: {"ok": True, "deleted_count": 3},
            )
        self.assertEqual(response["deleted_count"], 3)
        self.assertEqual(self.records[-1]["transport"], "smb")
        self.assertEqual(self.records[-1]["reason"], "gateway_unreachable")


if __name__ == "__main__":
    unittest.main()
