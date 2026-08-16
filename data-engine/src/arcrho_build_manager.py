from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import messagebox, ttk

# The Bridge owns the list of repository trees it freezes; read it rather than
# restating it, so a change to what the Bridge bundles cannot silently stop
# being reported as stale here.
from arcrho_bridge.bundled_sources import BUNDLED_SOURCE_ROOTS
from utils import SERVER_COMPONENT_ROLES, component_app_name


BASE_DIR = Path(__file__).resolve().parent
DATA_ENGINE_ROOT = BASE_DIR.parent
DEPLOY_ROOT = Path(os.environ.get("ARCRHO_DEPLOY_ROOT", r"E:\ArcRho Server"))
APPS_DIR = DEPLOY_ROOT / "apps"
INSTANCES_DIR = DEPLOY_ROOT / "runtime" / "instances"

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
SOURCE_EXTENSIONS = {".html", ".ico", ".json", ".py", ".txt"}
# "logs" holds run output, not source; counting it reports a component as stale
# every time it runs.
SOURCE_SKIP_DIRS = {"__pycache__", "build", "dist", "logs", "spec"}


@dataclass(frozen=True)
class Component:
    key: str
    label: str
    source_dir: Path
    exe_name: str
    instance_roles: tuple[str, ...]
    # Repository trees outside source_dir that the component freezes into its
    # executable. Editing one of these leaves the deployed app stale even though
    # source_dir is untouched, so freshness has to consider them too.
    bundled_source_roots: tuple[Path, ...] = ()

    @property
    def build_script(self) -> Path:
        return self.source_dir / "build_exe.py"

    @property
    def deploy_exe(self) -> Path:
        return APPS_DIR / Path(self.exe_name).stem / self.exe_name

    @property
    def freshness_source_dirs(self) -> tuple[Path, ...]:
        return (self.source_dir, *self.bundled_source_roots)


SHARED_COMPONENT_SOURCES = (
    BASE_DIR / "utils.py",
    BASE_DIR / "server_config.py",
    BASE_DIR / "build_runtime.py",
)


def _build_component(role: str) -> Component:
    if role == "launcher":
        instance_roles = ()
    elif role == "bridge":
        instance_roles = ("arcrho_bridge", "arcrho_bridge_worker")
    else:
        instance_roles = (f"arcrho_{role}",)
    role_sources = BUNDLED_SOURCE_ROOTS if role == "bridge" else ()
    return Component(
        role,
        "Admin Control" if role == "admin" else role.title(),
        BASE_DIR / f"arcrho_{role}",
        f"{component_app_name(role)}.exe",
        instance_roles,
        bundled_source_roots=(*role_sources, *SHARED_COMPONENT_SOURCES),
    )


MANAGED_COMPONENT_ROLES = (*SERVER_COMPONENT_ROLES, "gateway")
COMPONENTS = tuple(_build_component(role) for role in MANAGED_COMPONENT_ROLES)


def instance_folder(role: str) -> Path:
    return INSTANCES_DIR / role


