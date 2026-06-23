"""Public ArcRho Python API."""

from .client import ArcRhoClient
from .config import get_config_path, get_server_root, reload_server_root, set_server_root
from .dfm import DfmMethod
from .exceptions import (
    ArcRhoApiError,
    DfmDataError,
    InvalidArcRhoServerError,
    InvalidDfmJsonError,
    ProjectNotFoundError,
    ReadOnlyError,
)
from .models import DfmMethodRef, ProjectSettings, TriangleCacheResult
from .project import Project
from .reserving_class import ReservingClass
from .ui import (
    ArcRhoWindow,
    ArcRhoWindowProperties,
    ArcRhoUI,
    ProjectInstanceAutomation,
    TaskDesignerAutomation,
    UiCommandResult,
    active_project_instance_window,
    get_app_health,
    is_app_running,
    message_box,
    open_dataset_in_active_project_instance,
    project_instance_window_action,
    send_command,
    wait_for_app,
)

__all__ = [
    "ArcRhoApiError",
    "ArcRhoClient",
    "ArcRhoUI",
    "ArcRhoWindow",
    "ArcRhoWindowProperties",
    "DfmDataError",
    "DfmMethod",
    "DfmMethodRef",
    "get_config_path",
    "get_server_root",
    "get_app_health",
    "InvalidArcRhoServerError",
    "InvalidDfmJsonError",
    "is_app_running",
    "Project",
    "ProjectNotFoundError",
    "ProjectSettings",
    "ReadOnlyError",
    "ReservingClass",
    "reload_server_root",
    "set_server_root",
    "message_box",
    "open_dataset_in_active_project_instance",
    "ProjectInstanceAutomation",
    "active_project_instance_window",
    "project_instance_window_action",
    "send_command",
    "TaskDesignerAutomation",
    "TriangleCacheResult",
    "UiCommandResult",
    "wait_for_app",
]
