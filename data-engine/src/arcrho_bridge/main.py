import argparse
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

_MODULE_ROOT = Path(__file__).resolve().parent
_SOURCE_ROOT = _MODULE_ROOT.parent
_PRODUCT_ROOT = _SOURCE_ROOT.parent
_BUNDLE_ROOT = Path(getattr(sys, "_MEIPASS", _MODULE_ROOT)).resolve()
_EXE_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else None
_DEPLOY_ROOT = Path(os.environ.get("ARCRHO_DEPLOY_ROOT", r"E:\ArcRho Server"))

if "ARCRHO_ROOT" not in os.environ:
    if _EXE_DIR and _EXE_DIR.name.lower() == "apps":
        os.environ["ARCRHO_ROOT"] = str(_EXE_DIR.parent)
    elif _EXE_DIR and _EXE_DIR.parent.name.lower() == "apps":
        os.environ["ARCRHO_ROOT"] = str(_EXE_DIR.parent.parent)
    elif not getattr(sys, "frozen", False):
        os.environ["ARCRHO_ROOT"] = str(_DEPLOY_ROOT)

for _path in (_PRODUCT_ROOT, _SOURCE_ROOT, _BUNDLE_ROOT):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

try:
    from src.arcrho_bridge.bridge_utils import (
        RESQ_WINDOW_TITLE,
        heartbeat_payload,
        list_instance_files,
        list_json_files_by_mtime,
        read_json,
        remove_old_instances,
        safe_remove,
        window_is_active,
        write_json,
    )
    from src.arcrho_bridge.resq_client import ResQClient
    from src.utils import get_config_value, get_project_root, normalize_function_name, resolve_app_path
except ModuleNotFoundError:
    from arcrho_bridge.bridge_utils import (
        RESQ_WINDOW_TITLE,
        heartbeat_payload,
        list_instance_files,
        list_json_files_by_mtime,
        read_json,
        remove_old_instances,
        safe_remove,
        window_is_active,
        write_json,
    )
    from arcrho_bridge.resq_client import ResQClient
    from utils import get_config_value, get_project_root, normalize_function_name, resolve_app_path


BRIDGE_ROLE = "bridge"
WORKER_ROLE = "bridge_worker"
REQUEST_SUBDIR = "RPC bridge"
WORKER_STALE_AFTER_SECONDS = 6


def normalize_method_name(method_name):
    return re.sub(r"\s+", " ", str(method_name or "")).strip()


def make_instance_id(role):
    device_name = os.environ.get("COMPUTERNAME", "UNKNOWN")
    ts = datetime.now().strftime("%y%m%d-%H%M%S-%f")[:-3]
    return f"{role}@{device_name}@{os.getlogin()}@{ts}"


def instance_path(role, instance_id):
    return resolve_app_path(role, "instances", f"{instance_id}.json")


def request_dir():
    path = get_project_root() / "requests" / REQUEST_SUBDIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def worker_instance_folder():
    path = resolve_app_path(WORKER_ROLE, "instances")
    path.mkdir(parents=True, exist_ok=True)
    return path


def live_worker_count():
    remove_old_instances(worker_instance_folder(), WORKER_STALE_AFTER_SECONDS)
    return len(list_instance_files(worker_instance_folder()))


def remove_worker_heartbeats():
    for path in list_instance_files(worker_instance_folder()):
        safe_remove(path)


def worker_command():
    if getattr(sys, "frozen", False):
        return [sys.executable, "--worker"]
    return [sys.executable, str(Path(__file__).resolve()), "--worker"]


def start_worker():
    return subprocess.Popen(worker_command(), close_fds=True)


def stop_worker(process, timeout=2.0):
    if process is None:
        return None
    if process.poll() is not None:
        return None
    process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=timeout)
    return None


def run_bridge_supervisor():
    bridge_id = make_instance_id(BRIDGE_ROLE)
    id_path = instance_path(BRIDGE_ROLE, bridge_id)
    id_path.parent.mkdir(parents=True, exist_ok=True)
    worker_process = None

    print("Bridge ID: " + bridge_id + "\n")
    write_json(id_path, heartbeat_payload(bridge_id, BRIDGE_ROLE, Created=datetime.now().strftime("%Y-%m-%d %H:%M:%S")))

    try:
        while True:
            if not id_path.exists() or get_config_value("apps.bridge.kill_all", False):
                remove_worker_heartbeats()
                worker_process = stop_worker(worker_process)
                safe_remove(id_path)
                break

            gui_running = window_is_active(RESQ_WINDOW_TITLE)
            write_json(
                id_path,
                heartbeat_payload(
                    bridge_id,
                    BRIDGE_ROLE,
                    ResQGuiRunning=gui_running,
                    WorkerPid=worker_process.pid if worker_process and worker_process.poll() is None else None,
                ),
            )

            if worker_process and worker_process.poll() is not None:
                worker_process = None

            if get_config_value("apps.bridge_worker.kill_all", False):
                remove_worker_heartbeats()
                worker_process = stop_worker(worker_process, timeout=0.5)
                time.sleep(2)
                continue

            if not gui_running:
                remove_worker_heartbeats()
                worker_process = stop_worker(worker_process, timeout=0.5)
            elif (
                live_worker_count() < int(get_config_value("apps.bridge.max_workers", 1))
                and worker_process is None
            ):
                worker_process = start_worker()

            time.sleep(2)
    except KeyboardInterrupt:
        worker_process = stop_worker(worker_process)
    finally:
        safe_remove(id_path)


