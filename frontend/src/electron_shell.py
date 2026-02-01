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


def start_electron(env: dict) -> subprocess.Popen:
    npm_cmd, env = resolve_npm_cmd(BASE_DIR)
    cmd = npm_cmd + ["run", "electron"]
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        creationflags = 0
    return subprocess.Popen(cmd, cwd=str(BASE_DIR), env=env, creationflags=creationflags)


def run_shell() -> None:
    env = os.environ.copy()
    while True:
        proc = start_electron(env)

        while True:
            if proc.poll() is not None:
                break
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
                break
            time.sleep(0.4)

        time.sleep(0.6)


def main() -> None:
    parser = argparse.ArgumentParser(description="Electron supervisor")
    parser.parse_args()
    run_shell()


if __name__ == "__main__":
    main()
