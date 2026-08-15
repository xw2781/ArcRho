"""Server-hosted execution of allowlisted ``app_server`` workspace reads.

The Save Gateway freezes the same canonical ``python-api/src`` and
``frontend/app_server`` trees the Engine does (``ENGINE_BUNDLED_SOURCES``), so
a registered read runs the exact service function a Client PC would have run
over the mapped drive — here against local disk. The gateway performs no
read-specific work of its own: the request names a kind, the contract maps
the kind to the service, and the service's response goes back verbatim.
"""

from __future__ import annotations

import importlib
import threading
import traceback
from pathlib import Path
from typing import Any, Callable, Mapping

from arcrho_engine.dependent_propagation import configure_canonical_runtime
from arcrho_engine.project_duplication import _redact_machine_paths
from arcrho_hosted_save_http_contract import (
    AUTH_SIGNATURE_HEADER,
    AUTH_TIMESTAMP_HEADER,
    AUTH_USER_HEADER,
    normalize_user,
    verify_request_signature,
)
from arcrho_workspace_read_contract import (
    HTTP_WORKSPACE_READ_KINDS,
    WORKSPACE_READ_KINDS,
    WORKSPACE_READ_PATH,
    WorkspaceReadContractError,
    validate_workspace_read_request,
)


class WorkspaceReadHttpError(Exception):
    """A gateway-layer refusal; the hosted read did not run."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = int(status_code)
        self.detail = str(detail)


class WorkspaceReadRefusal(Exception):
    """The hosted service itself refused; carries its own status and detail."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = int(status_code)
        self.detail = str(detail)


class WorkspaceReadExecutor:
    """Runs registered reads in-process against the gateway's server root."""

    def __init__(
        self,
        root: Path,
        *,
        load_gateway_config: Callable[[Path], Mapping[str, Any]],
        log: Callable[[Path, str], None],
    ) -> None:
        self.root = root.resolve()
        self._load_gateway_config = load_gateway_config
        self._log = log
        self._runtime_lock = threading.Lock()
        self._runtime_ready = False

    def capability_fields(self) -> dict[str, Any]:
        return {"workspace_read_kinds": list(HTTP_WORKSPACE_READ_KINDS)}

    def ensure_runtime(self) -> None:
        """Import the bundled app_server once; safe to call from any thread."""

        if self._runtime_ready:
            return
        with self._runtime_lock:
            if self._runtime_ready:
                return
            configure_canonical_runtime(self.root)
            for spec in WORKSPACE_READ_KINDS.values():
                importlib.import_module(f"app_server.services.{spec.module}")
            self._runtime_ready = True

    def warm_up(self) -> threading.Thread:
        """Load the service stack in the background so the first read is fast."""

        def run() -> None:
            try:
                self.ensure_runtime()
                self._log(self.root, "workspace reads ready")
            except Exception:
                self._log(self.root, f"workspace read warm-up failed\n{traceback.format_exc()}")

        thread = threading.Thread(target=run, name="workspace-read-warmup", daemon=True)
        thread.start()
        return thread

    def authenticate(self, headers: Mapping[str, str], body: bytes) -> str:
        config = self._load_gateway_config(self.root)
        user = normalize_user(headers.get(AUTH_USER_HEADER))
        secret = config["users"].get(user)
        if not secret or not verify_request_signature(
            secret,
            headers.get(AUTH_SIGNATURE_HEADER, ""),
            user=user,
            timestamp=headers.get(AUTH_TIMESTAMP_HEADER, ""),
            method="POST",
            path=WORKSPACE_READ_PATH,
            body=body,
        ):
            raise WorkspaceReadHttpError(401, "Save Gateway authentication failed.")
        return user

    def execute(self, authenticated_user: str, raw_payload: Any) -> dict[str, Any]:
        try:
            request = validate_workspace_read_request(raw_payload)
        except WorkspaceReadContractError as exc:
            raise WorkspaceReadHttpError(400, str(exc)) from exc
        if normalize_user(request["UserName"]) != normalize_user(authenticated_user):
            raise WorkspaceReadHttpError(403, "Authenticated user does not match the read user.")

        try:
            self.ensure_runtime()
        except Exception as exc:
            self._log(self.root, f"workspace read runtime unavailable: {exc!r}")
            raise WorkspaceReadHttpError(
                503, "The ArcRho Server cannot run workspace reads right now."
            ) from exc

        from fastapi import HTTPException
        from fastapi.encoders import jsonable_encoder

        from app_server.services import user_identity_service

        spec = WORKSPACE_READ_KINDS[request["ReadKind"]]
        module = importlib.import_module(f"app_server.services.{spec.module}")
        read_function = getattr(module, spec.function)
        try:
            # A load that performs a one-time on-disk upgrade stamps the user
            # who opened it, not the gateway's service profile.
            with user_identity_service.acting_identity(
                request["UserName"], request["UserDisplayName"]
            ):
                response = read_function(**request["Kwargs"])
        except HTTPException as exc:
            detail = str(exc.detail or "").strip()
            if detail:
                try:
                    detail = _redact_machine_paths(detail)
                except Exception:
                    pass
            self._log(
                self.root,
                f"read={request['RequestId']} user={authenticated_user} "
                f"kind={request['ReadKind']} refusal={exc.status_code}",
            )
            raise WorkspaceReadRefusal(int(exc.status_code), detail) from exc
        if not isinstance(response, dict):
            response = {"ok": True, "response": response}
        # The local route hands the same object to FastAPI's encoder; matching
        # it here keeps the wire payload identical for both transports.
        return jsonable_encoder(response)
