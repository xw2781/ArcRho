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


def write_json_with_compact_rows(path, payload, compact_row_keys, retries=5, delay=0.1):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    for _ in range(retries):
        tmp_path = target.with_name(f"{target.name}.{uuid.uuid4()}.tmp")
        try:
            with tmp_path.open(mode="w", encoding="utf-8") as file:
                file.write(_format_json_with_compact_rows(payload, set(compact_row_keys)))
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


def _format_json_with_compact_rows(payload, compact_row_keys):
    return _format_json_value(payload, set(compact_row_keys), indent=0)


def _format_json_value(value, compact_row_keys, indent, key=None):
    if isinstance(value, dict):
        return _format_json_object(value, compact_row_keys, indent)
    if _is_2d_array(value):
        return _format_compact_rows(value, indent)

    rendered = json.dumps(value, indent=2)
    return rendered.replace("\n", "\n" + " " * indent)


def _format_json_object(payload, compact_row_keys, indent):
    if not payload:
        return "{}"

    lines = ["{"]
    items = list(payload.items())
    for item_index, (key, value) in enumerate(items):
        item_comma = "," if item_index < len(items) - 1 else ""
        key_text = json.dumps(key)
        rendered = _format_json_value(value, compact_row_keys, indent + 2, key=key)
        rendered_lines = rendered.splitlines()
        lines.append(f"{' ' * (indent + 2)}{key_text}: {rendered_lines[0]}")
        lines.extend(rendered_lines[1:])
        lines[-1] = f"{lines[-1]}{item_comma}"
    lines.append(f"{' ' * indent}}}")
    return "\n".join(lines)


def _is_2d_array(value):
    return isinstance(value, list) and bool(value) and all(isinstance(row, list) for row in value)


def _format_compact_rows(value, indent):
    lines = ["["]
    for row_index, row in enumerate(value):
        row_comma = "," if row_index < len(value) - 1 else ""
        lines.append(f"{' ' * (indent + 2)}{json.dumps(row)}{row_comma}")
    lines.append(f"{' ' * indent}]")
    return "\n".join(lines)


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
