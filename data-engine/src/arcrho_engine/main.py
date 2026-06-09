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
from arcrho_engine.general_utils import (
    get_current_time,
    read_json,
    safe_remove,
    write_json,
    write_lists_to_csv,
)


class RequestHandler(FileSystemEventHandler):

    def on_moved(self, event):
        if event.is_directory:
            return
        if not event.dest_path.lower().endswith(".json"):
            return

        file_path = event.dest_path

        # Process request immediately in the watchdog event thread
        self.process_file(file_path)

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
        except:
            # print(f'\n* request sent to another agent')
            return

        try:
            project_name = arg['ProjectName']
            if not project_exists(project_name):
                raise FileNotFoundError(project_name)
            get_project_table_path(project_name)
        except Exception:
            write_lists_to_csv(arg['DataPath'], [[f'(project not found: {project_name})']])
            return

        try:
            safe_remove(file_path)
        except: # Already removed by another agent
            return

        if debug_mode == 1:
            print(arg)

        print(f"\n> {get_current_time()} \n> new request # {robot_id} # user [{arg['UserName']}]")

        # Check VPS Updates (guarded)
        with PROJECT_CONFIG_LOCK:
            if project_name + " - Version" in PROJECT_CONFIG:
                vps_last_modified_time = _get_vps_last_modified_time(project_name)
                if PROJECT_CONFIG[project_name + " - Version"] < vps_last_modified_time:
                    load_to_PROJECT_CONFIG(project_name)
                    print(f">>> Virtual Project Settings Updated -> [{project_name} JSON]\n")
            # If missing, _get_df() will load it later; or you can proactively load it here.

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
                write_lists_to_csv(arg['DataPath'], [['(invalid function name)']])

        except ProjectSettingsError as e:
            print(str(e))
            write_lists_to_csv(arg['DataPath'], [['project settings not defined']])
            return
        
        except Exception as e:
            if debug_mode:
                import traceback
                traceback.print_exc()
                print(arg)
            else:
                err_msg = f"(error: {str(e).upper()})"
                print(err_msg)
            write_lists_to_csv(arg['DataPath'], [[0]])
            return

        print(f"> request completed @ {get_current_time().split(' ')[1]}")


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
