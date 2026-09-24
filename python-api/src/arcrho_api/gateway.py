"""Signed Arco Gateway calls from a script, as the Windows user running it.

The Arco app sends its method loads, saves and dependent refreshes to the
Gateway on the Arco Server, signed with the user's own Gateway credential. This
module sends the same requests without the app, so a notebook or script reads
and saves under its own user's name whether or not Arco is open, and the saves
run the same server-side code, dependent walk included, as a save from the app.

The request shapes, the allowlisted kinds and the signing all belong to the
shared contracts; this module only reads the credential and posts.

    from arcrho_api.gateway import GatewayClient

    gateway = GatewayClient()
    rs = gateway.read("result_selection_load", project_name=..., reserving_class=...,
                      method_name="F 92 - Current Qtr Selected")
    gateway.save("result_selection_method", project, reserving_class,
                 rs["method"], notes, rs["method_revision"])
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from arcrho_engine_save_contract import SAVE_JOB_PROCESSING_TIMEOUT_SECONDS, build_save_job_request
from arcrho_hosted_save_http_contract import (
    AUTH_SIGNATURE_HEADER,
    AUTH_TIMESTAMP_HEADER,
    AUTH_USER_HEADER,
    CLIENT_CONFIG_FILE_NAME,
    HOSTED_SAVE_PATH,
    canonical_request_bytes,
    normalize_client_config,
    sign_request,
)
from arcrho_workspace_mutation_contract import (
    WORKSPACE_MUTATION_PATH,
    WORKSPACE_MUTATION_TIMEOUT_SECONDS,
    build_workspace_mutation_request,
)
from arcrho_workspace_read_contract import (
    WORKSPACE_READ_PATH,
    WORKSPACE_READ_TIMEOUT_SECONDS,
    build_workspace_read_request,
)

from .config import config_dir
from .exceptions import ArcRhoApiError

# The Gateway lives on the internal network; a system proxy must never see it.
_OPENER = build_opener(ProxyHandler({}))


class GatewayError(ArcRhoApiError):
    """The Gateway, or the operation it ran, refused the request."""

    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(f"Arco Gateway returned {status}: {detail}")
        self.status = status
        self.detail = detail


def gateway_config_path():
    """The current user's Gateway credential, written when Arco enrolled them."""

    return config_dir() / CLIENT_CONFIG_FILE_NAME


class GatewayClient:
    """Reads, mutations and saves sent to the Gateway under this user's credential."""

    def __init__(self, config: Mapping[str, Any] | None = None) -> None:
        if config is None:
            path = gateway_config_path()
            try:
                config = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                raise ArcRhoApiError(
                    f"No Arco Gateway credential at {path}. Open Arco once on this machine to create it."
                ) from None
        self.config = normalize_client_config(config)
        if not self.config["enabled"]:
            raise ArcRhoApiError("The Arco Gateway credential on this machine is turned off.")

    @property
    def user(self) -> str:
        return self.config["user"]

    @property
    def url(self) -> str:
        return self.config["url"]

    def read(self, kind: str, **kwargs: Any) -> dict[str, Any]:
        """Run one registered workspace read, such as ``dfm_method_load``."""

        request = build_workspace_read_request(
            request_id=uuid.uuid4().hex, read_kind=kind, kwargs=kwargs, user_name=self.user,
        )
        return self._post(WORKSPACE_READ_PATH, request, WORKSPACE_READ_TIMEOUT_SECONDS)

    def mutate(self, kind: str, **kwargs: Any) -> dict[str, Any]:
        """Run one registered workspace mutation, such as ``propagation_submit``."""

        request = build_workspace_mutation_request(
            request_id=uuid.uuid4().hex, mutation_kind=kind, kwargs=kwargs, user_name=self.user,
        )
        return self._post(WORKSPACE_MUTATION_PATH, request, WORKSPACE_MUTATION_TIMEOUT_SECONDS)

    def save(
        self,
        kind: str,
        project_name: str,
        reserving_class: str,
        *args: Any,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Run one hosted save, such as ``result_selection_method``, and its dependent walk.

        ``args`` and ``kwargs`` are the save service's own arguments after the
        project and reserving class, exactly as the app's save route passes them.
        """

        request = build_save_job_request(
            request_id=uuid.uuid4().hex,
            save_kind=kind,
            project_name=project_name,
            path=reserving_class,
            args=[project_name, reserving_class, *args],
            kwargs=kwargs,
            user_name=self.user,
        )
        return self._post(HOSTED_SAVE_PATH, request, SAVE_JOB_PROCESSING_TIMEOUT_SECONDS)

    def _post(self, path: str, payload: Mapping[str, Any], timeout: float) -> dict[str, Any]:
        body = canonical_request_bytes(payload)
        timestamp = str(int(time.time()))
        signature = sign_request(
            self.config["secret"], user=self.user, timestamp=timestamp, method="POST", path=path, body=body,
        )
        request = Request(
            f"{self.url}{path}",
            data=body,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                AUTH_USER_HEADER: self.user,
                AUTH_TIMESTAMP_HEADER: timestamp,
                AUTH_SIGNATURE_HEADER: signature,
            },
        )
        try:
            with _OPENER.open(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as err:
            try:
                detail = json.loads(err.read().decode("utf-8")).get("detail")
            except Exception:
                detail = err.reason
            raise GatewayError(err.code, detail) from None
        except URLError as err:
            raise ArcRhoApiError(f"Arco Gateway at {self.url} is not reachable: {err.reason}") from None
