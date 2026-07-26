import os
import sys
import time
from datetime import datetime
from pathlib import Path

# Resolve packaged, deployed src layout, and repo src layout.
_MODULE_ROOT = Path(__file__).resolve().parent
_SOURCE_ROOT = _MODULE_ROOT.parent
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

for _path in (_SOURCE_ROOT, _BUNDLE_ROOT):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from utils import get_config_value, get_project_root, normalize_function_name
from arcrho_engine.data_processing import (
    PROJECT_CONFIG,
    PROJECT_CONFIG_LOCK,
    ProjectSettingsError,
    UDF_ADASHeaders,
    UDF_ADASProjectSettings,
    UDF_ADASTri,
    _get_vps_last_modified_time,
    debug_mode,
    get_project_table_path,
    id_path,
    load_to_PROJECT_CONFIG,
    project_exists,
    remove_old_instances,
    robot_id,
)
from arcrho_engine.data_processing_rules import (
    DataProcessingConfigurationError,
    DataProcessingRulesError,
)
from arcrho_engine.general_utils import (
    get_current_time,
    read_json,
    safe_remove,
    write_json,
    write_lists_to_csv,
)


class RequestHandler(FileSystemEventHandler):

    def _process_event_path(self, event, file_path):
        if event.is_directory:
            return
        if not str(file_path).lower().endswith(".json"):
            return

        # Process request immediately in the watchdog event thread.
        self.process_file(file_path)

    def on_created(self, event):
        # Excel normally publishes with an atomic move, but its compatibility
        # fallback copies directly to the final .json path.
        self._process_event_path(event, event.src_path)

    def on_moved(self, event):
        self._process_event_path(event, event.dest_path)

    def process_file_debug(self, file_path):
        if debug_mode == 0:
            try:
                self.process_file(file_path)
            except Exception as e:
                print(e)
        else:
            self.process_file(file_path)

    def process_file(self, file_path):
        try:
            arg = read_json(file_path)
        except Exception:
            # print(f'\n* request sent to another agent')
            return

        # Every engine sees the same filesystem event.  Reading is safe, but
        # exactly one engine must atomically remove (claim) the request before
        # doing validation or writing any output.
        try:
            if not safe_remove(file_path):
                return
        except Exception:  # Already removed by another engine.
            return

        if not _write_request_status(arg, "processing"):
            # A caller that supplied StatusPath relies on the processing marker
            # to distinguish this worker from the legacy CSV-only protocol.
            return

        project_name = str(arg.get("ProjectName") or "").strip()
        try:
            if not project_name:
                raise FileNotFoundError("ProjectName is missing")
            if not project_exists(project_name):
                raise FileNotFoundError(project_name)
            get_project_table_path(project_name)
        except Exception as exc:
            message = f"(project not found: {project_name or exc})"
            _finish_request_error(arg, message, [[message]])
            return

        if debug_mode == 1:
            print(arg)

        print(
            f"\n> {get_current_time()} \n> new request # {robot_id} "
            f"# user [{arg.get('UserName', '')}]"
        )

        # Check project configuration updates (guarded).
        try:
            with PROJECT_CONFIG_LOCK:
                if project_name + " - Version" in PROJECT_CONFIG:
                    project_config_signature = _get_vps_last_modified_time(project_name)
                    if (
                        PROJECT_CONFIG[project_name + " - Version"]
                        != project_config_signature
                    ):
                        load_to_PROJECT_CONFIG(project_name)
                        print(
                            f">>> Virtual Project Settings Updated -> "
                            f"[{project_name} JSON]\n"
                        )
                # If missing, _get_df() will load it later.
        except DataProcessingConfigurationError as e:
            print(str(e))
            message = f"(data processing configuration error: {e})"
            _finish_request_error(
                arg,
                message,
                [[f"(data processing configuration error: {e})"]],
            )
            return
        except Exception as e:
            if debug_mode:
                import traceback
                traceback.print_exc()
            message = f"(error: {str(e).upper()})"
            _finish_request_error(arg, message, [[0]])
            return

        # Go to Functions
        try:
            function_name = normalize_function_name(arg.get('Function'))
            if function_name in ['ADASTri', 'ADASVec']:
                UDF_ADASTri(arg)
            elif function_name == 'ADASProjectSettings':
                UDF_ADASProjectSettings(arg)
            elif function_name == 'ADASHeaders':
                UDF_ADASHeaders(arg)
            else:
                message = "(invalid function name)"
                _finish_request_error(arg, message, [[message]])
                return

        except DataProcessingRulesError as e:
            print(str(e))
            message = f"(data processing rules error: {e})"
            _finish_request_error(
                arg,
                message,
                [[f"(data processing rules error: {e})"]],
            )
            return

        except DataProcessingConfigurationError as e:
            print(str(e))
            message = f"(data processing configuration error: {e})"
            _finish_request_error(
                arg,
                message,
                [[f"(data processing configuration error: {e})"]],
            )
            return

        except ProjectSettingsError as e:
            print(str(e))
            _finish_request_error(
                arg,
                f"project settings not defined: {e}",
                [['project settings not defined']],
            )
            return

        except Exception as e:
            if debug_mode:
                import traceback
                traceback.print_exc()
                print(arg)
            message = f"(error: {str(e).upper()})"
            print(message)
            _finish_request_error(arg, message, [[0]])
            return

        _write_request_status(arg, "success")
        print(f"> request completed @ {get_current_time().split(' ')[1]}")


def _write_request_status(arg, status, message=""):
    """Atomically publish optional request status without affecting legacy callers."""

    status_path = str(arg.get("StatusPath") or "").strip()
    if not status_path:
        return True

    payload = {
        "status": str(status),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }
    request_id = str(arg.get("RequestId") or "").strip()
    if request_id:
        payload["request_id"] = request_id
    if message:
        payload["message"] = str(message)

    try:
        if write_json(status_path, payload):
            return True
        print(f"(error: could not write request status to {status_path})")
    except Exception as exc:
        print(f"(error: could not write request status to {status_path}: {exc})")
    return False


def _finish_request_error(arg, message, csv_rows):
    """Preserve the legacy error CSV and publish terminal status when requested."""

    status_message = str(message)
    try:
        write_lists_to_csv(arg.get("DataPath"), csv_rows)
    except Exception as exc:
        status_message = f"{status_message}; failed to write error CSV: {exc}"
        print(status_message)
    finally:
        _write_request_status(arg, "error", status_message)


def _remove_instance_heartbeat():
    try:
        if os.path.exists(id_path):
            safe_remove(id_path)
    except Exception:
        pass


def start_monitoring(path):
    event_handler = RequestHandler()
    observer = Observer()
    observer.schedule(event_handler, path, recursive=False)
    observer.start()
    print('Server ID: ' + robot_id + '\n')

    remove_old_instances()

    current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    write_json(id_path, {'Server': robot_id, 'Last seen': current_time})

    try:
        while True:

            if not observer.is_alive():
                _remove_instance_heartbeat()
                break

            if not os.path.exists(id_path):
                observer.stop(); break

            if get_config_value('apps.engine.kill_all'):
                os.remove(id_path)
                observer.stop(); break

            current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            # Update Status
            arg_1 = read_json(id_path)
            arg_1['Last seen'] = current_time
            write_json(id_path, arg_1)

            time.sleep(5)

    except KeyboardInterrupt:
        observer.stop()

    observer.join()


if __name__ == "__main__":
    start_monitoring(str(get_project_root() / "requests"))
