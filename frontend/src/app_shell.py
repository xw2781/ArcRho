from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
RESTART_FLAG = BASE_DIR / ".restart_app"
SHUTDOWN_FLAG = BASE_DIR / ".shutdown_app"


def build_cmd(host: str, port: int, reload: bool) -> list[str]:
    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "app:app",
        "--host",
        host,
        "--port",
        str(port),
    ]
    if reload:
        cmd.append("--reload")
    return cmd


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


def ensure_env_defaults(env: dict[str, str]) -> dict[str, str]:
    env = dict(env)
    env.setdefault("TRI_DATA_DIR", str(BASE_DIR))
    env.setdefault("ADAS_WORKFLOW_DIR", str(Path.home() / "Documents" / "ADAS" / "workflows"))
    return env


def run_supervisor(host: str, port: int, reload: bool) -> None:
  env = ensure_env_defaults(os.environ)
  cmd = build_cmd(host, port, reload)
  if os.name == "nt":
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NEW_CONSOLE
  else:
    creationflags = 0

  while True:
    if SHUTDOWN_FLAG.exists():
      try:
        SHUTDOWN_FLAG.unlink()
      except Exception:
        pass
      break
    if RESTART_FLAG.exists():
      try:
        RESTART_FLAG.unlink()
      except Exception:
        pass

    proc = subprocess.Popen(
      cmd,
      cwd=str(BASE_DIR),
      env=env,
      creationflags=creationflags,
    )

    while True:
      if proc.poll() is not None:
        code = proc.returncode
        print(f"uvicorn exited with code {code}")
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

    time.sleep(0.5)


def main() -> None:
    parser = argparse.ArgumentParser(description="ADAS app supervisor")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    run_supervisor(args.host, args.port, args.reload)


if __name__ == "__main__":
    main()