class BridgeRequestHandler(FileSystemEventHandler):
    def __init__(self, client):
        self.client = client

    def on_moved(self, event):
        if event.is_directory:
            return
        self._handle_path(event.dest_path)

    def on_created(self, event):
        if event.is_directory:
            return
        self._handle_path(event.src_path)

    def process_pending(self, folder):
        for path in list_json_files_by_mtime(folder):
            self.process_file(path)

    def _handle_path(self, path):
        if str(path).lower().endswith(".json"):
            self.process_file(Path(path))

    def process_file(self, path):
        try:
            request = read_json(path)
        except Exception:
            return

        if not safe_remove(path):
            return

        try:
            function_name = normalize_function_name(request.get("Function", ""))
            if function_name == "DFM":
                request["MethodName"] = normalize_method_name(request.get("MethodName", ""))
                self._validate_request(request)
                self.client.write_dfm_payload(request)
            elif function_name == "SyncDFM":
                request["MethodName"] = normalize_method_name(request.get("MethodName", ""))
                self._validate_request(request)
                self._validate_sync_dfm_request(request)
                self.client.write_sync_dfm_payload(request)
            else:
                self.client.write_error(request, f"Invalid function name: {request.get('Function', '')}")
        except Exception as exc:
            self.client.write_error(request, exc)

    def _validate_request(self, request):
        missing = [
            key
            for key in (
                "Function",
                "ProjectName",
                "Path",
                "MethodName",
                "DataPath",
                "UserName",
            )
            if not request.get(key)
        ]
        if missing:
            raise ValueError("Missing request field(s): " + ", ".join(missing))

    def _validate_sync_dfm_request(self, request):
        missing = [
            key
            for key in (
                "MethodJsonPath",
                "RPCServerWriteConfirmed",
            )
            if not request.get(key)
        ]
        if missing:
            raise ValueError("Missing SyncDFM request field(s): " + ", ".join(missing))
        if str(request.get("RPCServerWriteConfirmed", "")).strip().lower() not in {"1", "true", "yes"}:
            raise ValueError("SyncDFM requires explicit RPC server write confirmation.")


def run_bridge_worker():
    if not window_is_active(RESQ_WINDOW_TITLE):
        return

    worker_id = make_instance_id(WORKER_ROLE)
    id_path = instance_path(WORKER_ROLE, worker_id)
    id_path.parent.mkdir(parents=True, exist_ok=True)

    print("Bridge Worker ID: " + worker_id + "\n")
    client = ResQClient()
    write_json(id_path, heartbeat_payload(worker_id, WORKER_ROLE, Created=datetime.now().strftime("%Y-%m-%d %H:%M:%S"), ResQGuiRunning=True))
    handler = BridgeRequestHandler(client)
    observer = Observer()
    folder = request_dir()
    observer.schedule(handler, str(folder), recursive=False)
    observer.start()
    handler.process_pending(folder)

    try:
        while True:
            if not id_path.exists():
                observer.stop()
                break
            if get_config_value("apps.bridge_worker.kill_all", False):
                safe_remove(id_path)
                observer.stop()
                break
            if not window_is_active(RESQ_WINDOW_TITLE):
                safe_remove(id_path)
                observer.stop()
                break
            client.disconnect_if_idle()
            write_json(id_path, heartbeat_payload(worker_id, WORKER_ROLE, ResQGuiRunning=True))
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    finally:
        client.close()
        observer.join()
        safe_remove(id_path)


def main():
    parser = argparse.ArgumentParser(description="Run ArcRho Bridge.")
    parser.add_argument("--worker", action="store_true", help="Run as the ResQ-connected bridge worker.")
    args = parser.parse_args()

    if args.worker:
        run_bridge_worker()
    else:
        run_bridge_supervisor()


if __name__ == "__main__":
    main()
