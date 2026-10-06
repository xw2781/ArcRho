# <arcrho-macro>
# Title: Show Diagnostic Triangle
# Version: 1.1.0
# Release Note: The diagnostic triangle for a DFM is now looked up in diagnostic_mapping.json in the DFM Diagnostics skill folder on the server, which replaces the old diagnostic_mapping.xlsx.
# Description: Open the diagnostic dataset linked to the active Project Instance DFM using
#   the mapping kept with the DFM Diagnostics skill (shared\agent-skills\dfm-diagnostics).
# Scope: DFM
# Icon: chart
# </arcrho-macro>

from __future__ import annotations

import importlib
import json
import re

import arcrho_api
import arcrho_api.ui as arcrho_ui_module

# The embedded macro runner can keep modules loaded between runs; reload so the
# window-object UI API is visible after an ArcRho update.
importlib.reload(arcrho_ui_module)
importlib.reload(arcrho_api)
from arcrho_api import ArcRhoUI, message_box
from arcrho_api.gateway import GatewayClient

SKILL_ID = "dfm-diagnostics"
MAPPING_FILE = "diagnostic_mapping.json"
NOT_FOUND_MESSAGE = "No linked diagnostic dataset found for this method."


def _show(message: str, title: str = "Show Diagnostic Triangle") -> None:
    message_box(message, title=title, buttons=["OK"], kind="info")


def _normal_key(value: object) -> str:
    text = str(value or "").strip()
    if text.lower().startswith("dfm:"):
        text = text[4:].strip()
    return re.sub(r"\s+", " ", text).casefold()


def _load_mappings() -> list[dict]:
    """The skill's mapping rows, read from the server through the Gateway."""

    skills = GatewayClient().read("agent_skills", skill_id=SKILL_ID).get("skills") or []
    skill = next((item for item in skills if item.get("id") == SKILL_ID), None)
    if skill is None:
        raise FileNotFoundError(f"Skill '{SKILL_ID}' was not found on the server.")
    reference = next((item for item in skill.get("references") or [] if item.get("name") == MAPPING_FILE), None)
    if reference is None:
        raise FileNotFoundError(f"{MAPPING_FILE} was not found in the '{SKILL_ID}' skill.")
    return json.loads(reference["text"]).get("mappings") or []


def _find_diagnostic_dataset(method_name: str) -> str:
    wanted = _normal_key(method_name)
    if not wanted:
        return ""
    for row in _load_mappings():
        if _normal_key(row.get("method")) == wanted:
            return str(row.get("diagnostic_dataset") or "").strip()
    return ""


def run_macro(active_dfm=None, active_context=None):
    app = ArcRhoUI()
    window = app.project_instance.active_window()
    if not window:
        _show("Activate a DFM window in a Project Instance page first.")
        return {"message": "No active Project Instance window."}

    props = window.properties
    if props.kind != "dfm":
        _show("Activate a DFM window in a Project Instance page first.")
        return {"message": "The active Project Instance window is not a DFM window."}

    method_name = props.item_name or props.name or props.dataset_name
    diagnostic_dataset = _find_diagnostic_dataset(method_name)
    if not diagnostic_dataset:
        _show(NOT_FOUND_MESSAGE)
        return {"message": NOT_FOUND_MESSAGE}

    opened = app.project_instance.open_dataset(diagnostic_dataset)
    print(f"Opened diagnostic dataset '{diagnostic_dataset}' for DFM '{method_name}'.")
    return {
        "message": f"Opened diagnostic dataset: {diagnostic_dataset}",
        "details": {
            "methodName": method_name,
            "diagnosticDataset": diagnostic_dataset,
            "windowId": opened.id,
        },
    }
