import os
import sys
import time
import uuid
import psutil
import subprocess
from pathlib import Path
from datetime import datetime

# Resolve ADAS root from __file__: main.py -> ADAS Master -> core -> ADAS
_ADAS_ROOT = str(Path(__file__).resolve().parent.parent.parent)
if _ADAS_ROOT not in sys.path:
    sys.path.insert(0, _ADAS_ROOT)

from core.utils import *

agent_instance_path = get_config_value("root") + r"\core\ADAS Agent\instances"

device_name = os.environ.get("COMPUTERNAME")
ts = datetime.now().strftime("%y%m%d-%H%M%S-%f")[:-3]
master_id = f'{device_name}@' + os.getlogin() + "@" + ts

id_folder = r"E:\ADAS\core\ADAS Master\instances"
id_path = id_folder + '\\' + master_id + '.txt'


def kill_extra_python_processes():
    # collect python processes
    py_procs = []
    for proc in psutil.process_iter(['pid', 'name', 'exe', 'create_time']):
        try:
            if proc.info['name'] and 'ADAS Master.exe' in proc.info['name'].lower():
                py_procs.append(proc)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    # if only one, do nothing
    if len(py_procs) <= 1:
        return 0

    # here we kill everything
    killed = 0
    for proc in py_procs[:-1]:
        try:
            proc.terminate()
            killed += 1
        except Exception:
            pass

    return killed

# try:
#     kill_extra_python_processes()
# except Exception as e:
#     print(e)


def read_txt(txt_file, retries=50, delay=0.02):
    """
    Reads key=value lines safely with retries.
    Supports values that contain '='.
    Ignores blank / malformed lines.
    """

    # ---- 1. Wait until file is available ----
    for _ in range(retries):
        try:
            with open(txt_file, mode='r', encoding='utf-8') as f:
                lines = f.readlines()
            break
        except PermissionError:
            time.sleep(delay)
    else:
        raise PermissionError(f"Cannot open {txt_file}")

    # ---- 2. Parse key=value ----
    arg_dict = {}
    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        # Only split at first '='
        if '= ' in line:
            key, value = line.split(' = ', 1)
        elif '=' in line:
            key, value = line.split('=', 1)
        else:
            continue

        arg_dict[key.strip()] = value.strip()

    return arg_dict


def remove_old_instances(FOLDER, AGE_SECONDS=60):
    now = time.time()

    for name in os.listdir(FOLDER):
        path = os.path.join(FOLDER, name)
        # only remove files
        if not os.path.isfile(path):
            continue
        try:
            mtime = os.path.getmtime(path)
            if now - mtime > AGE_SECONDS:
                os.remove(path)
        except Exception:
            # ignore locked / race-condition files
            pass


def cmd(name):
    '''
    KILL_ALL_AGENTS = 0
    KILL_ALL_MASTER = 0
    AUTO_CREATE_WORKERS = 1
    MAX_WORKERS = 4
    '''
    txt = read_txt(r"E:\ADAS\core\ADAS Master\command.txt")[name]

    if 'MAX' in name:
        return int(txt)
    else:
        if txt.upper() in ['TRUE', '1']:
            return True
        elif txt.upper() in ['FALSE', '0']:
            return False
        

def file_counts(FOLDER):
    file_count = sum(
        1 for name in os.listdir(FOLDER)
        if os.path.isfile(os.path.join(FOLDER, name))
    )
    return file_count


def write_txt(txt_file, arg):
    content = ''
    for item in arg.items():
        content += item[0] + ' = ' + item[1] + '\n'
    with open(txt_file, "w") as file:
        file.write(content)


def safe_remove(file_path, attempts=5, delay=0.1):
    """Attempt to remove a file with retries on permission error."""
    for _ in range(attempts):
        try:
            tmp = f"{file_path}.{uuid.uuid4()}.deleting"
            os.replace(file_path, tmp)  # atomic
            os.remove(tmp)
            return True
        except PermissionError:
            time.sleep(delay)

    return False


current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
write_txt(id_path, {'Server': master_id, 'Last seen': current_time})

time.sleep(1)

while True:
    try:
        if not os.path.exists(id_path):
            break
        
        if get_config_value('apps.master.kill_all'):
            safe_remove(id_path)
            break

        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
        # Update Status
        arg_1 = read_txt(id_path)
        arg_1['Last seen'] = current_time
        write_txt(id_path, arg_1)

        remove_old_instances(agent_instance_path)
        remove_old_instances(r"E:\ADAS\core\ADAS Master\instances")
        remove_old_instances(r"E:\ADAS\requests", 5*60)
      
        while get_config_value('apps.master.auto_create_workers') \
          and get_config_value('apps.agent.kill_all') == False \
          and file_counts(agent_instance_path) < get_config_value('apps.master.max_workers'):
            exe = Path(r"E:\ADAS\core\ADAS Agent\dist\ADAS Agent\ADAS Agent.exe")
            subprocess.Popen([str(exe)], close_fds=True)
            time.sleep(3)

    except Exception as e:
        print(e)
        
    time.sleep(15)