def read_json(path: Path) -> dict[str, object]:
    try:
        with open(path, mode="r", encoding="utf-8") as file:
            payload = json.load(file)
            return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def list_instance_files(component: Component) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for role in component.instance_roles:
        folder = instance_folder(role)
        if not folder.exists():
            continue
        for path in sorted(folder.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            payload = read_json(path)
            rows.append(
                {
                    "role": role,
                    "path": path,
                    "name": path.name,
                    "server": payload.get("Server") or path.stem,
                    "user": payload.get("User") or "",
                    "last_seen": payload.get("Last seen") or "",
                    "age": max(0, int(time.time() - path.stat().st_mtime)),
                }
            )
    return rows


def latest_source_timestamp(component: Component) -> float | None:
    latest: float | None = None
    for root in component.freshness_source_dirs:
        if not root.exists():
            continue
        candidates = (root,) if root.is_file() else root.rglob("*")
        for path in candidates:
            if not path.is_file():
                continue
            if any(part in SOURCE_SKIP_DIRS for part in path.relative_to(root).parts[:-1]):
                continue
            if path.suffix.lower() not in SOURCE_EXTENSIONS:
                continue
            try:
                timestamp = path.stat().st_mtime
            except OSError:
                continue
            latest = timestamp if latest is None else max(latest, timestamp)
    return latest


def build_freshness(component: Component) -> str:
    exe_path = component.deploy_exe
    if not exe_path.exists():
        return "Missing EXE"

    latest_source = latest_source_timestamp(component)
    if latest_source is None:
        return "No source"

    try:
        exe_timestamp = exe_path.stat().st_mtime
    except OSError:
        return "EXE inaccessible"

    return "Updated" if exe_timestamp >= latest_source else "Source newer"


def remove_instance_file(path: Path, attempts: int = 5, delay: float = 0.1) -> bool:
    resolved = path.resolve()
    instances_root = INSTANCES_DIR.resolve()
    if instances_root not in resolved.parents:
        raise ValueError(f"Refusing to remove file outside instances folder: {path}")

    for _ in range(attempts):
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False
        except PermissionError:
            time.sleep(delay)
    path.unlink()
    return True


class BuildManagerApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("ArcRho Build Manager")
        self.geometry("1220x680")
        self.minsize(1060, 560)

        self.log_queue: queue.Queue[str] = queue.Queue()
        self.running_builds: dict[str, subprocess.Popen[str]] = {}
        self.component_rows: dict[str, str] = {}
        self.instance_rows: dict[str, list[dict[str, object]]] = {}
        self.refresh_running = False

        self._build_ui()
        self.refresh_status()
        self.after(3000, self.auto_refresh_status)
        self.after(150, self._drain_log_queue)

    def _build_ui(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        toolbar = ttk.Frame(self, padding=(10, 10, 10, 6))
        toolbar.grid(row=0, column=0, sticky="ew")
        toolbar.columnconfigure(6, weight=1)

        ttk.Button(toolbar, text="Refresh", command=self.refresh_status).grid(row=0, column=0, padx=(0, 6))
        ttk.Button(toolbar, text="Run Selected", command=self.run_selected).grid(row=0, column=1, padx=6)
        ttk.Button(toolbar, text="Build Selected", command=self.build_selected).grid(row=0, column=2, padx=6)
        ttk.Button(toolbar, text="Stop Selected", command=self.kill_selected).grid(row=0, column=3, padx=6)
        ttk.Button(toolbar, text="Stop Builds", command=self.stop_builds).grid(row=0, column=4, padx=6)

        self.deploy_label = ttk.Label(toolbar, text=f"Deploy: {DEPLOY_ROOT}")
        self.deploy_label.grid(row=0, column=6, sticky="e")

        main = ttk.PanedWindow(self, orient=tk.VERTICAL)
        main.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))

        table_frame = ttk.Frame(main)
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)
        main.add(table_frame, weight=3)

        columns = ("component", "exe", "status", "updated", "instances", "path")
        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings", selectmode="extended")
        self.tree.heading("component", text="Component")
        self.tree.heading("exe", text="EXE")
        self.tree.heading("status", text="Status")
        self.tree.heading("updated", text="Updated")
        self.tree.heading("instances", text="Instances")
        self.tree.heading("path", text="Deploy Path")
        self.tree.column("component", width=150, anchor="w")
        self.tree.column("exe", width=210, anchor="w")
        self.tree.column("status", width=120, anchor="w")
        self.tree.column("updated", width=110, anchor="w")
        self.tree.column("instances", width=220, anchor="w")
        self.tree.column("path", width=400, anchor="w")
        self.tree.grid(row=0, column=0, sticky="nsew")

        scroll = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.tree.configure(yscrollcommand=scroll.set)

        log_frame = ttk.Frame(main)
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        main.add(log_frame, weight=2)

        self.log = tk.Text(log_frame, wrap="word", height=12, state="disabled")
        self.log.grid(row=0, column=0, sticky="nsew")
        log_scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log.yview)
        log_scroll.grid(row=0, column=1, sticky="ns")
        self.log.configure(yscrollcommand=log_scroll.set)

        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(self, textvariable=self.status_var, anchor="w", padding=(10, 0, 10, 8)).grid(
            row=2, column=0, sticky="ew"
        )

    def selected_components(self) -> list[Component]:
        selected = set(self.tree.selection())
        return [component for component in COMPONENTS if self.component_rows.get(component.key) in selected]

    def refresh_status(self) -> None:
        if self.refresh_running:
            return
        self.refresh_running = True

        def worker() -> None:
            snapshot: dict[str, dict[str, object]] = {}
            try:
                for component in COMPONENTS:
                    snapshot[component.key] = {
                        "instances": list_instance_files(component),
                        "freshness": build_freshness(component),
                    }
            finally:
                self.after(0, lambda: self._apply_status(snapshot))

        threading.Thread(target=worker, daemon=True).start()

    def _apply_status(self, snapshot: dict[str, dict[str, object]]) -> None:
        self.refresh_running = False
        self.instance_rows = {
            key: list(value.get("instances", []))
            for key, value in snapshot.items()
        }
        for component in COMPONENTS:
            component_snapshot = snapshot.get(component.key, {})
            rows = list(component_snapshot.get("instances", []))
            freshness = str(component_snapshot.get("freshness", "Unknown"))
            instances = ", ".join(str(row["server"]) for row in rows)
            if rows:
                status = f"Running ({len(rows)})"
            elif component.instance_roles:
                status = "Stopped"
            else:
                status = "No heartbeat"
            values = (
                component.label,
                component.exe_name,
                status,
                freshness,
                instances,
                str(component.deploy_exe),
            )
            item_id = self.component_rows.get(component.key)
            if item_id is None:
                self.component_rows[component.key] = self.tree.insert("", "end", values=values)
            else:
                self.tree.item(item_id, values=values)
        self.status_var.set("Status refreshed")

    def auto_refresh_status(self) -> None:
        self.refresh_status()
        self.after(3000, self.auto_refresh_status)

    def build_selected(self) -> None:
        components = self.selected_components()
        if not components:
            messagebox.showinfo("Build Selected", "Select one or more components first.")
            return
        self.start_builds(components)

    def run_selected(self) -> None:
        components = self.selected_components()
        if not components:
            messagebox.showinfo("Run Selected", "Select one or more components first.")
            return
        self.run_components(components)

    def run_components(self, components: list[Component]) -> None:
        for component in components:
            exe_path = component.deploy_exe
            if not exe_path.exists():
                self._log(f"[{component.label}] Missing deployed EXE: {exe_path}")
                continue
            try:
                subprocess.Popen(
                    [str(exe_path)],
                    cwd=str(exe_path.parent),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                    close_fds=True,
                    creationflags=CREATE_NO_WINDOW,
                )
                self._log(f"[{component.label}] Started: {exe_path}")
            except OSError as exc:
                self._log(f"[{component.label}] Could not start {exe_path}: {exc}")
        self.after(1000, self.refresh_status)

    def start_builds(self, components: list[Component]) -> None:
        buildable = [component for component in components if component.key not in self.running_builds]
        if not buildable:
            self._log("No new builds to start.")
            return
        for component in buildable:
            if not component.build_script.exists():
                self._log(f"[{component.label}] Missing build script: {component.build_script}")
                continue
            threading.Thread(target=self._run_build, args=(component,), daemon=True).start()
        self.status_var.set(f"Started {len(buildable)} build(s)")

    def _run_build(self, component: Component) -> None:
        env = os.environ.copy()
        env.setdefault("ARCRHO_DEPLOY_ROOT", str(DEPLOY_ROOT))
        cmd = [sys.executable, str(component.build_script)]
        self._log(f"[{component.label}] Starting: {' '.join(cmd)}")
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(component.source_dir),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                creationflags=CREATE_NO_WINDOW,
            )
        except OSError as exc:
            self._log(f"[{component.label}] Could not start build: {exc}")
            return

        self.running_builds[component.key] = proc
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                self._log(f"[{component.label}] {line.rstrip()}")
            code = proc.wait()
            self._log(f"[{component.label}] Build finished with exit code {code}")
        finally:
            self.running_builds.pop(component.key, None)
            self.after(0, self.refresh_status)

    def kill_selected(self) -> None:
        components = self.selected_components()
        if not components:
            messagebox.showinfo("Kill Selected", "Select one or more components first.")
            return
        self.kill_components(components)

    def kill_components(self, components: list[Component]) -> None:
        def worker() -> None:
            for component in components:
                if not component.instance_roles:
                    self._log(f"[{component.label}] No runtime instance heartbeat is implemented for this component.")
                    continue

                rows = list_instance_files(component)
                if not rows:
                    self._log(f"[{component.label}] No runtime instance files found.")
                    continue
                for row in rows:
                    removed = remove_instance_file(Path(row["path"]))
                    outcome = "removed signal file" if removed else "already gone"
                    self._log(f"[{component.label}] {outcome}: {row['path']}")
            self.after(0, self.refresh_status)

        threading.Thread(target=worker, daemon=True).start()

    def stop_builds(self) -> None:
        if not self.running_builds:
            self._log("No builds are running.")
            return
        for key, proc in list(self.running_builds.items()):
            component = next((item for item in COMPONENTS if item.key == key), None)
            label = component.label if component else key
            if proc.poll() is None:
                proc.terminate()
                self._log(f"[{label}] Build termination requested.")

    def _log(self, message: str) -> None:
        self.log_queue.put(message)

    def _drain_log_queue(self) -> None:
        while True:
            try:
                message = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self.log.configure(state="normal")
            self.log.insert("end", message + "\n")
            self.log.see("end")
            self.log.configure(state="disabled")
        self.after(150, self._drain_log_queue)


def main() -> int:
    app = BuildManagerApp()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
