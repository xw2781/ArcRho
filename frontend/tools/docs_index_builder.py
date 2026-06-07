#!/usr/bin/env python3
"""Build and maintain documentation indexes for ArcRho.

This tool implements a semi-automatic documentation workflow:
- `--scaffold-missing`: create missing docs skeleton files.
- `--write`: update generated docs and AUTO-GEN blocks.
- `--check`: verify docs are up-to-date and links resolve.

Only AUTO-GEN blocks are rewritten. MANUAL blocks are never touched.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


REPO_ROOT = Path(__file__).resolve().parents[1]
DOCS_ROOT = REPO_ROOT / "docs"

EXCLUDED_DIRS = {
    "node_modules",
    "node-portable",
    "node-v24.13.0-win-x64",
    "dist",
    "python_dist",
    "python_build",
    "__pycache__",
}

SECTIONS = [
    "Purpose",
    "Entry Points",
    "Key Files",
    "External Interfaces",
    "Data/State/Caches",
    "Common Change Tasks",
    "Known Risks",
]

AUTO_BLOCK_RE = re.compile(
    r"<!-- AUTO-GEN:BEGIN (?P<label>[^>]+) -->\n(?P<body>.*?)\n<!-- AUTO-GEN:END -->",
    flags=re.DOTALL,
)
MD_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")

FRONTEND_ENTRY_HTMLS = [
    "ui/index.html",
    "ui/dataset/dataset_viewer.html",
    "ui/dfm/dfm.html",
    "ui/workflow/workflow.html",
    "ui/project_settings/project_settings.html",
    "ui/project_instance/project_instance.html",
    "ui/scripting_console/scripting_console.html",
]

FRONTEND_PURPOSE_MAX_LINES = 6
FRONTEND_PURPOSE_MAX_CHARS = 900


@dataclass(frozen=True)
class ModuleDocSpec:
    path: str
    title: str
    manual_sections: Mapping[str, str]
    auto_sections: Mapping[str, str]


@dataclass(frozen=True)
class RouteEntry:
    domain: str
    router_file: str
    method: str
    path: str
    handler: str
    request_model: str
    request_schema: str
    services: Tuple[str, ...]


@dataclass(frozen=True)
class FrontendEntrypoint:
    html_path: str
    external_scripts: Tuple[str, ...]
    inline_imports: Tuple[str, ...]


@dataclass(frozen=True)
class ManifestEntry:
    path: str
    size: int


def to_posix(path: Path) -> str:
    return path.as_posix()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    norm = text.replace("\r\n", "\n")
    if not norm.endswith("\n"):
        norm += "\n"
    path.write_text(norm, encoding="utf-8")


def maybe_write_text(path: Path, text: str) -> bool:
    norm = text.replace("\r\n", "\n")
    if not norm.endswith("\n"):
        norm += "\n"
    if path.exists():
        current = read_text(path)
        if current == norm:
            return False
    write_text(path, norm)
    return True


def rel_link(from_doc: str, target_repo_path: str) -> str:
    src_dir = (REPO_ROOT / from_doc).parent
    dst = REPO_ROOT / target_repo_path
    return to_posix(Path(os.path.relpath(dst, src_dir)))


def md_table(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    if not rows:
        return "_No records found._"
    out = []
    out.append("| " + " | ".join(headers) + " |")
    out.append("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        safe = [cell.replace("\n", "<br>") for cell in row]
        out.append("| " + " | ".join(safe) + " |")
    return "\n".join(out)


def dedent(text: str) -> str:
    return textwrap.dedent(text).strip()


def render_module_doc(spec: ModuleDocSpec) -> str:
    lines: List[str] = [f"# {spec.title}", ""]
    for section in SECTIONS:
        lines.append(f"## {section}")
        if section in spec.auto_sections:
            label = spec.auto_sections[section]
            lines.append(f"<!-- AUTO-GEN:BEGIN {label} -->")
            lines.append("_Run `python tools/docs_index_builder.py --write` to refresh this section._")
            lines.append("<!-- AUTO-GEN:END -->")
        else:
            body = spec.manual_sections.get(section, "TBD.")
            lines.append("<!-- MANUAL:BEGIN -->")
            lines.append(body.strip())
            lines.append("<!-- MANUAL:END -->")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def apply_auto_blocks(text: str, autogen: Mapping[str, str]) -> str:
    def _replace(match: re.Match[str]) -> str:
        label = match.group("label").strip()
        if label not in autogen:
            return match.group(0)
        payload = autogen[label].strip()
        return f"<!-- AUTO-GEN:BEGIN {label} -->\n{payload}\n<!-- AUTO-GEN:END -->"

    return AUTO_BLOCK_RE.sub(_replace, text)


def extract_auto_labels(text: str) -> List[str]:
    return [m.group("label").strip() for m in AUTO_BLOCK_RE.finditer(text)]


def annotation_to_str(node: ast.AST | None) -> str:
    if node is None:
        return ""
    try:
        return ast.unparse(node).strip()
    except Exception:
        return ""


def function_request_model(fn: ast.FunctionDef, schema_aliases: Mapping[str, str]) -> Tuple[str, str]:
    annotated_args = [arg for arg in fn.args.args if arg.annotation is not None]
    if not annotated_args:
        return "", ""
    preferred = next((a for a in annotated_args if a.arg in {"req", "request", "payload", "body"}), annotated_args[0])
    model = annotation_to_str(preferred.annotation)
    if not model:
        return "", ""
    model_name = model.split("[", 1)[0].split("|", 1)[0].strip()
    schema_path = schema_aliases.get(model_name, "")
    return model, schema_path


def call_root_and_attrs(node: ast.AST) -> Tuple[str, Tuple[str, ...]]:
    if isinstance(node, ast.Name):
        return node.id, ()
    if not isinstance(node, ast.Attribute):
        return "", ()
    attrs: List[str] = []
    cur: ast.AST = node
    while isinstance(cur, ast.Attribute):
        attrs.append(cur.attr)
        cur = cur.value
    if not isinstance(cur, ast.Name):
        return "", ()
    attrs.reverse()
    return cur.id, tuple(attrs)


def parse_app_server_routes() -> List[RouteEntry]:
    api_dir = REPO_ROOT / "app_server" / "api"
    if not api_dir.exists():
        return []

    routes: List[RouteEntry] = []
    router_files = sorted(p for p in api_dir.glob("*_router.py") if p.name != "__init__.py")
    allowed_methods = {"get", "post", "put", "patch", "delete", "options", "head"}

    for router_file in router_files:
        text = read_text(router_file)
        try:
            tree = ast.parse(text, filename=str(router_file))
        except SyntaxError:
            continue

        domain = router_file.stem.removesuffix("_router")
        router_rel = to_posix(router_file.relative_to(REPO_ROOT))
        service_aliases: Dict[str, str] = {}
        schema_aliases: Dict[str, str] = {}

        for node in tree.body:
            if not isinstance(node, ast.ImportFrom):
                continue
            module = node.module or ""

            if module == "app_server.services":
                for alias in node.names:
                    local = alias.asname or alias.name
                    service_aliases[local] = alias.name
            elif module.startswith("app_server.services."):
                svc_mod = module.split(".")[-1]
                for alias in node.names:
                    local = alias.asname or alias.name
                    if alias.name.endswith("_service"):
                        service_aliases[local] = alias.name
                    else:
                        service_aliases[local] = f"{svc_mod}.{alias.name}"

            if module.startswith("app_server.schemas."):
                schema_mod = module.split(".")[-1]
                for alias in node.names:
                    local = alias.asname or alias.name
                    schema_aliases[local] = f"app_server/schemas/{schema_mod}.py"

        for node in tree.body:
            if not isinstance(node, ast.FunctionDef):
                continue

            for deco in node.decorator_list:
                if not isinstance(deco, ast.Call):
                    continue
                if not isinstance(deco.func, ast.Attribute):
                    continue
                if not isinstance(deco.func.value, ast.Name):
                    continue
                if deco.func.value.id != "router":
                    continue

                method = deco.func.attr.lower()
                if method not in allowed_methods:
                    continue

                path = ""
                if deco.args and isinstance(deco.args[0], ast.Constant) and isinstance(deco.args[0].value, str):
                    path = deco.args[0].value
                if not path:
                    continue

                request_model, request_schema = function_request_model(node, schema_aliases)

                used_services: set[str] = set()
                for sub in ast.walk(node):
                    if not isinstance(sub, ast.Call):
                        continue
                    root, attrs = call_root_and_attrs(sub.func)
                    if not root or root not in service_aliases:
                        continue
                    canonical = service_aliases[root]
                    if attrs:
                        canonical = f"{canonical}.{'.'.join(attrs)}"
                    used_services.add(canonical)

                routes.append(
                    RouteEntry(
                        domain=domain,
                        router_file=router_rel,
                        method=method.upper(),
                        path=path,
                        handler=node.name,
                        request_model=request_model,
                        request_schema=request_schema,
                        services=tuple(sorted(used_services)),
                    )
                )

    routes.sort(key=lambda r: (r.domain, r.path, r.method, r.handler))
    return routes


SCRIPT_TAG_RE = re.compile(r"<script\b(?P<attrs>[^>]*)>(?P<body>.*?)</script>", flags=re.IGNORECASE | re.DOTALL)
SRC_ATTR_RE = re.compile(r"""src\s*=\s*["']([^"']+)["']""", flags=re.IGNORECASE)
IMPORT_STMT_RE = re.compile(r"""(?<![\w$])import\s+(?:[^;()]*?\s+from\s+)?["']([^"']+)["']""")
DYN_IMPORT_RE = re.compile(r"""import\(\s*["']([^"']+)["']\s*\)""")


def parse_frontend_entrypoints() -> Dict[str, FrontendEntrypoint]:
    out: Dict[str, FrontendEntrypoint] = {}
    for rel in FRONTEND_ENTRY_HTMLS:
        path = REPO_ROOT / rel
        if not path.exists():
            out[rel] = FrontendEntrypoint(rel, tuple(), tuple())
            continue
        text = read_text(path)
        external: List[str] = []
        imports: set[str] = set()
        for match in SCRIPT_TAG_RE.finditer(text):
            attrs = match.group("attrs") or ""
            body = match.group("body") or ""
            src_match = SRC_ATTR_RE.search(attrs)
            if src_match:
                external.append(src_match.group(1))
            for imp in IMPORT_STMT_RE.findall(body):
                imports.add(imp.strip())
            for imp in DYN_IMPORT_RE.findall(body):
                imports.add(imp.strip())
        out[rel] = FrontendEntrypoint(
            html_path=rel,
            external_scripts=tuple(sorted(dict.fromkeys(external))),
            inline_imports=tuple(sorted(imports)),
        )
    return out


FETCH_RE = re.compile(r"""fetch\(\s*["'`]([^"'`]+)["'`]""")
POST_MESSAGE_TYPE_RE = re.compile(r"""type\s*:\s*["']([^"']+)["']""")


def parse_js_interface_patterns(paths: Sequence[str]) -> Tuple[List[str], List[str]]:
    endpoints: set[str] = set()
    message_types: set[str] = set()
    for rel in paths:
        p = REPO_ROOT / rel
        if not p.exists():
            continue
        text = read_text(p)
        for endpoint in FETCH_RE.findall(text):
            endpoint = endpoint.strip()
            if endpoint:
                endpoints.add(endpoint)
        for msg in POST_MESSAGE_TYPE_RE.findall(text):
            msg = msg.strip()
            if msg.startswith("arcrho:"):
                message_types.add(msg)
    return sorted(endpoints), sorted(message_types)


def collect_manifest() -> List[ManifestEntry]:
    entries: List[ManifestEntry] = []
    for root, dirs, files in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS and d != ".git"]
        root_path = Path(root)
        for name in files:
            file_path = root_path / name
            rel = file_path.relative_to(REPO_ROOT)
            if any(part in EXCLUDED_DIRS for part in rel.parts):
                continue
            # Exclude generated-doc outputs to keep manifest deterministic.
            if len(rel.parts) >= 2 and rel.parts[0] == "docs" and rel.parts[1] == "generated":
                continue
            try:
                size = file_path.stat().st_size
            except OSError:
                size = -1
            entries.append(ManifestEntry(path=to_posix(rel), size=size))
    entries.sort(key=lambda x: x.path)
    return entries


def parse_config_signals() -> Tuple[List[str], List[str]]:
    cfg = REPO_ROOT / "app_server" / "config.py"
    if not cfg.exists():
        return [], []
    text = read_text(cfg)
    try:
        tree = ast.parse(text, filename=str(cfg))
    except SyntaxError:
        return [], []

    functions: List[str] = []
    constants: List[str] = []

    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            name = node.name
            if "path" in name or "dir" in name or name.startswith("get_") or name in {"load_workspace_paths", "refresh_runtime_paths"}:
                functions.append(name)
        elif isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id.isupper():
                    constants.append(tgt.id)
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and node.target.id.isupper():
                constants.append(node.target.id)

    return sorted(dict.fromkeys(functions)), sorted(dict.fromkeys(constants))


def parse_package_json() -> Dict[str, object]:
    p = REPO_ROOT / "package.json"
    if not p.exists():
        return {}
    try:
        return json.loads(read_text(p))
    except json.JSONDecodeError:
        return {}


FRONTEND_DOC_META: Mapping[str, Dict[str, object]] = {
    "shell": {
        "doc": "docs/ui/shell.md",
        "html": ["ui/index.html"],
        "files": [
            ("ui/index.html", "Main desktop shell page and menu structure."),
            ("ui/shell/ui_shell.js", "Shell bootstrap and controller composition."),
            ("ui/shell/shell_state.js", "Shell tab state persistence and invariants."),
            ("ui/shell/tab_actions.js", "Tab open/close/activate/float/dock actions."),
            ("ui/shell/tab_strip.js", "Docked tab strip rendering, reordering, plus menu, and tab context menu."),
            ("ui/shell/shell_content.js", "Home, iframe host, and floating content layout orchestration."),
            ("ui/shell/iframe_host.js", "Iframe creation, URL construction, and iframe event bridge."),
            ("ui/shell/floating_tabs.js", "In-shell floating tab window movement, resize, chrome, and layering."),
            ("ui/shell/shell_menus.js", "Shell menubar state, command dispatch, and scoped menu visibility."),
            ("ui/shell/shell_hotkeys.js", "Global shell hotkey routing."),
            ("ui/shell/shell_messages.js", "Cross-frame shell message handling."),
            ("ui/shell/shell_preferences.js", "Zoom, autosave, app font, force rebuild, and tooltip preferences."),
            ("ui/shell/root_path_settings.js", "Server Connection root path settings modal."),
            ("ui/shell/workflow_host_actions.js", "Workflow import and shell-side workflow helpers."),
            ("ui/shell/app_lifecycle.js", "Refresh, restart, shutdown, and app confirmation flows."),
            ("ui/shell/titlebar_controls.js", "Electron titlebar minimize, maximize, close, and drag-restore controls."),
            ("ui/shell/status_bar.js", "Status bar text, clock, and timestamp helpers."),
            ("ui/shell/shell_context.js", "Shared shell dependency registry."),
            ("electron/preload.js", "Renderer-safe host bridge APIs."),
            ("electron/main.js", "Window lifecycle and shell-to-host wiring."),
        ],
    },
    "dataset": {
        "doc": "docs/ui/dataset.md",
        "html": ["ui/dataset/dataset_viewer.html"],
        "files": [
            ("ui/dataset/dataset_viewer.html", "Dataset page HTML entrypoint."),
            ("ui/dataset/dataset_main.js", "Dataset grid, calculations, and API calls."),
            ("ui/dataset/dataset_shared.js", "Shared dataset markup helpers."),
            ("ui/dataset/dataset_shared.css", "Shared dataset/DFM visual styles."),
            ("ui/shared/api.js", "Client wrappers for dataset endpoints."),
        ],
    },
    "dfm": {
        "doc": "docs/ui/dfm.md",
        "html": ["ui/dfm/dfm.html"],
        "files": [
            ("ui/dfm/dfm.html", "DFM container page with tab slots."),
            ("ui/dfm/dfm_main.js", "DFM bootstrapping and orchestrator loader."),
            ("ui/dfm/dfm_tabs_orchestrator.js", "DFM tabs orchestration and message handling."),
            ("ui/dfm/dfm_details.js", "Details tab logic and title syncing."),
            ("ui/dfm/dfm_ratios_tab.js", "Ratios tab calculations and controls."),
            ("ui/dfm/dfm_results_tab.js", "Results table rendering and CSV export."),
            ("ui/dfm/dfm_persistence.js", "DFM template/pattern persistence."),
        ],
    },
    "workflow": {
        "doc": "docs/ui/workflow.md",
        "html": ["ui/workflow/workflow.html"],
        "files": [
            ("ui/workflow/workflow.html", "Workflow page layout and containers."),
            ("ui/workflow/workflow_main.js", "Workflow editing logic, save/load events."),
            ("ui/shared/menu_utils.js", "Context menu helper utilities."),
            ("ui/shared/reserving_class_lazy_picker.js", "Shared reserving-class tree selector."),
        ],
    },
    "project_settings": {
        "doc": "docs/ui/project_settings.md",
        "html": ["ui/project_settings/project_settings.html"],
        "files": [
            ("ui/project_settings/project_settings.html", "Project settings workspace and panels."),
            ("ui/project_settings/project_settings.js", "Project settings coordinator and API calls."),
            ("ui/project_settings/project_settings_field_mapping.js", "Field mapping feature module."),
            ("ui/project_settings/project_settings_dataset_types.js", "Dataset types feature module."),
            ("ui/project_settings/project_settings_reserving_class_types.js", "Reserving class types feature module."),
            ("ui/project_settings/project_settings_audit.js", "Audit log UI helper."),
        ],
    },
    "project_instance": {
        "doc": "docs/ui/project_instance.md",
        "html": ["ui/project_instance/project_instance.html"],
        "files": [
            ("ui/project_instance/project_instance.html", "Project instance tab layout."),
            ("ui/project_instance/project_instance.js", "Project instance module entrypoint."),
            ("ui/project_instance/project_instance_boot.js", "Project instance bootstrap and module composition."),
            ("ui/project_instance/project_instance_context.js", "Shared Project Instance DOM, constants, and mutable state context."),
            ("ui/project_instance/project_instance_utils.js", "Shared Project Instance text, path, motion, and numeric helpers."),
            ("ui/project_instance/project_instance_loading.js", "Project Instance status, zoom, host frame style, and page loading helpers."),
            ("ui/project_instance/project_instance_dataset_cache.js", "Cached dataset lookup, toolbar status, table preference, and disk-change watcher logic."),
            ("ui/project_instance/project_instance_dataset_table.js", "Dataset table rendering, filters, grouping, sorting, selection, and row actions."),
            ("ui/project_instance/project_instance_path_panel.js", "Reserving-class path panel loading, selection, persistence, and resizing."),
            ("ui/project_instance/project_instance_windows.js", "Floating Dataset and DFM window lifecycle, geometry, dirty state, and restore snapshots."),
            ("ui/project_instance/project_instance_hidden_tabs.js", "Hidden floating-window tab strip, menu, drop target, and dock animations."),
            ("ui/project_instance/project_instance_messages.js", "Shell and nested DFM message routing plus keyboard command forwarding."),
            ("ui/dataset/dataset_viewer.html", "Reused dataset viewer page for floating dataset windows."),
            ("ui/dataset/dataset_types_source.js", "Shared dataset type payload loader and normalizer."),
            ("ui/shared/reserving_class_lazy_picker.js", "Shared reserving-class lookup, filter, shortcut, and favorite-folder picker."),
            ("ui/shared/path_tree_picker.js", "Shared path tree body renderer used by the embedded reserving-class picker."),
        ],
    },
    "scripting_console": {
        "doc": "docs/ui/scripting_console.md",
        "html": ["ui/scripting_console/scripting_console.html"],
        "files": [
            ("ui/scripting_console/scripting_console.html", "Notebook-style scripting console page layout."),
            ("ui/scripting_console/scripting_console.js", "Scripting console bootstrap and shell integration."),
            ("ui/scripting_console/scripting_console_core.js", "Notebook state, cell model, and command-mode helpers."),
            ("ui/scripting_console/scripting_console_cells.js", "Cell rendering, selection, markdown, and drag/drop behavior."),
            ("ui/scripting_console/scripting_console_execution.js", "Code execution, streaming output, and cancellation handling."),
            ("ui/scripting_console/scripting_console_shortcuts.js", "Keyboard shortcut parsing, customization, and persistence."),
            ("ui/scripting_console/scripting_console_panels.js", "Sidebar, TOC, variables, and API reference panels."),
            ("ui/scripting_console/scripting_console_notebook_io.js", "Notebook save/open and `.ipynb` import/export helpers."),
        ],
    },
}

BACKEND_DOMAIN_META: Mapping[str, Dict[str, object]] = {
    "workflow": {
        "doc": "docs/app_server/domains/workflow.md",
        "files": [
            ("app_server/api/workflow_router.py", "HTTP routes for workflow save/load/default dirs."),
            ("app_server/services/workflow_service.py", "Workflow file I/O operations."),
            ("app_server/schemas/workflow.py", "Workflow request models."),
        ],
    },
    "workspace_paths": {
        "doc": "docs/app_server/domains/workspace_paths.md",
        "files": [
            ("app_server/api/workspace_paths_router.py", "Read/update workspace path config."),
            ("app_server/config.py", "Config loader and runtime path refresh."),
            ("app_server/schemas/workspace_paths.py", "Workspace path request models."),
        ],
    },
    "app_control": {
        "doc": "docs/app_server/domains/app_control.md",
        "files": [
            ("app_server/api/app_control_router.py", "Restart/shutdown control endpoints."),
            ("app_server/config.py", "Flag-file paths for app control."),
            ("app_launcher.py", "Launcher process watching control flags."),
            ("electron/main.js", "Electron host restart/shutdown integration."),
        ],
    },
    "audit_log": {
        "doc": "docs/app_server/domains/audit_log.md",
        "files": [
            ("app_server/api/audit_log_router.py", "Audit read/write routes."),
            ("app_server/services/audit_service.py", "Audit persistence helpers and locking."),
            ("app_server/schemas/audit_log.py", "Audit write payload schema."),
            ("app_server/config.py", "Audit file constants and lock objects."),
        ],
    },
    "dataset": {
        "doc": "docs/app_server/domains/dataset.md",
        "files": [
            ("app_server/api/dataset_router.py", "Dataset query/patch routes."),
            ("app_server/services/dataset_service.py", "Dataset in-memory operations."),
            ("app_server/schemas/dataset.py", "Dataset patch request model."),
            ("ui/shared/api.js", "Frontend client wrapper for dataset API."),
        ],
    },
    "book": {
        "doc": "docs/app_server/domains/book.md",
        "files": [
            ("app_server/api/book_router.py", "Workbook sheet/meta/patch routes."),
            ("app_server/services/book_service.py", "Workbook data read/write helpers."),
            ("app_server/schemas/book.py", "Workbook request schemas."),
        ],
    },
    "excel": {
        "doc": "docs/app_server/domains/excel.md",
        "files": [
            ("app_server/api/excel_router.py", "Excel COM automation routes."),
            ("app_server/services/excel_service.py", "Excel process interaction logic."),
            ("app_server/schemas/excel.py", "Excel request payload schemas."),
        ],
    },
    "arcrho": {
        "doc": "docs/app_server/domains/arcrho.md",
        "files": [
            ("app_server/api/arcrho_router.py", "ArcRho tri/precheck/header endpoints."),
            ("app_server/services/arcrho_runtime_service.py", "ArcRho processing and project listing."),
            ("app_server/schemas/arcrho.py", "ArcRho request schemas."),
        ],
    },
    "project_settings": {
        "doc": "docs/app_server/domains/project_settings.md",
        "files": [
            ("app_server/api/project_settings_router.py", "Project settings CRUD and folder ops routes."),
            ("app_server/services/project_settings_service.py", "Project settings persistence service."),
            ("app_server/schemas/project_settings.py", "Project settings request schemas."),
            ("ui/project_settings/project_settings.js", "Frontend caller for project settings endpoints."),
        ],
    },
    "project_book": {
        "doc": "docs/app_server/domains/project_book.md",
        "files": [
            ("app_server/api/project_book_router.py", "Project workbook metadata/sheet/patch routes."),
            ("app_server/services/book_service.py", "Workbook patching implementation."),
            ("app_server/services/project_settings_service.py", "Project-folder path resolution."),
            ("app_server/schemas/book.py", "Project workbook patch schema."),
        ],
    },
    "table_summary": {
        "doc": "docs/app_server/domains/table_summary.md",
        "files": [
            ("app_server/api/table_summary_router.py", "Table summary read/refresh routes."),
            ("app_server/services/table_summary_service.py", "CSV summary generation and cache validity."),
            ("app_server/services/reserving_class_service.py", "Optional refresh chaining."),
            ("app_server/schemas/table_summary.py", "Table summary refresh schema."),
        ],
    },
    "field_mapping": {
        "doc": "docs/app_server/domains/field_mapping.md",
        "files": [
            ("app_server/api/field_mapping_router.py", "Field mapping read/save routes."),
            ("app_server/services/field_mapping_service.py", "Field mapping persistence and validation."),
            ("app_server/schemas/field_mapping.py", "Field mapping request schema."),
        ],
    },
    "dataset_types": {
        "doc": "docs/app_server/domains/dataset_types.md",
        "files": [
            ("app_server/api/dataset_types_router.py", "Dataset type catalog read/save routes."),
            ("app_server/services/dataset_types_service.py", "Dataset type storage and normalization."),
            ("app_server/schemas/dataset_types.py", "Dataset type save schema."),
        ],
    },
    "reserving_class": {
        "doc": "docs/app_server/domains/reserving_class.md",
        "files": [
            ("app_server/api/reserving_class_router.py", "Reserving-class routes for values/tree/preferences/types."),
            ("app_server/services/reserving_class_service.py", "Cache generation, refresh, and preference persistence."),
            ("app_server/schemas/reserving_class.py", "Reserving class request models."),
            ("ui/shared/reserving_class_lazy_picker.js", "Frontend caller for reserving-class endpoints."),
        ],
    },
}


def module_specs() -> Dict[str, ModuleDocSpec]:
    specs: Dict[str, ModuleDocSpec] = {}

    specs["docs/INDEX.md"] = ModuleDocSpec(
        path="docs/INDEX.md",
        title="ArcRho Documentation Index",
        manual_sections={
            "Purpose": dedent(
                """
                This is the top-level navigation hub for code agents.

                System map:
                - Electron host/runtime: `electron/main.js`, `electron/preload.js`, `app_shell.py`.
                - Frontend pages/features: shell + dataset + DFM + workflow + project settings + scripting console.
                - App-server API: FastAPI app in `app_server/main.py` with domain routers in `app_server/api`.
                - Runtime/config state: path resolution and cache constants in `app_server/config.py`.
                """
            ),
            "Entry Points": dedent(
                """
                | Question | Where to start |
                | --- | --- |
                | Add or modify an app-server API endpoint | [`app_server/INDEX.md`](app_server/INDEX.md) |
                | Trace a page to app-server endpoints | [`ui/INDEX.md`](ui/INDEX.md) |
                | Update path/config behavior | [`runtime/config_paths.md`](runtime/config_paths.md) |
                | Troubleshoot packaging/build | [`build/packaging.md`](build/packaging.md) |
                | Inspect machine-generated inventories | [`generated/app_server_routes.md`](generated/app_server_routes.md), [`generated/frontend_entrypoints.md`](generated/frontend_entrypoints.md), [`generated/file_manifest.md`](generated/file_manifest.md) |
                """
            ),
            "External Interfaces": dedent(
                """
                Tooling interfaces introduced by this documentation system:
                - CLI: `python tools/docs_index_builder.py --scaffold-missing|--write|--check`
                - Marker contract:
                  - `<!-- AUTO-GEN:BEGIN ... --> ... <!-- AUTO-GEN:END -->`
                  - `<!-- MANUAL:BEGIN --> ... <!-- MANUAL:END -->`
                """
            ),
            "Data/State/Caches": dedent(
                """
                Runtime/cache references are centralized in:
                - [`runtime/config_paths.md`](runtime/config_paths.md)
                - [`runtime/data_cache_files.md`](runtime/data_cache_files.md)
                """
            ),
            "Common Change Tasks": dedent(
                """
                High-frequency workflows:
                1. Add/modify API endpoint: [`app_server/INDEX.md`](app_server/INDEX.md) -> target domain file under `app_server/domains/`.
                2. Trace page -> API -> service: [`ui/INDEX.md`](ui/INDEX.md) then follow linked app-server domain files.
                3. Update config/path behavior: [`runtime/config_paths.md`](runtime/config_paths.md).
                4. Package/build troubleshooting: [`build/packaging.md`](build/packaging.md).
                """
            ),
            "Known Risks": dedent(
                """
                - Documentation can drift if `--write` is not run after route/page changes.
                - AUTO-GEN blocks are deterministic; manual edits must stay inside MANUAL blocks.
                """
            ),
        },
        auto_sections={
            "Key Files": "root.key_files",
        },
    )

    specs["docs/ui/INDEX.md"] = ModuleDocSpec(
        path="docs/ui/INDEX.md",
        title="Frontend Index",
        manual_sections={
            "Purpose": dedent(
                """
                Frontend module map for page entrypoints, shell orchestration, and feature-specific scripts.
                """
            ),
            "External Interfaces": dedent(
                """
                - App-server HTTP interface via `fetch(...)` calls.
                - Cross-iframe messaging via `window.postMessage` (`arcrho:*` message types).
                """
            ),
            "Data/State/Caches": dedent(
                """
                - Shell/tab state persisted in browser storage (`localStorage`, IndexedDB handles DB).
                - Per-page state lives in each iframe module.
                """
            ),
            "Common Change Tasks": dedent(
                """
                1. Shell tab lifecycle change -> [`shell.md`](shell.md).
                2. Dataset behavior change -> [`dataset.md`](dataset.md).
                3. DFM behavior change -> [`dfm.md`](dfm.md).
                4. Workflow editor change -> [`workflow.md`](workflow.md).
                5. Project settings flow change -> [`project_settings.md`](project_settings.md).
                6. Scripting console change -> [`scripting_console.md`](scripting_console.md).
                """
            ),
            "Known Risks": dedent(
                """
                - Shell/iframe messaging changes can break hotkeys and dirty-state sync.
                - Endpoint path changes in JS can silently break page-level features.
                """
            ),
        },
        auto_sections={
            "Entry Points": "frontend.index.entry_points",
            "Key Files": "frontend.index.key_files",
        },
    )

    specs["docs/app_server/INDEX.md"] = ModuleDocSpec(
        path="docs/app_server/INDEX.md",
        title="App Server Index",
        manual_sections={
            "Purpose": dedent(
                """
                App-server domain map for FastAPI routers, schemas, and services.
                """
            ),
            "External Interfaces": dedent(
                """
                - Public interface is HTTP routes mounted by `app_server/main.py`.
                - Internal interface is router -> service -> filesystem/state helpers.
                """
            ),
            "Data/State/Caches": dedent(
                """
                - Path and cache constants are centralized in `app_server/config.py`.
                - Several domains persist JSON caches under project folders or AppData.
                """
            ),
            "Common Change Tasks": dedent(
                """
                1. Add route: update one router file under `app_server/api`, schema under `app_server/schemas`, and service under `app_server/services`.
                2. Change payload contract: update schema first, then router/service.
                3. Change project path behavior: sync with [`../runtime/config_paths.md`](../runtime/config_paths.md).
                """
            ),
            "Known Risks": dedent(
                """
                - File-based persistence and path assumptions are sensitive to environment setup.
                - Domain cross-calls (for example, table summary -> reserving class refresh) can add side effects.
                """
            ),
        },
        auto_sections={
            "Entry Points": "app_server.index.entry_points",
            "Key Files": "app_server.index.key_files",
        },
    )

    frontend_manual = {
        "shell": {
            "purpose": "Shell-level tab/iframe host for all feature pages.",
            "external": "- Communicates with child iframes via `arcrho:*` postMessage events.\n- Invokes app-server endpoints for workflow import helpers and configuration endpoints.\n- Uses Electron host bridge for Server Connection folder browsing and first-time `ArcRho Server` drive detection.",
            "data": "- Persists tab state, zoom, and toggles in `localStorage`.\n- Tracks popped-out tabs via `BroadcastChannel`.",
            "tasks": "1. Add a new tab type: update tab creation + iframe source logic in `ui_shell.js`.\n2. Add shell menu action: wire menu item + action handler + hotkey map.",
            "risks": "- DOM replacement in shell can invalidate iframe references.\n- Unsaved-state handling must stay consistent for close/close-all flows.",
        },
        "dataset": {
            "purpose": "Dataset editing/analysis page used inside shell tabs.",
            "external": "- Calls app-server dataset/book/arcrho endpoints.\n- Sends status/hotkey/close signals to parent shell.",
            "data": "- Uses in-page mutable state for active dataset and selection.\n- Reads project metadata from app_server endpoints.",
            "tasks": "1. Add a new app-server call: update fetch call and API wrappers.\n2. Change table behavior: update `dataset_main.js` render + patch flow together.",
            "risks": "- Formula or patch changes can cause silent data drift.\n- Endpoint mismatches break runtime flows without compile-time safety.",
        },
        "dfm": {
            "purpose": "DFM feature (details/ratios/results/notes) on top of dataset context.",
            "external": "- Exchanges `arcrho:*` messages with shell and workflow iframe.\n- Reuses dataset APIs and reserving class selectors.",
            "data": "- Persists ratio selection/templates via DFM persistence modules.\n- Tracks dirty flags and active DFM tab state.",
            "tasks": "1. Add a DFM tab capability: update orchestrator + tab module.\n2. Modify ratio/result behavior: sync `dfm_ratios_tab.js` and `dfm_results_tab.js`.",
            "risks": "- Cross-tab sync is message-driven and easy to desynchronize.\n- Persistence schema changes can break saved templates.",
        },
        "workflow": {
            "purpose": "Workflow editor page and save/load orchestration.",
            "external": "- Calls `/workflow/*` app-server routes.\n- Coordinates with shell and embedded dataset/DFM iframes via message bridge.",
            "data": "- Persists workflow tab state using per-instance storage keys.\n- Uses imported/exported `.arcwf` payloads.",
            "tasks": "1. Extend workflow payload: update `workflow_main.js`, app-server schema/service, and save/load compatibility.\n2. Add sidebar behavior: update `workflow.html` + resize/collapse handlers.",
            "risks": "- Save/load compatibility regressions across older workflow files.\n- Dirty-state propagation to shell can become inconsistent.",
        },
        "project_settings": {
            "purpose": "Project settings workspace (folders, mappings, dataset types, reserving class types).",
            "external": "- Calls `/project_settings/*`, `/table_summary*`, and related endpoints.\n- Posts title/status events to shell.",
            "data": "- Reads/writes settings payloads and folder structures.\n- Coordinates feature modules for mapping/type editors.",
            "tasks": "1. Add settings source behavior: update source key logic + endpoint calls.\n2. Update one feature pane: modify corresponding `project_settings_*` module.",
            "risks": "- Folder rename/duplicate/delete flows have rollback branches.\n- Large settings payload edits can impact response timing.",
        },
        "project_instance": {
            "purpose": "Project instance workspace for browsing one project's reserving-class paths and dataset types.",
            "external": "- Opened by shell as a `project_instance` iframe tab.\n- Calls shared dataset-types and reserving-class path endpoints through existing frontend helpers.\n- Embeds the existing Dataset Viewer page in draggable in-tab windows.",
            "data": "- Uses the shell-persisted project name/folder/table path as tab inputs.\n- Keeps the selected reserving-class path in page memory and passes it into new dataset viewer windows.",
            "tasks": "1. Change project instance launch behavior: update Project Settings sender and shell message/tab routing together.\n2. Change dataset-window behavior: update `project_instance.js` while preserving the reused Dataset Viewer page contract.",
            "risks": "- Nested dataset iframes post messages to the project instance page before reaching the shell.\n- Dataset viewer query parameters must remain compatible with normal top-level dataset tabs.",
        },
        "scripting_console": {
            "purpose": "Notebook-style scripting workspace for code, markdown, raw cells, execution output, and sidebar panels.",
            "external": "- Called from shell as a scripting tab iframe.\n- Uses `/scripting/*` app-server routes for execution, variables, preferences, and notebook persistence.\n- Sends `arcrho:*` status and command messages to/from the shell.",
            "data": "- Stores per-tab draft notebook state with tab-scoped browser storage keys.\n- Saves notebooks as `.ipynb` files under the user scripting directory by default.\n- Persists keyboard shortcut preferences under APPDATA with browser storage fallback.",
            "tasks": "1. Change notebook model or persistence: update core state, notebook I/O, app-server scripting routes if needed, and docs together.\n2. Change cell behavior or shortcuts: update cells/core/shortcuts modules and verify command/edit mode interactions.\n3. Change sidebar or visual layout: update panels/cells/html together and keep INDEX.md as a short pointer only.",
            "risks": "- Keyboard handling is sensitive to edit mode, command mode, IME/composition, and Monaco focus.\n- Multi-cell selection, queueing, markdown folding, and drag/drop share state and can regress each other.\n- Long feature notes should stay in this module doc or release fragments, not in `docs/ui/INDEX.md`.",
        },
    }

    for name in FRONTEND_DOC_META:
        manual = frontend_manual[name]
        specs[f"docs/ui/{name}.md"] = ModuleDocSpec(
            path=f"docs/ui/{name}.md",
            title=f"Frontend: {name.replace('_', ' ').title()}",
            manual_sections={
                "Purpose": manual["purpose"],
                "External Interfaces": manual["external"],
                "Data/State/Caches": manual["data"],
                "Common Change Tasks": manual["tasks"],
                "Known Risks": manual["risks"],
            },
            auto_sections={
                "Entry Points": f"frontend.{name}.entry_points",
                "Key Files": f"frontend.{name}.key_files",
            },
        )

    backend_manual = {
        "workflow": (
            "Workflow file save/load domain.",
            "- Consumed primarily by `workflow_main.js`.\n- Uses typed request models in `app_server/schemas/workflow.py`.",
            "- Reads/writes workflow files under configured workflow directory.",
            "1. Add a workflow route: update router + schema + service.\n2. Keep backward compatibility when changing saved payload shape.",
            "- File I/O errors and path permissions are common failure modes.",
        ),
        "workspace_paths": (
            "Runtime workspace path read/update domain.",
            "- Used by shell root-path settings modal.\n- Triggers `config.refresh_runtime_paths()` on updates.\n- `GET /workspace_paths` reports whether the AppData config file already exists so the shell can detect first-time setup.",
            "- Persists config in `%APPDATA%\\ArcRho\\workspace_paths.json`.\n- Uses built-in defaults until Server Connection is saved.",
            "1. Add config field: update schema + router serialization + config readers.\n2. Rename config fields by updating producers, consumers, and docs together.",
            "- Invalid path config writes can impact all path-dependent domains.",
        ),
        "app_control": (
            "Application lifecycle control domain (restart/shutdown flags).",
            "- Called by shell app control actions.\n- Coordinated with launcher/electron host watchers.",
            "- Uses flag files under project root.",
            "1. Add lifecycle action: define flag contract and watcher handling in launcher/host.",
            "- Incorrect flag behavior can cause app restart loops.",
        ),
        "audit_log": (
            "Audit log read/write domain for project actions.",
            "- Called from settings/type update flows.\n- Service enforces safe append logic.",
            "- Stores rolling JSON audit records with lock protection.",
            "1. Add audit event fields: update schema and writer helper together.",
            "- Lock/file contention may surface under concurrent writes.",
        ),
        "dataset": (
            "Dataset retrieval/patch domain for in-memory dataset instances.",
            "- Called by dataset/DFM frontend flows via `shared/api.js`.",
            "- Uses in-memory dataset map and patch payloads.",
            "1. Change patch semantics: align schema, service patch rules, and frontend expectations.",
            "- Patch operations can introduce subtle data integrity issues.",
        ),
        "book": (
            "Workbook metadata/sheet/patch domain.",
            "- Shared by dataset-related frontend flows.",
            "- Reads/writes workbook content via service helpers.",
            "1. Add sheet operation: update router contract and service implementation.",
            "- Workbook file locking and formula behavior can vary by environment.",
        ),
        "excel": (
            "Excel automation domain (selection reads and workbook operations).",
            "- Called by interactive Excel-based workflows.",
            "- Runtime depends on local Excel automation availability.",
            "1. Add automation method: schema + router + service must stay aligned.",
            "- Excel COM timing and environment dependencies are fragile.",
        ),
        "arcrho": (
            "ArcRho calculations/precheck domain.",
            "- Called by dataset/workflow actions requiring ArcRho processing.",
            "- Integrates headers/project listing and tri execution endpoints.",
            "1. Add new ArcRho operation: keep precheck/execute contracts explicit.",
            "- Long-running computations need robust error messaging.",
        ),
        "project_settings": (
            "Project settings source and folder-structure management domain.",
            "- Heavily used by `project_settings.js` UI flows.",
            "- Handles folder CRUD and settings JSON writes.",
            "1. Add source key support: update router path params + service source resolution.",
            "- Folder operation rollbacks can leave partial state when interrupted.",
        ),
        "project_book": (
            "Project workbook domain resolved by project name and source folders.",
            "- Used by project settings/dataset flows for project-specific workbook operations.",
            "- Depends on project settings path resolution.",
            "1. Change project-book lookup rules: update router checks and service path resolvers.",
            "- Mismatched source/folder mappings can route to wrong files.",
        ),
        "table_summary": (
            "Table summary generation/cache and refresh domain.",
            "- Used by project settings and reserving class refresh workflows.",
            "- Can trigger reserving class value refresh as side effect.",
            "1. Change refresh contract: align request schema and downstream reserve refresh behavior.",
            "- Cache invalidation and side-effect refresh can impact performance.",
        ),
        "field_mapping": (
            "Field mapping persistence domain for project settings.",
            "- Used by project settings field mapping feature.",
            "- Stores mapping files under project folders.",
            "1. Add mapping attributes: update schema, service validation, and UI module.",
            "- Invalid mappings propagate into reserving class/dataset processing.",
        ),
        "dataset_types": (
            "Dataset types catalog domain.",
            "- Used by project settings dataset types panel and dependent flows.",
            "- Persists dataset type definitions under project folders.",
            "1. Add type metadata field: align schema, service normalization, and frontend editor.",
            "- Type schema drift can break downstream interpretation logic.",
        ),
        "reserving_class": (
            "Reserving class values/tree/preferences/types domain.",
            "- Consumed by dataset, DFM, and project settings features.\n- Exposes refresh and cache children endpoints.",
            "- Uses multiple JSON cache files and AppData preference files with lock protection.",
            "1. Add a reserving-class endpoint: keep schema/service lock logic consistent.\n2. Change cache structure: update readers/writers and UI consumers together.",
            "- High route volume and file-lock contention make regression risk higher here.",
        ),
    }

    for domain in BACKEND_DOMAIN_META:
        purpose, external, data_state, tasks, risks = backend_manual[domain]
        specs[f"docs/app_server/domains/{domain}.md"] = ModuleDocSpec(
            path=f"docs/app_server/domains/{domain}.md",
            title=f"App Server Domain: {domain}",
            manual_sections={
                "Purpose": purpose,
                "External Interfaces": external,
                "Data/State/Caches": data_state,
                "Common Change Tasks": tasks,
                "Known Risks": risks,
            },
            auto_sections={
                "Entry Points": f"app_server.{domain}.entry_points",
                "Key Files": f"app_server.{domain}.key_files",
            },
        )

    specs["docs/runtime/config_paths.md"] = ModuleDocSpec(
        path="docs/runtime/config_paths.md",
        title="Runtime: Config and Path Resolution",
        manual_sections={
            "Purpose": "Document path/config setup, AppData-backed workspace path persistence, and runtime path refresh behavior.",
            "External Interfaces": "- Frontend shell settings modal calls `/workspace_paths` routes.\n- App-server modules import `app_server.config` for runtime path resolution.\n- On first-time setup, the Electron shell searches `D:\\ArcRho Server` through `Z:\\ArcRho Server` and fills the Server Connection root path when found.",
            "Data/State/Caches": "- `%APPDATA%\\ArcRho\\workspace_paths.json` is the persistent user-local source-of-truth for workspace root/path mapping.\n- If the AppData workspace path file does not exist yet, the app uses built-in defaults until the Server Connection setting is saved.\n- Runtime globals in `app_server/config.py` are refreshed from config.\n- User-local fixed paths are also refreshed in `app_server/config.py`, including workflow export path (`~/Documents/ArcRho/workflows`) and scripting notebook path (`~/Documents/ArcRho/scripts`).",
            "Common Change Tasks": "1. Add a new configurable path: update the AppData `workspace_paths.json` contract + `app_server/config.py` getters.\n2. Change path refresh behavior: validate all services that depend on runtime globals.",
            "Known Risks": "- Path changes affect every filesystem-backed domain.\n- Environment-specific path assumptions can break packaged deployments.",
        },
        auto_sections={
            "Entry Points": "runtime.config_paths.entry_points",
            "Key Files": "runtime.config_paths.key_files",
        },
    )

    specs["docs/runtime/data_cache_files.md"] = ModuleDocSpec(
        path="docs/runtime/data_cache_files.md",
        title="Runtime: Data and Cache Files",
        manual_sections={
            "Purpose": "Index cache/data files and refresh points used by app-server services.",
            "External Interfaces": "- Cache refresh is exposed via route endpoints and service calls.\n- Several caches are project-folder scoped; others are user AppData scoped.",
            "Data/State/Caches": "- File names and limits are defined in `app_server/config.py` constants.\n- Refresh endpoints can clear and rebuild cache files.",
            "Common Change Tasks": "1. Add cache file constant: update config, service readers/writers, and this index.\n2. Change refresh logic: verify endpoint side effects and lock behavior.",
            "Known Risks": "- Cache invalidation bugs can surface as stale or mismatched UI data.\n- File locking can fail writes under concurrent access.",
        },
        auto_sections={
            "Entry Points": "runtime.data_cache_files.entry_points",
            "Key Files": "runtime.data_cache_files.key_files",
        },
    )

    specs["docs/build/packaging.md"] = ModuleDocSpec(
        path="docs/build/packaging.md",
        title="Build and Packaging",
        manual_sections={
            "Purpose": "Document Electron + Python packaging inputs and scripts.",
            "External Interfaces": "- Node scripts from `package.json` drive build orchestration.\n- PyInstaller spec (`build/server.spec`) builds app-server executable artifacts.\n- `build/release_notes.py` validates unreleased change fragments and generates versioned release notes in `docs/releases/`.\n- Electron packaging enables NSIS's built-in compressor path before `electron-builder` runs so installer file progress is visible during the main install phase.",
            "Data/State/Caches": "- Build outputs: `dist/`, `python_build/`, `python_dist/`.\n- Installer settings live in `package.json`, `build/installer.nsh`, and `build/patch_nsis_installer_progress.js`.\n- Release tracking data lives under `changes/unreleased/`, `changes/archive/`, and `docs/releases/`.",
            "Common Change Tasks": "1. Update app packaging metadata: edit `package.json` `build` block.\n2. Update bundled app server: edit `build/server.spec` and verify `extraResources` mappings.\n3. Add or update unreleased change fragments in `changes/unreleased/` before packaging a release.\n4. If you need a specific release version, run `build\\build_app.bat <version>` (for example `build\\build_app.bat 2.0.0`); otherwise the script auto-increments the patch version.\n5. If electron-builder is reinstalled or upgraded, rerun `npm run build:electron` or `build\\build_app.bat`; both paths reapply the ArcRho NSIS installer-progress patch before packaging.",
            "Known Risks": "- Packaging excludes can accidentally omit runtime files.\n- Divergence between dev and packaged paths causes startup failures.\n- electron-builder NSIS implementation changes can break the ArcRho installer-progress patch; `build/patch_nsis_installer_progress.js` fails fast when the upstream compressor setting no longer matches the expected form.",
        },
        auto_sections={
            "Entry Points": "build.packaging.entry_points",
            "Key Files": "build.packaging.key_files",
        },
    )

    return specs


def conventions_doc() -> str:
    return dedent(
        """
        # Documentation Conventions

        ## Purpose
        This project uses a semi-automatic documentation system for code agents.

        ## Required Section Template
        Module/submodule index files should use these sections in order:
        1. `Purpose`
        2. `Entry Points`
        3. `Key Files`
        4. `External Interfaces`
        5. `Data/State/Caches`
        6. `Common Change Tasks`
        7. `Known Risks`

        ## Marker Contract
        AUTO-GEN blocks are managed by `tools/docs_index_builder.py`:

        ```md
        <!-- AUTO-GEN:BEGIN label -->
        ...
        <!-- AUTO-GEN:END -->
        ```

        MANUAL blocks are hand-maintained:

        ```md
        <!-- MANUAL:BEGIN -->
        ...
        <!-- MANUAL:END -->
        ```

        Rule:
        - The script may update only AUTO-GEN blocks.
        - The script must not rewrite MANUAL blocks.
        - Frontend module `Purpose` sections should stay under 6 nonblank lines and 900 characters; move behavior details to focused sections or source-specific docs.

        ## Naming and Placement
        - All docs live under `docs/`.
        - Frontend indexes: `docs/ui/`.
        - App-server indexes: `docs/app_server/` and `docs/app_server/domains/`.
        - Runtime/config indexes: `docs/runtime/`.
        - Build indexes: `docs/build/`.
        - Generated inventories: `docs/generated/`.

        ## Update Workflow
        1. `python tools/docs_index_builder.py --scaffold-missing`
        2. `python tools/docs_index_builder.py --write`
        3. `python tools/docs_index_builder.py --check`
        """
    ) + "\n"


def generated_readme_doc() -> str:
    return dedent(
        """
        # Generated Documentation Files

        These files are fully generated by `tools/docs_index_builder.py`:
        - `docs/generated/app_server_routes.md`
        - `docs/generated/frontend_entrypoints.md`
        - `docs/generated/file_manifest.md`

        Do not hand-edit generated files; re-run:
        - `python tools/docs_index_builder.py --write`

        Generated files are checked by:
        - `python tools/docs_index_builder.py --check`
        """
    ) + "\n"


def generated_placeholder(title: str) -> str:
    return f"# {title}\n\n_Run `python tools/docs_index_builder.py --write` to generate this file._\n"


def scaffold_templates() -> Dict[str, str]:
    templates: Dict[str, str] = {}
    for path, spec in module_specs().items():
        templates[path] = render_module_doc(spec)

    templates["docs/CONVENTIONS.md"] = conventions_doc()
    templates["docs/GENERATED_README.md"] = generated_readme_doc()
    templates["docs/generated/app_server_routes.md"] = generated_placeholder("App Server Route Inventory")
    templates["docs/generated/frontend_entrypoints.md"] = generated_placeholder("Frontend Entrypoint Inventory")
    templates["docs/generated/file_manifest.md"] = generated_placeholder("Repository File Manifest")
    return templates


def render_key_files_block(doc_path: str, files: Sequence[Tuple[str, str]]) -> str:
    rows: List[str] = []
    for repo_file, desc in files:
        link = rel_link(doc_path, repo_file)
        exists = (REPO_ROOT / repo_file).exists()
        status = "" if exists else " _(missing)_"
        rows.append(f"- [`{repo_file}`]({link}) - {desc}{status}")
    if not rows:
        return "_No key files configured._"
    return "\n".join(rows)


def routes_by_domain(routes: Sequence[RouteEntry]) -> Dict[str, List[RouteEntry]]:
    out: Dict[str, List[RouteEntry]] = {}
    for route in routes:
        out.setdefault(route.domain, []).append(route)
    for domain in out:
        out[domain].sort(key=lambda r: (r.path, r.method, r.handler))
    return out


def render_route_table_for_doc(doc_path: str, routes: Sequence[RouteEntry]) -> str:
    rows: List[List[str]] = []
    for r in routes:
        schema_cell = "-"
        if r.request_schema:
            schema_cell = f"[`{r.request_schema}`]({rel_link(doc_path, r.request_schema)})"
        services = ", ".join(f"`{svc}`" for svc in r.services) if r.services else "-"
        rows.append(
            [
                f"`{r.method}`",
                f"`{r.path}`",
                f"`{r.handler}`",
                f"`{r.request_model}`" if r.request_model else "-",
                schema_cell,
                services,
            ]
        )
    return md_table(["Method", "Path", "Handler", "Request Model", "Schema", "Service Calls"], rows)


def render_frontend_entrypoint_block(entrypoints: Mapping[str, FrontendEntrypoint], html_files: Sequence[str]) -> str:
    lines: List[str] = []
    for html in html_files:
        info = entrypoints.get(html)
        if info is None:
            lines.append(f"- `{html}`: not found.")
            continue
        ext = ", ".join(f"`{x}`" for x in info.external_scripts) if info.external_scripts else "_none_"
        imp = ", ".join(f"`{x}`" for x in info.inline_imports) if info.inline_imports else "_none_"
        lines.append(f"- `{html}`: external scripts {ext}; inline imports {imp}.")
    if not lines:
        return "_No entrypoints configured._"
    return "\n".join(lines)


def render_frontend_index_entrypoints(entrypoints: Mapping[str, FrontendEntrypoint]) -> str:
    rows: List[List[str]] = []
    for html in FRONTEND_ENTRY_HTMLS:
        info = entrypoints.get(html)
        ext_count = len(info.external_scripts) if info else 0
        imp_count = len(info.inline_imports) if info else 0
        ext = f"{ext_count} external script{'s' if ext_count != 1 else ''}" if ext_count else "-"
        imp = f"{imp_count} inline import{'s' if imp_count != 1 else ''}" if imp_count else "-"
        rows.append([f"`{html}`", ext, imp])
    return md_table(["HTML Entrypoint", "External Scripts", "Inline Imports"], rows)


def render_app_server_index_entrypoints(doc_path: str, by_domain: Mapping[str, Sequence[RouteEntry]]) -> str:
    rows: List[List[str]] = []
    for domain in sorted(BACKEND_DOMAIN_META):
        routes = list(by_domain.get(domain, []))
        router = f"app_server/api/{domain}_router.py"
        router_cell = f"[`{router}`]({rel_link(doc_path, router)})"
        doc_file = f"docs/app_server/domains/{domain}.md"
        doc_cell = f"[`{domain}.md`]({rel_link(doc_path, doc_file)})"
        rows.append([f"`{domain}`", router_cell, str(len(routes)), doc_cell])
    return md_table(["Domain", "Router", "Route Count", "Domain Index"], rows)


def render_root_key_files(doc_path: str) -> str:
    files = [
        ("docs/ui/INDEX.md", "Frontend module index."),
        ("docs/app_server/INDEX.md", "App-server domain index."),
        ("docs/runtime/config_paths.md", "Runtime config and path index."),
        ("docs/runtime/data_cache_files.md", "Runtime cache/data file index."),
        ("docs/build/packaging.md", "Build and packaging index."),
        ("docs/generated/app_server_routes.md", "Generated route inventory."),
        ("docs/generated/frontend_entrypoints.md", "Generated frontend entrypoint inventory."),
        ("docs/generated/file_manifest.md", "Generated repository file manifest."),
    ]
    return render_key_files_block(doc_path, files)


def render_app_server_index_key_files(doc_path: str) -> str:
    files = [
        ("app_server/main.py", "FastAPI app creation, router registration, static mount."),
        ("app_server/api/__init__.py", "Router exports consumed by app startup."),
        ("app_server/config.py", "Runtime path/config constants and helpers."),
        ("app_server/helpers.py", "Cross-domain utility helpers."),
    ]
    return render_key_files_block(doc_path, files)


def render_frontend_index_key_files(doc_path: str) -> str:
    files = [
        ("docs/ui/shell.md", "Shell tab host index."),
        ("docs/ui/dataset.md", "Dataset feature index."),
        ("docs/ui/dfm.md", "DFM feature index."),
        ("docs/ui/workflow.md", "Workflow feature index."),
        ("docs/ui/project_settings.md", "Project settings feature index."),
        ("docs/ui/scripting_console.md", "Scripting console feature index."),
    ]
    return render_key_files_block(doc_path, files)


def render_runtime_config_entrypoints(path_functions: Sequence[str], workspace_path_routes: Sequence[RouteEntry]) -> str:
    lines: List[str] = []
    if path_functions:
        lines.append("- Path/config helper functions in `app_server/config.py`:")
        lines.extend([f"  - `{name}`" for name in path_functions])
    else:
        lines.append("- No config helper functions discovered.")

    if workspace_path_routes:
        lines.append("- Workspace path config routes:")
        for r in workspace_path_routes:
            lines.append(f"  - `{r.method}` `{r.path}` handled by `{r.handler}`")
    return "\n".join(lines)


def render_runtime_data_entrypoints(routes: Sequence[RouteEntry]) -> str:
    refresh_routes = [r for r in routes if "refresh" in r.path or "cache" in r.path or "summary" in r.path]
    refresh_routes.sort(key=lambda r: (r.path, r.method))
    if not refresh_routes:
        return "_No refresh/cache routes detected._"
    rows = [[f"`{r.method}`", f"`{r.path}`", f"`{r.domain}`", f"`{r.handler}`"] for r in refresh_routes]
    return md_table(["Method", "Path", "Domain", "Handler"], rows)


def render_runtime_data_key_files(doc_path: str, constants: Sequence[str]) -> str:
    cache_constants = [c for c in constants if c.endswith("_FILE") or c.endswith("_LOCK")]
    lines = [render_key_files_block(doc_path, [("app_server/config.py", "Cache/data file names and lock constants.")])]
    if cache_constants:
        lines.append("")
        lines.append("Cache/lock constants detected:")
        lines.extend([f"- `{c}`" for c in cache_constants])
    return "\n".join(lines).strip()


def render_runtime_config_key_files(doc_path: str) -> str:
    files = [
        ("app_server/config.py", "Primary runtime path + config module, including AppData workspace path persistence."),
        ("app_server/api/workspace_paths_router.py", "HTTP interface for workspace path updates."),
        ("app_server/main.py", "App bootstrap and static path mounting."),
    ]
    return render_key_files_block(doc_path, files)


def render_build_entrypoints(package_info: Mapping[str, object]) -> str:
    scripts = package_info.get("scripts", {}) if isinstance(package_info.get("scripts"), dict) else {}
    main = package_info.get("main", "")
    rows: List[List[str]] = []
    for name in sorted(scripts):
        rows.append([f"`npm run {name}`", f"`{scripts[name]}`"])
    body = []
    body.append(md_table(["Script", "Command"], rows))
    if main:
        body.append("")
        body.append(f"Electron main entry: `{main}`")
    return "\n".join(body).strip()


def render_build_key_files(doc_path: str) -> str:
    files = [
        ("package.json", "Build scripts, Electron builder config, installer metadata."),
        ("build/server.spec", "PyInstaller spec for Python app-server executable."),
        ("build/server_entry.py", "PyInstaller entrypoint for the bundled app server."),
        ("build/release_notes.py", "Release fragment validator and versioned release note generator."),
        ("electron/main.js", "Electron main process entry."),
        ("app_launcher.py", "Python host launcher used by packaged runtime."),
        ("build/installer.nsh", "NSIS custom installer script include."),
        ("build/patch_nsis_installer_progress.js", "Build-time helper that enables NSIS built-in file progress before electron-builder runs."),
        ("build/build_app.bat", "Convenience build script wrapper."),
        ("build/convert_icon.js", "Build helper for regenerating Windows icon assets."),
    ]
    return render_key_files_block(doc_path, files)


def build_autogen_blocks(
    routes: Sequence[RouteEntry],
    entrypoints: Mapping[str, FrontendEntrypoint],
    path_functions: Sequence[str],
    constants: Sequence[str],
    package_info: Mapping[str, object],
) -> Dict[str, str]:
    by_domain = routes_by_domain(routes)
    blocks: Dict[str, str] = {}

    blocks["root.key_files"] = render_root_key_files("docs/INDEX.md")
    blocks["frontend.index.entry_points"] = render_frontend_index_entrypoints(entrypoints)
    blocks["frontend.index.key_files"] = render_frontend_index_key_files("docs/ui/INDEX.md")
    blocks["app_server.index.entry_points"] = render_app_server_index_entrypoints("docs/app_server/INDEX.md", by_domain)
    blocks["app_server.index.key_files"] = render_app_server_index_key_files("docs/app_server/INDEX.md")

    for name, meta in FRONTEND_DOC_META.items():
        html_files = meta["html"]  # type: ignore[index]
        file_specs = meta["files"]  # type: ignore[index]
        js_files = [path for path, _ in file_specs if path.endswith(".js")]
        endpoints, messages = parse_js_interface_patterns(js_files)

        entry_block = render_frontend_entrypoint_block(entrypoints, html_files)
        if endpoints:
            entry_block += "\n\nDetected `fetch(...)` targets in key JS files:\n"
            entry_block += "\n".join(f"- `{e}`" for e in endpoints)
        if messages:
            entry_block += "\n\nDetected `arcrho:*` message types in key JS files:\n"
            entry_block += "\n".join(f"- `{m}`" for m in messages)

        blocks[f"frontend.{name}.entry_points"] = entry_block
        blocks[f"frontend.{name}.key_files"] = render_key_files_block(meta["doc"], file_specs)  # type: ignore[index]

    for domain, meta in BACKEND_DOMAIN_META.items():
        domain_routes = by_domain.get(domain, [])
        blocks[f"app_server.{domain}.entry_points"] = render_route_table_for_doc(meta["doc"], domain_routes)  # type: ignore[index]
        blocks[f"app_server.{domain}.key_files"] = render_key_files_block(meta["doc"], meta["files"])  # type: ignore[index]

    workspace_path_routes = by_domain.get("workspace_paths", [])
    blocks["runtime.config_paths.entry_points"] = render_runtime_config_entrypoints(path_functions, workspace_path_routes)
    blocks["runtime.config_paths.key_files"] = render_runtime_config_key_files("docs/runtime/config_paths.md")
    blocks["runtime.data_cache_files.entry_points"] = render_runtime_data_entrypoints(routes)
    blocks["runtime.data_cache_files.key_files"] = render_runtime_data_key_files("docs/runtime/data_cache_files.md", constants)
    blocks["build.packaging.entry_points"] = render_build_entrypoints(package_info)
    blocks["build.packaging.key_files"] = render_build_key_files("docs/build/packaging.md")

    return blocks


def render_app_server_routes_generated(routes: Sequence[RouteEntry]) -> str:
    by_domain = routes_by_domain(routes)
    lines: List[str] = []
    lines.append("# App Server Route Inventory")
    lines.append("")
    lines.append("Generated by `python tools/docs_index_builder.py --write`.")
    lines.append("")
    summary_rows: List[List[str]] = []
    for domain in sorted(BACKEND_DOMAIN_META):
        domain_routes = by_domain.get(domain, [])
        router = f"app_server/api/{domain}_router.py"
        summary_rows.append(
            [
                f"`{domain}`",
                f"`{router}`",
                str(len(domain_routes)),
                f"[Open Domain Index](../app_server/domains/{domain}.md)",
            ]
        )
    lines.append("## Domain Summary")
    lines.append(md_table(["Domain", "Router", "Routes", "Domain Doc"], summary_rows))
    lines.append("")
    for domain in sorted(BACKEND_DOMAIN_META):
        lines.append(f"## {domain}")
        lines.append("")
        domain_routes = by_domain.get(domain, [])
        lines.append(render_route_table_for_doc("docs/generated/app_server_routes.md", domain_routes))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_frontend_entrypoints_generated(entrypoints: Mapping[str, FrontendEntrypoint]) -> str:
    lines: List[str] = []
    lines.append("# Frontend Entrypoint Inventory")
    lines.append("")
    lines.append("Generated by `python tools/docs_index_builder.py --write`.")
    lines.append("")
    rows: List[List[str]] = []
    for html in FRONTEND_ENTRY_HTMLS:
        info = entrypoints.get(html, FrontendEntrypoint(html, tuple(), tuple()))
        rows.append(
            [
                f"`{html}`",
                ", ".join(f"`{x}`" for x in info.external_scripts) or "-",
                ", ".join(f"`{x}`" for x in info.inline_imports) or "-",
            ]
        )
    lines.append("## Summary")
    lines.append(md_table(["HTML Entrypoint", "External Scripts", "Inline Imports"], rows))
    lines.append("")
    for html in FRONTEND_ENTRY_HTMLS:
        info = entrypoints.get(html, FrontendEntrypoint(html, tuple(), tuple()))
        lines.append(f"## {html}")
        lines.append("")
        ext = info.external_scripts or ("(none)",)
        imp = info.inline_imports or ("(none)",)
        lines.append("- External scripts:")
        for item in ext:
            lines.append(f"  - `{item}`")
        lines.append("- Inline imports:")
        for item in imp:
            lines.append(f"  - `{item}`")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_manifest_generated(entries: Sequence[ManifestEntry]) -> str:
    top_counts: Dict[str, int] = {}
    for e in entries:
        first = e.path.split("/", 1)[0] if "/" in e.path else "(root)"
        top_counts[first] = top_counts.get(first, 0) + 1

    lines: List[str] = []
    lines.append("# Repository File Manifest")
    lines.append("")
    lines.append("Generated by `python tools/docs_index_builder.py --write`.")
    lines.append("")
    lines.append("Excluded directories: " + ", ".join(f"`{d}`" for d in sorted(EXCLUDED_DIRS)))
    lines.append("")
    lines.append("## Top-Level Counts")
    summary_rows = [[f"`{k}`", str(v)] for k, v in sorted(top_counts.items())]
    lines.append(md_table(["Top-Level Segment", "File Count"], summary_rows))
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def generated_docs_payload(
    routes: Sequence[RouteEntry],
    entrypoints: Mapping[str, FrontendEntrypoint],
    manifest: Sequence[ManifestEntry],
) -> Dict[str, str]:
    return {
        "docs/generated/app_server_routes.md": render_app_server_routes_generated(routes),
        "docs/generated/frontend_entrypoints.md": render_frontend_entrypoints_generated(entrypoints),
        "docs/generated/file_manifest.md": render_manifest_generated(manifest),
    }


def scaffold_missing(templates: Mapping[str, str]) -> List[str]:
    created: List[str] = []
    for rel in sorted(templates):
        path = REPO_ROOT / rel
        if path.exists():
            continue
        write_text(path, templates[rel])
        created.append(rel)
    return created


def apply_write(templates: Mapping[str, str]) -> Tuple[List[str], List[str]]:
    created = scaffold_missing(templates)

    routes = parse_app_server_routes()
    entrypoints = parse_frontend_entrypoints()
    manifest = collect_manifest()
    path_functions, constants = parse_config_signals()
    package_info = parse_package_json()

    blocks = build_autogen_blocks(routes, entrypoints, path_functions, constants, package_info)
    generated_files = generated_docs_payload(routes, entrypoints, manifest)

    changed: List[str] = []

    for rel, payload in generated_files.items():
        if maybe_write_text(REPO_ROOT / rel, payload):
            changed.append(rel)

    for rel in sorted(module_specs().keys()):
        path = REPO_ROOT / rel
        if not path.exists():
            continue
        src = read_text(path)
        dst = apply_auto_blocks(src, blocks)
        if dst != src:
            write_text(path, dst)
            changed.append(rel)

    return created, sorted(dict.fromkeys(changed))


def validate_docs_links() -> List[str]:
    broken: List[str] = []
    if not DOCS_ROOT.exists():
        return ["docs/ directory does not exist."]
    md_files = sorted(DOCS_ROOT.rglob("*.md"))
    for md in md_files:
        text = read_text(md)
        for link in MD_LINK_RE.findall(text):
            target = link.strip()
            if not target:
                continue
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            if target.startswith("#"):
                continue
            target = target.split("#", 1)[0].strip()
            if not target:
                continue
            resolved = (md.parent / target).resolve()
            if not resolved.exists():
                broken.append(f"{to_posix(md.relative_to(REPO_ROOT))}: broken link -> {link}")
    return broken


def extract_manual_section(text: str, section: str) -> Optional[str]:
    pattern = re.compile(
        rf"^## {re.escape(section)}\n<!-- MANUAL:BEGIN -->\n(?P<body>.*?)\n<!-- MANUAL:END -->",
        flags=re.DOTALL | re.MULTILINE,
    )
    match = pattern.search(text)
    if not match:
        return None
    return match.group("body").strip()


def validate_frontend_purpose_sections() -> List[str]:
    issues: List[str] = []
    for meta in FRONTEND_DOC_META.values():
        rel = str(meta["doc"])
        path = REPO_ROOT / rel
        if not path.exists():
            continue
        body = extract_manual_section(read_text(path), "Purpose")
        if body is None:
            continue
        nonblank_lines = [line for line in body.splitlines() if line.strip()]
        if len(nonblank_lines) > FRONTEND_PURPOSE_MAX_LINES or len(body) > FRONTEND_PURPOSE_MAX_CHARS:
            issues.append(
                f"{rel}: Purpose section is too long "
                f"({len(nonblank_lines)} lines, {len(body)} chars; "
                f"limit {FRONTEND_PURPOSE_MAX_LINES} lines / {FRONTEND_PURPOSE_MAX_CHARS} chars)"
            )
    return issues


def run_check(templates: Mapping[str, str]) -> Tuple[int, List[str]]:
    issues: List[str] = []

    for rel in sorted(templates):
        if not (REPO_ROOT / rel).exists():
            issues.append(f"Missing required file: {rel}")

    routes = parse_app_server_routes()
    entrypoints = parse_frontend_entrypoints()
    manifest = collect_manifest()
    path_functions, constants = parse_config_signals()
    package_info = parse_package_json()

    blocks = build_autogen_blocks(routes, entrypoints, path_functions, constants, package_info)
    generated_files = generated_docs_payload(routes, entrypoints, manifest)

    for rel, expected in generated_files.items():
        path = REPO_ROOT / rel
        if not path.exists():
            issues.append(f"Missing generated file: {rel}")
            continue
        actual = read_text(path)
        if actual != expected:
            issues.append(f"Generated file is stale: {rel}")

    for rel, spec in module_specs().items():
        path = REPO_ROOT / rel
        if not path.exists():
            continue
        actual = read_text(path)
        labels = set(extract_auto_labels(actual))
        required = set(spec.auto_sections.values())
        missing_labels = sorted(required - labels)
        for label in missing_labels:
            issues.append(f"Missing AUTO-GEN label `{label}` in {rel}")
        expected = apply_auto_blocks(actual, blocks)
        if expected != actual:
            issues.append(f"AUTO-GEN blocks are stale: {rel}")

    issues.extend(validate_docs_links())
    issues.extend(validate_frontend_purpose_sections())
    return (1 if issues else 0), issues


def print_list(title: str, items: Iterable[str]) -> None:
    print(title)
    for item in items:
        print(f"- {item}")


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(description="ArcRho documentation index builder")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--scaffold-missing", action="store_true", help="Create missing docs skeleton files")
    group.add_argument("--write", action="store_true", help="Update generated docs and AUTO-GEN blocks")
    group.add_argument("--check", action="store_true", help="Check if docs are up-to-date")
    args = parser.parse_args(argv)

    templates = scaffold_templates()

    if args.scaffold_missing:
        created = scaffold_missing(templates)
        if created:
            print_list("Created files:", created)
        else:
            print("No missing files.")
        return 0

    if args.write:
        created, changed = apply_write(templates)
        if created:
            print_list("Created files:", created)
        if changed:
            print_list("Updated files:", changed)
        else:
            print("No changes.")
        return 0

    code, issues = run_check(templates)
    if code == 0:
        print("Documentation is up-to-date.")
        return 0
    print_list("Documentation check failed:", issues)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
