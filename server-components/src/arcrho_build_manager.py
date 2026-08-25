"""Desktop control surface for building, deploying, and running components.

Run it on the machine that owns the ArcRho Server workspace and turn on
"Listen for build requests" to service remote build requests from client
machines; see ``arcrho_build_listener`` for why a client asks instead of
deploying across the share itself.

The component table, freshness rule, and instance helpers live in
``arcrho_build_components`` so this GUI and the client CLI cannot disagree
about which components a change makes stale.
"""

from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

from arcrho_build_components import (
    COMPONENTS,
    DEPLOY_ROOT,
    Component,
    auto_listen_decision,
    build_freshness,
    list_instance_files,
    remove_instance_file,
    stale_components,
)
from arcrho_build_listener import BuildListener
from build_runtime import build_python_executable
from arcrho_build_request_contract import build_requests_directory


CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


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
        self.listener = BuildListener(DEPLOY_ROOT, log=self._log)

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._maybe_auto_listen()
        self.refresh_status()
        self.after(3000, self.auto_refresh_status)
        self.after(150, self._drain_log_queue)

    def _build_ui(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        toolbar = ttk.Frame(self, padding=(10, 10, 10, 6))
        toolbar.grid(row=0, column=0, sticky="ew")
        toolbar.columnconfigure(7, weight=1)

        ttk.Button(toolbar, text="Refresh", command=self.refresh_status).grid(row=0, column=0, padx=(0, 6))
        ttk.Button(toolbar, text="Run Selected", command=self.run_selected).grid(row=0, column=1, padx=6)
        ttk.Button(toolbar, text="Build Selected", command=self.build_selected).grid(row=0, column=2, padx=6)
        ttk.Button(toolbar, text="Build Stale", command=self.build_stale).grid(row=0, column=3, padx=6)
        ttk.Button(toolbar, text="Stop Selected", command=self.kill_selected).grid(row=0, column=4, padx=6)
        ttk.Button(toolbar, text="Stop Builds", command=self.stop_builds).grid(row=0, column=5, padx=6)

        self.listen_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            toolbar,
            text="Listen for build requests",
            variable=self.listen_var,
            command=self.toggle_listener,
        ).grid(row=0, column=6, padx=(18, 6))

        self.deploy_label = ttk.Label(toolbar, text=f"Deploy: {DEPLOY_ROOT}")
        self.deploy_label.grid(row=0, column=7, sticky="e")

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

    def _maybe_auto_listen(self) -> None:
        """Tick the box for the machine builds belong on.

        On the Server PC, in the clone the listener owns, turning this on was
        the same action every time and the only thing standing between a
        queued request and a build. Anywhere else it stays off and says why,
        because a listener resets the clone it was started from.
        """

        allowed, reason = auto_listen_decision()
        if not allowed:
            self._log(f"Not listening automatically: {reason}.")
            return
        self.listen_var.set(True)
        self.toggle_listener()
        if self.listen_var.get():
            self._log("Listening automatically: the Server PC, in the listener's own clone.")

    def toggle_listener(self) -> None:
        """Start or stop servicing remote build requests.

        This is the one action a client cannot perform for itself, which is why
        the client CLI's only human-facing instruction is to come here and turn
        it on -- except on the Server PC in the listener's own clone, where
        :meth:`_maybe_auto_listen` has already done it.
        """

        if self.listen_var.get():
            try:
                self.listener.start()
            except Exception as exc:  # noqa: BLE001 - surface the reason in the UI
                self.listen_var.set(False)
                messagebox.showerror("Listen for build requests", str(exc))
                self._log(f"Could not start the build listener: {exc}")
                return
            self.status_var.set(f"Listening: {build_requests_directory(DEPLOY_ROOT)}")
        else:
            self.listener.stop()
            self.status_var.set("Not listening for build requests")

    def _on_close(self) -> None:
        self.listener.stop()
        self.destroy()

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

    def build_stale(self) -> None:
        components = stale_components()
        if not components:
            messagebox.showinfo("Build Stale", "Every deployed component is up to date.")
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
        # Not sys.executable: build_manager.bat falls back to ``pyw -3``, which
        # picks the newest interpreter on the machine, and a build under anything
        # but 3.10 is refused by require_python_310.
        cmd = [build_python_executable(), str(component.build_script)]
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
