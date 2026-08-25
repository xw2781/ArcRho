import json
import os
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path


RESQ_WINDOW_TITLE = "ResQ Enterprise"


def current_timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def write_json(path, payload, retries=5, delay=0.1):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    for _ in range(retries):
        tmp_path = target.with_name(f"{target.name}.{uuid.uuid4()}.tmp")
        try:
            with tmp_path.open(mode="w", encoding="utf-8") as file:
                json.dump(payload, file, indent=2)
                file.write("\n")
            os.replace(tmp_path, target)
            return True
        except PermissionError:
            try:
                tmp_path.unlink(missing_ok=True)
            except PermissionError:
                pass
            time.sleep(delay)
    return False


def write_json_with_compact_rows(path, payload, retries=5, delay=0.1):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    for _ in range(retries):
        tmp_path = target.with_name(f"{target.name}.{uuid.uuid4()}.tmp")
        try:
            with tmp_path.open(mode="w", encoding="utf-8", newline="\n") as file:
                file.write(persisted_json_text(payload))
            os.replace(tmp_path, target)
            return True
        except PermissionError:
            try:
                tmp_path.unlink(missing_ok=True)
            except PermissionError:
                pass
            time.sleep(delay)
    return False


def persisted_json_text(payload):
    """Mirror of ``arcrho_api.io.persisted_json_text`` for the frozen Bridge.

    The Bridge loads ``arcrho_api`` from its data bundle rather than its import
    graph, so it cannot import the owner at module scope. ``bridge_json_parity``
    in the Bridge tests pins this copy to the canonical text byte for byte.
    """
    return _format_json(payload) + "\n"


def _is_row_array(value):
    return isinstance(value, list) and all(isinstance(row, list) for row in value)


def _format_json(data, indent=""):
    if _is_row_array(data):
        if not data:
            return "[]"
        child = f"{indent}  "
        rows = ",\n".join(
            f"{child}[{', '.join(json.dumps(v, ensure_ascii=False) for v in row)}]"
            for row in data
        )
        return f"[\n{rows}\n{indent}]"
    if isinstance(data, list):
        if not data:
            return "[]"
        child = f"{indent}  "
        lines = [
            f"{child}{_format_json(item, child)}{',' if i < len(data) - 1 else ''}"
            for i, item in enumerate(data)
        ]
        return "[\n" + "\n".join(lines) + f"\n{indent}]"
    if isinstance(data, dict):
        if not data:
            return "{}"
        child = f"{indent}  "
        keys = list(data.keys())
        lines = [
            f"{child}{json.dumps(str(k), ensure_ascii=False)}: {_format_json(data[k], child)}"
            f"{',' if i < len(keys) - 1 else ''}"
            for i, k in enumerate(keys)
        ]
        return "{\n" + "\n".join(lines) + f"\n{indent}}}"
    return json.dumps(data, ensure_ascii=False)


def read_json(path, retries=50, delay=0.02):
    for _ in range(retries):
        try:
            with open(path, mode="r", encoding="utf-8-sig") as file:
                return json.load(file)
        except (PermissionError, json.JSONDecodeError):
            time.sleep(delay)
    raise PermissionError(f"Cannot open {path}")


def safe_remove(path, attempts=5, delay=0.1):
    path = Path(path)
    for _ in range(attempts):
        try:
            tmp_path = path.with_name(f"{path.name}.{uuid.uuid4()}.deleting")
            os.replace(path, tmp_path)
            tmp_path.unlink()
            return True
        except FileNotFoundError:
            return False
        except PermissionError:
            time.sleep(delay)
    return False


def window_is_active(app_name=RESQ_WINDOW_TITLE):
    try:
        import pygetwindow as gw

        return any(app_name in title for title in gw.getAllTitles() if title.strip())
    except Exception:
        return False


def app_is_running(image_name):
    try:
        result = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {image_name}"],
            capture_output=True,
            text=True,
            check=False,
        )
        return image_name.lower() in result.stdout.lower()
    except Exception:
        return False


def list_json_files_by_mtime(folder, reverse=False):
    folder = Path(folder)
    if not folder.exists():
        return []

    paths = []
    for path in folder.glob("*.json"):
        try:
            paths.append((path.stat().st_mtime, path))
        except OSError:
            pass

    paths.sort(key=lambda item: item[0], reverse=reverse)
    return [path for _, path in paths]


def list_instance_files(folder):
    return list_json_files_by_mtime(folder, reverse=True)


def remove_old_instances(folder, age_seconds=60):
    now = time.time()
    for path in list_instance_files(folder):
        try:
            if now - path.stat().st_mtime > age_seconds:
                path.unlink()
        except OSError:
            pass


def heartbeat_payload(instance_id, role, **extra):
    payload = {
        "Server": instance_id,
        "Role": role,
        "User": os.getlogin(),
        "Last seen": current_timestamp(),
    }
    payload.update(extra)
    return payload
