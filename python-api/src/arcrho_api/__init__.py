"""Public ArcRho Python API.

The public objects are loaded lazily.  Small infrastructure consumers such as
the frozen ArcRho Server deployment helper only need ``arcrho_api.io`` and must
not have to import the client, UI automation, pandas, or the rest of the public
API merely because Python initializes this package first.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any


_EXPORTS = {
    "ArcRhoClient": (".client", "ArcRhoClient"),
    "get_config_path": (".config", "get_config_path"),
    "get_server_root": (".config", "get_server_root"),
    "reload_server_root": (".config", "reload_server_root"),
    "set_server_root": (".config", "set_server_root"),
    "DfmMethod": (".dfm", "DfmMethod"),
    "ArcRhoApiError": (".exceptions", "ArcRhoApiError"),
    "DfmDataError": (".exceptions", "DfmDataError"),
    "InvalidArcRhoServerError": (".exceptions", "InvalidArcRhoServerError"),
    "InvalidDfmJsonError": (".exceptions", "InvalidDfmJsonError"),
    "ProjectNotFoundError": (".exceptions", "ProjectNotFoundError"),
    "ReadOnlyError": (".exceptions", "ReadOnlyError"),
    "DfmMethodRef": (".models", "DfmMethodRef"),
    "ProjectSettings": (".models", "ProjectSettings"),
    "TriangleCacheResult": (".models", "TriangleCacheResult"),
    "Project": (".project", "Project"),
    "ReservingClass": (".reserving_class", "ReservingClass"),
    "ArcRhoWindow": (".ui", "ArcRhoWindow"),
    "ArcRhoWindowProperties": (".ui", "ArcRhoWindowProperties"),
    "ArcRhoUI": (".ui", "ArcRhoUI"),
    "MacroAutomation": (".ui", "MacroAutomation"),
    "ProgressBar": (".ui", "ProgressBar"),
    "ProjectInstanceAutomation": (".ui", "ProjectInstanceAutomation"),
    "TaskDesignerAutomation": (".ui", "TaskDesignerAutomation"),
    "UiCommandResult": (".ui", "UiCommandResult"),
    "active_project_instance_window": (".ui", "active_project_instance_window"),
    "get_app_health": (".ui", "get_app_health"),
    "is_app_running": (".ui", "is_app_running"),
    "message_box": (".ui", "message_box"),
    "open_dataset_in_active_project_instance": (
        ".ui",
        "open_dataset_in_active_project_instance",
    ),
    "progress_close": (".ui", "progress_close"),
    "progress_open": (".ui", "progress_open"),
    "progress_update": (".ui", "progress_update"),
    "project_instance_context": (".ui", "project_instance_context"),
    "project_instance_window_action": (".ui", "project_instance_window_action"),
    "reload_project_instance_dataset_table": (
        ".ui",
        "reload_project_instance_dataset_table",
    ),
    "run_macro_source": (".ui", "run_macro_source"),
    "send_command": (".ui", "send_command"),
    "wait_for_app": (".ui", "wait_for_app"),
}

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    target = _EXPORTS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, attribute_name = target
    value = getattr(import_module(module_name, __name__), attribute_name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))
