import argparse
import json
import os
import re
import subprocess
import sys
import threading
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
    from src.arcrho_bridge.resq_import_contract import (
        load_resq_reserving_class_import_contract,
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
    from arcrho_bridge.resq_import_contract import (
        load_resq_reserving_class_import_contract,
    )
    from arcrho_bridge.resq_client import ResQClient
    from utils import get_config_value, get_project_root, normalize_function_name, resolve_app_path


RESQ_IMPORT_CONTRACT = load_resq_reserving_class_import_contract()
_RESQ_IMPORT_REQUEST_RELATIVE_DIR = RESQ_IMPORT_CONTRACT["request_relative_dir"]
_RESQ_IMPORT_STATUS_RELATIVE_DIR = RESQ_IMPORT_CONTRACT["status_relative_dir"]
_RESQ_IMPORT_HEARTBEAT_RELATIVE_DIR = RESQ_IMPORT_CONTRACT[
    "worker_heartbeat_relative_dir"
]

BRIDGE_ROLE = "bridge"
WORKER_ROLE = RESQ_IMPORT_CONTRACT["worker_role"]
REQUEST_SUBDIR = _RESQ_IMPORT_REQUEST_RELATIVE_DIR[1]
WORKER_STALE_AFTER_SECONDS = RESQ_IMPORT_CONTRACT[
    "worker_heartbeat_max_age_seconds"
]
REQUEST_POLL_INTERVAL_SECONDS = 1.0
IMPORT_HEARTBEAT_INTERVAL_SECONDS = 1.0

# A reserving-class import is intentionally isolated from both the legacy RPC
# queue and the data-engine's top-level ``requests`` queue. The latter is
# watched by ArcRho Engine workers, which must never claim a ResQ import.
RESQ_IMPORT_FUNCTION = RESQ_IMPORT_CONTRACT["function"]
RESQ_IMPORT_CONTRACT_VERSION = RESQ_IMPORT_CONTRACT["contract_version"]
_RESQ_IMPORT_REQUIRED_FIELDS = RESQ_IMPORT_CONTRACT["required_request_fields"]
_RESQ_IMPORT_FORBIDDEN_PATH_FIELDS = RESQ_IMPORT_CONTRACT["forbidden_path_fields"]
_RESQ_IMPORT_ALLOWED_EXPORT_MODES = frozenset(
    RESQ_IMPORT_CONTRACT["allowed_export_modes"]
)
_RESQ_IMPORT_STATUS_VALUES = frozenset(RESQ_IMPORT_CONTRACT["status_values"])
_RESQ_IMPORT_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_RESQ_IMPORT_INVALID_PROJECT_NAME_CHARS = frozenset('<>:"/\\|?*\x00')


def normalize_method_name(method_name):
    return re.sub(r"\s+", " ", str(method_name or "")).strip()


def make_instance_id(role):
    device_name = os.environ.get("COMPUTERNAME", "UNKNOWN")
    ts = datetime.now().strftime("%y%m%d-%H%M%S-%f")[:-3]
    return f"{role}@{device_name}@{os.getlogin()}@{ts}"


def instance_path(role, instance_id):
    return resolve_app_path(role, "instances", f"{instance_id}.json")


def request_dir():
    path = get_project_root().joinpath(*_RESQ_IMPORT_REQUEST_RELATIVE_DIR[:2])
    path.mkdir(parents=True, exist_ok=True)
    return path


def resq_import_queue_dir(server_root=None):
    """Return the logical shared-server queue root for ResQ RC imports.

    Callers exchange only logical project and reserving-class identifiers. In
    particular, no producer-local mapped-drive path is accepted in a request;
    each machine resolves this directory from its own ArcRho Server root.
    """

    root = Path(server_root) if server_root is not None else get_project_root()
    return root.joinpath(*_RESQ_IMPORT_REQUEST_RELATIVE_DIR[:-1])


def resq_import_request_dir(server_root=None):
    root = Path(server_root) if server_root is not None else get_project_root()
    path = root.joinpath(*_RESQ_IMPORT_REQUEST_RELATIVE_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


def resq_import_status_dir(server_root=None):
    root = Path(server_root) if server_root is not None else get_project_root()
    path = root.joinpath(*_RESQ_IMPORT_STATUS_RELATIVE_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


def resq_import_status_path(request_id, server_root=None):
    """Return the deterministic status path for one accepted import request."""

    normalized_id = _validate_resq_import_request_id(request_id)
    return resq_import_status_dir(server_root) / f"{normalized_id}.json"


def worker_instance_folder():
    path = resolve_app_path(WORKER_ROLE, "instances")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _resq_gui_is_running(value):
    """Accept only explicit true values from a worker heartbeat."""

    if isinstance(value, bool):
        return value
    return str(value or "").strip().casefold() in {"1", "true", "yes"}


def discover_fresh_bridge_worker_heartbeats(
    server_root=None,
    *,
    max_age_seconds=WORKER_STALE_AFTER_SECONDS,
    now=None,
):
    """Return fresh bridge-worker heartbeats without mutating the share.

    Modification time is deliberate: it works on mapped/UNC shares where
    filesystem-watch events can be delayed or dropped, and it does not depend
    on the submitting PC's local drive-letter alias.
    """

    if max_age_seconds < 0:
        raise ValueError("max_age_seconds must be non-negative.")

    root = Path(server_root) if server_root is not None else get_project_root()
    folder = root.joinpath(*_RESQ_IMPORT_HEARTBEAT_RELATIVE_DIR)
    observed_at = time.time() if now is None else float(now)
    fresh = []
    for path in list_json_files_by_mtime(folder):
        try:
            age_seconds = observed_at - path.stat().st_mtime
            if age_seconds < -max_age_seconds or age_seconds > max_age_seconds:
                continue
            payload = read_json(path)
        except OSError:
            # A heartbeat may disappear while its supervisor cleans it up.
            continue
        except Exception:
            # An incomplete or malformed heartbeat is not evidence of a live,
            # ResQ-connected worker.
            continue
        if (
            isinstance(payload, dict)
            and payload.get("Role") == WORKER_ROLE
            and _resq_gui_is_running(payload.get("ResQGuiRunning"))
        ):
            fresh.append(path)
    return tuple(sorted(fresh, key=lambda item: item.name.casefold()))


def live_worker_count():
    remove_old_instances(worker_instance_folder(), WORKER_STALE_AFTER_SECONDS)
    return len(discover_fresh_bridge_worker_heartbeats())


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


def _validate_resq_import_request_id(request_id):
    """Validate the token shared by a request and its deterministic status."""

    normalized_id = str(request_id or "").strip()
    if not _RESQ_IMPORT_REQUEST_ID_PATTERN.fullmatch(normalized_id):
        raise ValueError(
            "RequestId must contain 1-128 letters, numbers, underscores, or hyphens."
        )
    return normalized_id


def _validate_resq_import_project_name(project_name):
    """Return a one-segment logical ArcRho project identity."""

    if not isinstance(project_name, str):
        raise ValueError("ProjectName must be a string.")
    normalized_name = project_name.strip()
    if not normalized_name:
        raise ValueError("ProjectName is required.")
    if normalized_name in {".", ".."} or any(
        character in normalized_name
        for character in _RESQ_IMPORT_INVALID_PROJECT_NAME_CHARS
    ):
        raise ValueError("ProjectName must be one logical path segment.")
    return normalized_name


def _validate_resq_import_rc_path(rc_path):
    """Return a relative Windows ArcRho reserving-class identity."""

    if not isinstance(rc_path, str):
        raise ValueError("Path must be a string.")
    normalized_path = rc_path.strip().replace("/", "\\")
    if not normalized_path:
        raise ValueError("Path is required.")
    segments = [part.strip() for part in normalized_path.split("\\")]
    if (
        normalized_path.startswith("\\")
        or ":" in normalized_path
        or "\x00" in normalized_path
        or any(part in {"", ".", ".."} for part in segments)
    ):
        raise ValueError(
            "Path must be a relative Windows ArcRho reserving-class path without '..'."
        )
    return normalized_path


def _json_safe_status_value(value):
    """Convert a client callback/result to an atomic JSON status value."""

    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return str(value)


def _write_resq_import_status(request, status, *, message="", progress=None, result=None):
    """Atomically publish the deterministic import status for ``request``."""

    if status not in _RESQ_IMPORT_STATUS_VALUES:
        raise ValueError(f"Invalid ResQ import status: {status!r}")

    try:
        request_id = _validate_resq_import_request_id(request.get("RequestId"))
        status_path = resq_import_status_path(request_id)
    except Exception as exc:
        print(f"(error: could not resolve ResQ import status path: {exc})")
        return False

    payload = {
        "contract_version": RESQ_IMPORT_CONTRACT_VERSION,
        "status": status,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "request_id": request_id,
    }
    if message:
        payload["message"] = str(message)
    if progress is not None:
        normalized_progress = _json_safe_status_value(progress)
        payload["progress"] = (
            normalized_progress
            if isinstance(normalized_progress, dict)
            else {"message": str(normalized_progress)}
        )
    if result is not None:
        payload["result"] = _json_safe_status_value(result)

    try:
        if write_json(status_path, payload):
            return True
        print(f"(error: could not write ResQ import status to {status_path})")
    except Exception as exc:
        print(f"(error: could not write ResQ import status to {status_path}: {exc})")
    return False


class BridgeRequestHandler(FileSystemEventHandler):
    def __init__(
        self,
        client,
        *,
        worker_heartbeat=None,
        heartbeat_interval_sec=IMPORT_HEARTBEAT_INTERVAL_SECONDS,
    ):
        self.client = client
        # Watchdog callbacks run on a separate thread, while ResQ COM belongs
        # to the worker thread. Events therefore only request a main-thread
        # scan; they must never invoke ``process_file`` directly.
        self._scan_requested = threading.Event()
        self._process_lock = threading.Lock()
        self._worker_heartbeat = worker_heartbeat
        self._heartbeat_interval_sec = float(heartbeat_interval_sec)

    def on_moved(self, event):
        if event.is_directory:
            return
        self._request_scan(event.dest_path)

    def on_created(self, event):
        if event.is_directory:
            return
        self._request_scan(event.src_path)

    def consume_scan_request(self):
        """Return whether a watchdog event requested a worker-thread scan."""

        if not self._scan_requested.is_set():
            return False
        self._scan_requested.clear()
        return True

    def process_pending(self, folder):
        """Claim pending requests in deterministic mtime order.

        The worker thread periodically calls this even when a mapped/UNC
        filesystem does not reliably deliver a watchdog event.
        """

        for path in list_json_files_by_mtime(folder):
            if not self.process_file(path):
                break

    def _request_scan(self, path):
        if str(path).lower().endswith(".json"):
            self._scan_requested.set()

    def process_file(self, path):
        if not self._process_lock.acquire(blocking=False):
            return False
        try:
            return self._process_claimed_file(path)
        finally:
            self._process_lock.release()

    def _process_claimed_file(self, path):
        try:
            request = read_json(path)
        except Exception:
            return True

        if not isinstance(request, dict):
            # A valid JSON value that is not an object cannot have a stable
            # RequestId/status path. Claim it so a malformed queue item cannot
            # block every periodic scan forever.
            safe_remove(path)
            return True

        # Every bridge worker sees the same request directory. Claim first,
        # before validation or output, so exactly one worker processes it.
        if not safe_remove(path):
            return True

        function_name = normalize_function_name(request.get("Function", ""))
        if function_name == RESQ_IMPORT_FUNCTION:
            self._process_resq_import_request(request)
            return True

        try:
            if function_name == "DFM":
                request["MethodName"] = normalize_method_name(request.get("MethodName", ""))
                self._validate_request(request)
                self.client.write_dfm_payload(request)
            elif function_name == "ResultSelection":
                request["MethodName"] = str(request.get("MethodName", "")).strip()
                self._validate_request(request)
                self.client.write_result_selection_payload(request)
            elif function_name == "SyncDFM":
                request["MethodName"] = normalize_method_name(request.get("MethodName", ""))
                self._validate_request(request)
                self._validate_sync_dfm_request(request)
                self.client.write_sync_dfm_payload(request)
            elif function_name == "SyncResultSelection":
                request["MethodName"] = str(request.get("MethodName", "")).strip()
                self._validate_request(request)
                self._validate_sync_result_selection_request(request)
                self.client.write_sync_result_selection_payload(request)
            else:
                self.client.write_error(request, f"Invalid function name: {request.get('Function', '')}")
        except Exception as exc:
            self.client.write_error(request, exc)
        return True

    def _process_resq_import_request(self, request):
        # RequestId is the minimum needed to report rejection. All other
        # protocol validation happens after the processing marker, matching the
        # data-engine's request contract and making claim state observable.
        try:
            _validate_resq_import_request_id(request.get("RequestId"))
        except Exception:
            return

        if not _write_resq_import_status(request, "processing"):
            return

        try:
            self._validate_resq_import_request(request)
        except Exception as exc:
            _write_resq_import_status(request, "error", message=exc)
            return

        def publish_progress(progress):
            _write_resq_import_status(request, "processing", progress=progress)

        heartbeat_stop, heartbeat_thread = self._start_import_heartbeat()
        try:
            try:
                result = self.client.write_resq_reserving_class_import(
                    request,
                    progress_callback=publish_progress,
                )
            except Exception as exc:
                status_result = getattr(exc, "status_result", None)
                _write_resq_import_status(
                    request,
                    "error",
                    message=exc,
                    result=status_result if isinstance(status_result, dict) else None,
                )
                return
        finally:
            if heartbeat_stop is not None:
                heartbeat_stop.set()
            if heartbeat_thread is not None:
                heartbeat_thread.join(timeout=IMPORT_HEARTBEAT_INTERVAL_SECONDS)

        _write_resq_import_status(request, "success", result=result)

    def _start_import_heartbeat(self):
        """Keep the worker discoverable while its main thread runs ResQ COM work."""

        if not callable(self._worker_heartbeat):
            return None, None
        try:
            self._worker_heartbeat()
        except Exception:
            pass
        stop = threading.Event()

        def keepalive():
            while not stop.wait(self._heartbeat_interval_sec):
                try:
                    self._worker_heartbeat()
                except Exception:
                    # A heartbeat write is advisory. The import's own status
                    # writer remains responsible for reporting a real failure.
                    pass

        thread = threading.Thread(
            target=keepalive,
            name="arcrho-bridge-import-heartbeat",
            daemon=True,
        )
        thread.start()
        return stop, thread

    def _validate_resq_import_request(self, request):
        if str(request.get("Function") or "").strip() != RESQ_IMPORT_FUNCTION:
            raise ValueError(f"Function must be {RESQ_IMPORT_FUNCTION}.")

        version = request.get("ContractVersion")
        if isinstance(version, bool) or not isinstance(version, int):
            raise ValueError(
                f"ContractVersion must be the integer {RESQ_IMPORT_CONTRACT_VERSION}."
            )
        if version != RESQ_IMPORT_CONTRACT_VERSION:
            raise ValueError(
                f"Unsupported ContractVersion {version!r}; expected "
                f"{RESQ_IMPORT_CONTRACT_VERSION}."
            )

        _validate_resq_import_request_id(request.get("RequestId"))
        missing = []
        for key in _RESQ_IMPORT_REQUIRED_FIELDS:
            if key in {"Function", "ContractVersion", "RequestId"}:
                continue
            value = request.get(key)
            if not isinstance(value, str) or not value.strip():
                missing.append(key)
            else:
                request[key] = value.strip()
        if missing:
            raise ValueError("Missing request field(s): " + ", ".join(missing))

        request["ProjectName"] = _validate_resq_import_project_name(
            request["ProjectName"]
        )
        request["Path"] = _validate_resq_import_rc_path(request["Path"])
        request["ExportMode"] = request["ExportMode"].casefold()
        if request["ExportMode"] not in _RESQ_IMPORT_ALLOWED_EXPORT_MODES:
            raise ValueError(
                "ExportMode must be one of: "
                + ", ".join(sorted(_RESQ_IMPORT_ALLOWED_EXPORT_MODES))
                + "."
            )

        # A status path is derived from RequestId; accepting a producer-supplied
        # mapped-drive path would make cross-PC imports alias-dependent and
        # reopen an arbitrary-write path.
        supplied_paths = [
            key for key in _RESQ_IMPORT_FORBIDDEN_PATH_FIELDS if request.get(key)
        ]
        if supplied_paths:
            raise ValueError(
                "ResQ import request must not supply path field(s): "
                + ", ".join(supplied_paths)
            )

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
        self._validate_sync_method_request(request, "SyncDFM")

    def _validate_sync_result_selection_request(self, request):
        self._validate_sync_method_request(request, "SyncResultSelection")

    def _validate_sync_method_request(self, request, function_name):
        missing = [
            key
            for key in (
                "MethodJsonPath",
                "RPCServerWriteConfirmed",
            )
            if not request.get(key)
        ]
        if missing:
            raise ValueError(f"Missing {function_name} request field(s): " + ", ".join(missing))
        if str(request.get("RPCServerWriteConfirmed", "")).strip().lower() not in {"1", "true", "yes"}:
            raise ValueError(f"{function_name} requires explicit RPC server write confirmation.")


def run_bridge_worker():
    if not window_is_active(RESQ_WINDOW_TITLE):
        return

    worker_id = make_instance_id(WORKER_ROLE)
    id_path = instance_path(WORKER_ROLE, worker_id)
    id_path.parent.mkdir(parents=True, exist_ok=True)

    print("Bridge Worker ID: " + worker_id + "\n")
    client = ResQClient()

    def publish_worker_heartbeat(*, created=False):
        payload = heartbeat_payload(worker_id, WORKER_ROLE, ResQGuiRunning=True)
        if created:
            payload["Created"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        write_json(id_path, payload)

    publish_worker_heartbeat(created=True)
    handler = BridgeRequestHandler(client, worker_heartbeat=publish_worker_heartbeat)
    observer = Observer()
    legacy_request_folder = request_dir()
    import_request_folder = resq_import_request_dir()
    observer.schedule(handler, str(legacy_request_folder), recursive=False)
    observer.schedule(handler, str(import_request_folder), recursive=False)
    observer.start()
    handler.process_pending(legacy_request_folder)
    handler.process_pending(import_request_folder)
    last_request_scan = time.monotonic()

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
            publish_worker_heartbeat()
            # Watchdog events are opportunistic on a mapped/UNC share. Poll the
            # two request folders as well; atomic claim still guarantees that
            # only one bridge worker handles any request.
            if (
                handler.consume_scan_request()
                or time.monotonic() - last_request_scan >= REQUEST_POLL_INTERVAL_SECONDS
            ):
                handler.process_pending(legacy_request_folder)
                handler.process_pending(import_request_folder)
                last_request_scan = time.monotonic()
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
