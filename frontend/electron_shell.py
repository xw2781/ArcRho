from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
RESTART_FLAG = BASE_DIR / ".restart_electron"
SHUTDOWN_FLAG = BASE_DIR / ".shutdown_electron"


def resolve_npm_cmd(base_dir: Path) -> tuple[list[str], dict]:
    node_home = base_dir / "node-portable"
    env = os.environ.copy()
    if (node_home / "node.exe").exists():
        env["PATH"] = f"{node_home};{env.get('PATH','')}"
        npm_cmd = [str(node_home / "npm.cmd")]
    else:
        npm_cmd = ["npm.cmd"]
    return npm_cmd, env


def terminate_process_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def child_output_streams() -> dict:
    """Give the child valid stdout/stderr handles when this process has none.

    The launcher runs the supervisor under pythonw.exe so no console window appears.
    A GUI-subsystem interpreter with no console has `sys.stdout`/`sys.stderr` set to
    None, and a child that inherits those handles cannot write to them - uvicorn logs
    to stderr on startup, so the app server died with exit code 1 before binding its
    port. Redirecting to the null device keeps the whole chain writable. When the
    supervisor does have streams, the child keeps inheriting them so console launches
    still show output.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return {}
    return {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}


def start_electron(env: dict, mode: str) -> subprocess.Popen:
    npm_cmd, env = resolve_npm_cmd(BASE_DIR)
    cmd = npm_cmd + ["--silent", "run", "arcode" if mode == "arcode" else "electron"]
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    else:
        creationflags = 0
    return subprocess.Popen(
        cmd,
        cwd=str(BASE_DIR),
        env=env,
        creationflags=creationflags,
        **child_output_streams(),
    )


def run_shell(mode: str) -> None:
    env = os.environ.copy()
    if mode == "arcode":
        env["ARCRHO_APP_MODE"] = "arcode"
    while True:
        proc = start_electron(env, mode)

        # A relaunch happens only when a restart was explicitly requested. Electron
        # exiting on its own means the user closed the app or it crashed; relaunching
        # then made the app impossible to close, because the supervisor immediately
        # replaced every window the user shut.
        restart_requested = False

        while True:
            # Read the control flags before the process state. A restart force-kills
            # Electron, so an exited process on its own cannot distinguish a restart
            # from the user quitting.
            if SHUTDOWN_FLAG.exists():
                try:
                    SHUTDOWN_FLAG.unlink()
                except Exception:
                    pass
                terminate_process_tree(proc)
                return
            if RESTART_FLAG.exists():
                try:
                    RESTART_FLAG.unlink()
                except Exception:
                    pass
                terminate_process_tree(proc)
                restart_requested = True
                break
            if proc.poll() is not None:
                break
            time.sleep(0.4)

        if not restart_requested:
            return

        time.sleep(0.6)


def main() -> None:
    parser = argparse.ArgumentParser(description="Electron supervisor")
    parser.add_argument("--mode", choices=["arcrho", "arcode"], default=os.environ.get("ARCRHO_APP_MODE", "arcrho"))
    args = parser.parse_args()
    run_shell("arcode" if args.mode == "arcode" else "arcrho")


if __name__ == "__main__":
    main()
