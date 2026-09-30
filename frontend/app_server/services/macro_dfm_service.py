"""The active macro DFM is an in-memory draft with hosted persistence."""

from pathlib import Path
from types import SimpleNamespace

from arcrho_api.dfm import DfmMethod
from arcrho_api.dfm_contract import normalize_dfm_method
from arcrho_api.paths import dfm_filename

from app_server.services import engine_hosted_save_service, workspace_read_client


class MacroDfm(DfmMethod):
    def _ensure_grouped_payload(self):
        # The base implementation stats file_path to decide whether this is a
        # complete saved method. This object is the page's unsaved draft.
        self.payload = normalize_dfm_method(self.payload, require_complete=False)
        self._sync_details_identity()

    def _sidecar_notes_field(self, field):
        from app_server.services.dfm_service import load_dfm_method

        kwargs = dict(project_name=self.project_name, reserving_class=self.reserving_class,
                      method_name=self.name)
        result = workspace_read_client.run_workspace_read(
            "dfm_method_load", kwargs, local=lambda: load_dfm_method(**kwargs),
        )
        return str(result.get("sidecar", {}).get(field) or "")

    def save(self, *, automatic=False, output_changed=None, changed=None):
        if automatic:
            raise ValueError("Automatic refresh runs on the server; use an ordinary macro save.")
        result = engine_hosted_save_service.run_hosted_save(
            "dfm_method", self.project_name, self.reserving_class,
            args=[self.project_name, self.reserving_class, self.to_dict()],
            kwargs={"notes": self._pending_notes, "notes_source": self._pending_notes_source},
        )
        self.payload = result["method"]
        return self.file_path


class _MacroProject:
    read_only = False

    def __init__(self, name, method_path):
        self.name = name
        self.method_path = method_path

    def dfm_path(self, reserving_class, name):
        return self.method_path.with_name(dfm_filename(name))

    def settings(self):
        from app_server.services.project_settings_service import get_general_settings

        result = workspace_read_client.run_workspace_read(
            "general_settings", {"project_name": self.name},
            local=lambda: get_general_settings(self.name),
        )
        return SimpleNamespace(general_settings=result.get("data", {}))


def build_macro_dfm(payload, project_name, reserving_class, method_name, method_path):
    # No ArcRhoClient: constructing a folder-backed Project scans the share.
    path = Path(method_path or f"{method_name or 'Draft'}.json")
    project = _MacroProject(project_name, path)
    rc = SimpleNamespace(project=project, path=reserving_class)
    dfm = MacroDfm(rc, method_name, payload, path)
    return dfm
