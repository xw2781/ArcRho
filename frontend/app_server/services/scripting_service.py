"""Scripting console execution service.

Maintains a persistent session namespace so variables survive across cell
executions (JupyterLab-style).  Captures stdout/stderr and returns
structured results plus variable inspection.
"""
from __future__ import annotations

import ast
import builtins
import copy
import inspect
import io
import json
import math
import os
import queue
import re
import sys
import tempfile
import threading
import time as py_time
import traceback
import types
from contextlib import redirect_stdout, redirect_stderr
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import pandas as pd

from app_server import config


def _ensure_arcrho_api_import_path() -> None:
    """Expose the monorepo API source in development; packaged apps bundle it."""
    repo_root = Path(__file__).resolve().parents[3]
    api_src = repo_root / "python-api" / "src"
    if api_src.exists():
        text = str(api_src)
        if text not in sys.path:
            sys.path.insert(0, text)


# Arcode code cells should be able to import arcrho_api without a separate pip install.
_ensure_arcrho_api_import_path()


# ---------------------------------------------------------------------------
# Execution lock & cancellation
# ---------------------------------------------------------------------------

_TIMEOUT_SEC = 60

_DEFAULT_SESSION_ID = "default"
_MAX_SESSION_ID_LEN = 128


class _ScriptTimeout(Exception):
    pass


@dataclass
class _SessionState:
    session_id: str
    namespace: Dict[str, Any] = field(default_factory=dict)
    builtin_keys: set = field(default_factory=set)
    execution_count: int = 0
    exec_lock: threading.Lock = field(default_factory=threading.Lock)
    cancel_event: threading.Event = field(default_factory=threading.Event)
    custom_working_dirs: List[str] = field(default_factory=list)


_SESSION_STATES: Dict[str, _SessionState] = {}
_SESSION_STATES_LOCK = threading.Lock()


def _normalize_session_id(session_id: Optional[str]) -> str:
    sid = (session_id or "").strip()
    if not sid:
        return _DEFAULT_SESSION_ID
    if len(sid) > _MAX_SESSION_ID_LEN:
        sid = sid[:_MAX_SESSION_ID_LEN]
    return sid


class _ExecutionActivity:
    """Thread-safe monotonic activity marker for cooperative long-running work."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last_activity = py_time.monotonic()

    def touch(self) -> None:
        with self._lock:
            self._last_activity = py_time.monotonic()

    def inactive_for(self) -> float:
        with self._lock:
            return max(0.0, py_time.monotonic() - self._last_activity)


def _run_with_timeout(
    func,
    timeout_sec: float,
    cancel_event: threading.Event,
    *,
    activity: _ExecutionActivity | None = None,
):
    """Run *func* with a timeout.  Works on Windows (no SIGALRM)."""
    result: Dict[str, Any] = {}
    exc_info: list = [None]

    def _target():
        try:
            result.update(func())
        except BaseException:
            exc_info[0] = sys.exc_info()

    thread = threading.Thread(target=_target, daemon=True)
    thread.start()
    if activity is None:
        thread.join(timeout=timeout_sec)
    else:
        while thread.is_alive():
            remaining = float(timeout_sec) - activity.inactive_for()
            if remaining <= 0:
                break
            thread.join(timeout=min(0.1, remaining))

    if thread.is_alive():
        # Signal cancellation so the thread can check and exit
        cancel_event.set()
        thread.join(timeout=1.0)
        timeout_kind = " inactivity" if activity is not None else ""
        raise _ScriptTimeout(f"Script exceeded {timeout_sec}s{timeout_kind} timeout")

    if exc_info[0]:
        raise exc_info[0][1].with_traceback(exc_info[0][2])

    return result


def interrupt_execution(session_id: Optional[str] = None) -> Dict[str, Any]:
    """Signal the running script to stop."""
    session = _get_or_create_session_state(session_id)
    session.cancel_event.set()
    return {"success": True, "message": "Interrupt signal sent."}


def _raise_if_cancelled(cancel_event: threading.Event) -> None:
    if cancel_event.is_set():
        raise KeyboardInterrupt("Execution cancelled by user")


def _make_cooperative_cancel_checker(cancel_event: threading.Event):
    """Return an explicit cancellation checkpoint for temporarily untraced work."""

    def _check_macro_cancelled() -> None:
        _raise_if_cancelled(cancel_event)

    return _check_macro_cancelled


def _make_trusted_macro_call(cancel_event: threading.Event):
    """Wrap a trusted call with tracing suspended on the macro execution thread."""

    check_cancelled = _make_cooperative_cancel_checker(cancel_event)

    def _run_trusted_macro_call(func, *args, **kwargs):
        if not callable(func):
            raise TypeError("run_trusted_macro_call requires a callable.")

        check_cancelled()
        previous_trace = sys.gettrace()
        sys.settrace(None)
        try:
            result = func(*args, **kwargs)
        finally:
            sys.settrace(previous_trace)
        check_cancelled()
        return result

    return _run_trusted_macro_call


def _initialize_macro_com_apartment():
    """Initialize the macro worker as an STA when Windows COM is available."""
    try:
        import pythoncom
    except ImportError:
        return None
    pythoncom.CoInitialize()
    return pythoncom


def _make_cancel_trace(cancel_event: threading.Event):
    """Create a tracing hook that aborts execution when cancellation is requested."""
    def _trace(_frame, _event, _arg):
        _raise_if_cancelled(cancel_event)
        return _trace
    return _trace


def _make_scoped_cancel_trace(
    cancel_event: threading.Event,
    *,
    traced_files: Set[str],
    traced_roots: Tuple[str, ...],
):
    """Trace macro source files for cancellation without tracing imported libraries line by line."""

    normalized_files = {os.path.normcase(os.path.abspath(path)) for path in traced_files if path}
    normalized_roots = tuple(
        os.path.normcase(os.path.abspath(path)).rstrip(os.sep) + os.sep
        for path in traced_roots
        if path
    )
    filename_decisions: Dict[str, bool] = {}
    code_decisions: Dict[types.CodeType, bool] = {}

    def _should_trace(frame) -> bool:
        code = frame.f_code
        try:
            return code_decisions[code]
        except KeyError:
            pass

        raw_filename = str(code.co_filename or "")
        try:
            decision = filename_decisions[raw_filename]
        except KeyError:
            if not raw_filename:
                decision = False
            else:
                filename = os.path.normcase(os.path.abspath(raw_filename))
                decision = filename in normalized_files
                if not decision:
                    decision = any(filename.startswith(root) for root in normalized_roots)
            filename_decisions[raw_filename] = decision
        code_decisions[code] = decision
        return decision

    def _trace(frame, event, _arg):
        _raise_if_cancelled(cancel_event)
        if event == "call" and not _should_trace(frame):
            return None
        return _trace

    return _trace


def _make_interruptible_sleep(
    cancel_event: threading.Event,
    owner_thread_id: int,
    base_sleep_fn,
):
    """Create a thread-scoped sleep that can be interrupted by cancel_event."""
    def _interruptible_sleep(seconds: Any = 0.0):
        # Do not affect other threads that might call time.sleep.
        if threading.get_ident() != owner_thread_id:
            return base_sleep_fn(seconds)

        duration = float(seconds)
        if duration < 0:
            raise ValueError("sleep length must be non-negative")

        deadline = py_time.monotonic() + duration
        while True:
            _raise_if_cancelled(cancel_event)
            remaining = deadline - py_time.monotonic()
            if remaining <= 0:
                return None
            base_sleep_fn(min(remaining, 0.05))

    return _interruptible_sleep


class _TimeProxy:
    """Proxy that forwards to stdlib time module, except sleep is interruptible."""

    def __init__(self, sleep_fn):
        self.sleep = sleep_fn

    def __getattr__(self, attr: str) -> Any:
        return getattr(py_time, attr)


def _make_session_import_hook(
    base_import,
    cancel_event: threading.Event,
    owner_thread_id: int,
):
    """Wrap __import__ so importing time returns an interruptible proxy."""
    time_proxy = _TimeProxy(
        _make_interruptible_sleep(cancel_event, owner_thread_id, py_time.sleep)
    )

    def _session_import(name, globals=None, locals=None, fromlist=(), level=0):
        module = base_import(name, globals, locals, fromlist, level)
        if str(name).split(".", 1)[0] == "time":
            return time_proxy
        return module

    return _session_import, time_proxy


def _serialize_stream_event(payload: Dict[str, Any]) -> str:
    """Serialize one streaming payload as newline-delimited JSON."""
    return json.dumps(payload, ensure_ascii=False) + "\n"


class _StreamTextSink:
    """Text sink used by redirect_stdout/redirect_stderr with live event emission."""

    def __init__(self, event_queue: "queue.Queue[Dict[str, Any]]", event_type: str):
        self._event_queue = event_queue
        self._event_type = event_type
        self._chunks: List[str] = []
        self.encoding = "utf-8"

    def write(self, text: Any) -> int:
        chunk = str(text or "")
        if not chunk:
            return 0
        self._chunks.append(chunk)
        self._event_queue.put({"type": self._event_type, "text": chunk})
        return len(chunk)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False

    def getvalue(self) -> str:
        return "".join(self._chunks)


# ---------------------------------------------------------------------------
# Write-path whitelist
# ---------------------------------------------------------------------------

def _is_write_allowed(path: str, custom_working_dirs: List[str]) -> bool:
    """Check if a file path is in the write whitelist."""
    resolved = os.path.abspath(path)
    allowed_roots = []
    if config.DATA_DIR:
        allowed_roots.append(os.path.abspath(config.DATA_DIR))
    if config.PROJECT_SETTINGS_DIR:
        allowed_roots.append(os.path.abspath(config.PROJECT_SETTINGS_DIR))
    allowed_roots.extend(os.path.abspath(d) for d in custom_working_dirs)
    return any(resolved.startswith(root + os.sep) or resolved == root
               for root in allowed_roots)


def _make_set_working_dir(session: _SessionState):
    def set_working_dir(path: str) -> None:
        """Add a directory to the write whitelist."""
        abs_path = os.path.abspath(path)
        if not os.path.isdir(abs_path):
            raise FileNotFoundError(f"Directory not found: {abs_path}")
        if abs_path not in session.custom_working_dirs:
            session.custom_working_dirs.append(abs_path)
        print(f"Working directory added: {abs_path}")
    return set_working_dir


# ---------------------------------------------------------------------------
# Sandboxed helpers exposed to user scripts
# ---------------------------------------------------------------------------

def _make_read_json():
    def read_json(path: str) -> Any:
        """Read a JSON file and return its contents."""
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return read_json


def _make_write_json(session: _SessionState):
    def write_json(path: str, data: Any, indent: int = 2) -> None:
        """Atomically write data to a JSON file."""
        abs_path = os.path.abspath(path)
        if not _is_write_allowed(abs_path, session.custom_working_dirs):
            raise PermissionError(
                f"Write restricted. Path not in allowed directories: {abs_path}\n"
                f"Use set_working_dir(path) to add a directory to the whitelist."
            )
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        tmp = abs_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=indent, ensure_ascii=False)
        os.replace(tmp, abs_path)
    return write_json


def _make_read_csv():
    def read_csv(path: str, **kwargs) -> pd.DataFrame:
        """Read a CSV file into a pandas DataFrame."""
        return pd.read_csv(path, **kwargs)
    return read_csv


def _make_write_csv(session: _SessionState):
    def write_csv(path: str, df: pd.DataFrame, index: bool = False, **kwargs) -> None:
        """Atomically write a DataFrame to a CSV file."""
        abs_path = os.path.abspath(path)
        if not _is_write_allowed(abs_path, session.custom_working_dirs):
            raise PermissionError(
                f"Write restricted. Path not in allowed directories: {abs_path}\n"
                f"Use set_working_dir(path) to add a directory to the whitelist."
            )
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        tmp = abs_path + ".tmp"
        df.to_csv(tmp, index=index, **kwargs)
        os.replace(tmp, abs_path)
    return write_csv


def _make_list_files():
    def list_files(directory: str, pattern: str = "*") -> List[str]:
        """List files in a directory, optionally filtered by glob pattern."""
        import glob
        return sorted(glob.glob(os.path.join(directory, pattern)))
    return list_files


def _make_get_project_path():
    def get_project_path(project_name: str = "") -> str:
        """Return the base project settings directory, or a specific project folder."""
        base = config.PROJECT_SETTINGS_DIR
        if project_name:
            return os.path.join(base, project_name)
        return base
    return get_project_path


def _make_get_data_path():
    def get_data_path() -> str:
        """Return the data directory path."""
        return config.DATA_DIR
    return get_data_path


def _make_check_cancel(session: _SessionState):
    return _make_cooperative_cancel_checker(session.cancel_event)


# ---------------------------------------------------------------------------
# Session namespace (persistent across cell executions)
# ---------------------------------------------------------------------------

def _build_default_namespace(session: _SessionState) -> Dict[str, Any]:
    """Build the default namespace with helper functions and modules."""
    ns: Dict[str, Any] = {
        "__builtins__": __builtins__,
        "read_json": _make_read_json(),
        "write_json": _make_write_json(session),
        "read_csv": _make_read_csv(),
        "write_csv": _make_write_csv(session),
        "list_files": _make_list_files(),
        "get_project_path": _make_get_project_path(),
        "get_data_path": _make_get_data_path(),
        "set_working_dir": _make_set_working_dir(session),
        "check_cancel": _make_check_cancel(session),
        "log": print,
        "pd": pd,
        "json": json,
        "os": os,
        "math": math,
    }
    return ns


def _reset_session_state(session: _SessionState) -> None:
    """Initialize or reset one session namespace."""
    session.custom_working_dirs.clear()
    session.namespace = _build_default_namespace(session)
    session.builtin_keys = set(session.namespace.keys())
    session.execution_count = 0
    session.cancel_event.clear()


def _create_session_state(session_id: str) -> _SessionState:
    session = _SessionState(session_id=session_id)
    _reset_session_state(session)
    return session


def _get_or_create_session_state(session_id: Optional[str]) -> _SessionState:
    sid = _normalize_session_id(session_id)
    with _SESSION_STATES_LOCK:
        session = _SESSION_STATES.get(sid)
        if session is None:
            session = _create_session_state(sid)
            _SESSION_STATES[sid] = session
        return session


# Initialize default session on module load for backward compatibility.
_get_or_create_session_state(_DEFAULT_SESSION_ID)


# ---------------------------------------------------------------------------
# Script execution
# ---------------------------------------------------------------------------


def run_script(code: str, session_id: Optional[str] = None) -> Dict[str, Any]:
    """Execute user Python code in the persistent session namespace."""
    session = _get_or_create_session_state(session_id)

    # Prevent concurrent execution
    if not session.exec_lock.acquire(blocking=False):
        return {
            "success": False,
            "output": "",
            "error": "Another cell is already running. Please wait or interrupt it.",
            "execution_count": session.execution_count,
        }

    try:
        session.execution_count += 1
        session.cancel_event.clear()

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        def _exec():
            owner_thread_id = threading.get_ident()
            trace_hook = _make_cancel_trace(session.cancel_event)
            previous_builtins = session.namespace.get("__builtins__", __builtins__)
            had_time_binding = "time" in session.namespace
            previous_time_binding = session.namespace.get("time")

            raw_builtins = previous_builtins
            if isinstance(raw_builtins, dict):
                builtins_dict = dict(raw_builtins)
            elif isinstance(raw_builtins, types.ModuleType):
                builtins_dict = dict(vars(raw_builtins))
            else:
                builtins_dict = dict(vars(builtins))

            base_import = builtins_dict.get("__import__", builtins.__import__)
            if not callable(base_import):
                base_import = builtins.__import__

            session_import, time_proxy = _make_session_import_hook(
                base_import,
                session.cancel_event,
                owner_thread_id,
            )
            builtins_dict["__import__"] = session_import

            session.namespace["__builtins__"] = builtins_dict
            session.namespace["time"] = time_proxy

            output = ""
            try:
                with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
                    sys.settrace(trace_hook)
                    try:
                        # Parse the code into an AST to check if the last statement
                        # is an expression (like Jupyter: auto-display last expr value)
                        tree = ast.parse(code, "<cell>", "exec")
                        last_expr_value = None

                        if tree.body and isinstance(tree.body[-1], ast.Expr):
                            # Split: exec all statements except last, then eval the last
                            last_node = tree.body.pop()
                            if tree.body:
                                exec(compile(tree, "<cell>", "exec"), session.namespace)
                            # Eval the last expression
                            expr_code = compile(
                                ast.Expression(body=last_node.value), "<cell>", "eval"
                            )
                            last_expr_value = eval(expr_code, session.namespace)
                            # Store as _ (like IPython)
                            session.namespace["_"] = last_expr_value
                        else:
                            exec(compile(tree, "<cell>", "exec"), session.namespace)
                    finally:
                        sys.settrace(None)

                    output = stdout_buf.getvalue()
                    # Append the last expression's repr if it's not None
                    if last_expr_value is not None:
                        expr_repr = repr(last_expr_value)
                        if output and not output.endswith("\n"):
                            output += "\n"
                        output += expr_repr
            finally:
                session.namespace["__builtins__"] = previous_builtins
                if had_time_binding:
                    session.namespace["time"] = previous_time_binding
                else:
                    session.namespace.pop("time", None)

            return {
                "success": True,
                "output": output,
                "error": stderr_buf.getvalue(),
                "execution_count": session.execution_count,
            }

        try:
            result = _run_with_timeout(_exec, _TIMEOUT_SEC, session.cancel_event)
            return result
        except _ScriptTimeout as e:
            return {
                "success": False,
                "output": stdout_buf.getvalue(),
                "error": str(e),
                "execution_count": session.execution_count,
            }
        except KeyboardInterrupt:
            return {
                "success": False,
                "output": stdout_buf.getvalue(),
                "error": "Execution cancelled by user.",
                "execution_count": session.execution_count,
            }
        except SyntaxError as e:
            return {
                "success": False,
                "output": stdout_buf.getvalue(),
                "error": f"SyntaxError: {e.msg} (line {e.lineno})",
                "execution_count": session.execution_count,
            }
        except Exception:
            tb = traceback.format_exc()
            return {
                "success": False,
                "output": stdout_buf.getvalue(),
                "error": tb,
                "execution_count": session.execution_count,
            }
    finally:
        session.cancel_event.clear()
        session.exec_lock.release()


def run_script_stream(code: str, session_id: Optional[str] = None):
    """Execute user code and stream stdout/stderr events as NDJSON lines."""
    session = _get_or_create_session_state(session_id)

    if not session.exec_lock.acquire(blocking=False):
        yield _serialize_stream_event({
            "type": "done",
            "success": False,
            "output": "",
            "error": "Another cell is already running. Please wait or interrupt it.",
            "execution_count": session.execution_count,
        })
        return

    session.execution_count += 1
    session.cancel_event.clear()

    event_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue()
    finished = threading.Event()
    timeout_triggered = threading.Event()
    lock_released = threading.Event()
    started_at = py_time.monotonic()

    stdout_sink = _StreamTextSink(event_queue, "stdout")
    stderr_sink = _StreamTextSink(event_queue, "stderr")
    result_holder: Dict[str, Any] = {
        "success": False,
        "output": "",
        "error": "",
        "execution_count": session.execution_count,
    }

    def _release_exec_lock() -> None:
        if lock_released.is_set():
            return
        lock_released.set()
        session.cancel_event.clear()
        try:
            session.exec_lock.release()
        except RuntimeError:
            # Guard against rare double-release races
            pass

    def _worker():
        nonlocal result_holder
        owner_thread_id = threading.get_ident()
        trace_hook = _make_cancel_trace(session.cancel_event)
        previous_builtins = session.namespace.get("__builtins__", __builtins__)
        had_time_binding = "time" in session.namespace
        previous_time_binding = session.namespace.get("time")

        raw_builtins = previous_builtins
        if isinstance(raw_builtins, dict):
            builtins_dict = dict(raw_builtins)
        elif isinstance(raw_builtins, types.ModuleType):
            builtins_dict = dict(vars(raw_builtins))
        else:
            builtins_dict = dict(vars(builtins))

        base_import = builtins_dict.get("__import__", builtins.__import__)
        if not callable(base_import):
            base_import = builtins.__import__

        session_import, time_proxy = _make_session_import_hook(
            base_import,
            session.cancel_event,
            owner_thread_id,
        )
        builtins_dict["__import__"] = session_import

        session.namespace["__builtins__"] = builtins_dict
        session.namespace["time"] = time_proxy

        try:
            with redirect_stdout(stdout_sink), redirect_stderr(stderr_sink):
                sys.settrace(trace_hook)
                try:
                    tree = ast.parse(code, "<cell>", "exec")
                    last_expr_value = None

                    if tree.body and isinstance(tree.body[-1], ast.Expr):
                        last_node = tree.body.pop()
                        if tree.body:
                            exec(compile(tree, "<cell>", "exec"), session.namespace)
                        expr_code = compile(
                            ast.Expression(body=last_node.value), "<cell>", "eval"
                        )
                        last_expr_value = eval(expr_code, session.namespace)
                        session.namespace["_"] = last_expr_value
                    else:
                        exec(compile(tree, "<cell>", "exec"), session.namespace)
                finally:
                    sys.settrace(None)

                if last_expr_value is not None:
                    expr_repr = repr(last_expr_value)
                    if expr_repr:
                        current_out = stdout_sink.getvalue()
                        if current_out and not current_out.endswith("\n"):
                            stdout_sink.write("\n")
                        stdout_sink.write(expr_repr)

            result_holder = {
                "success": True,
                "output": stdout_sink.getvalue(),
                "error": stderr_sink.getvalue(),
                "execution_count": session.execution_count,
            }
        except KeyboardInterrupt:
            message = (
                f"Script exceeded {_TIMEOUT_SEC}s timeout"
                if timeout_triggered.is_set()
                else "Execution cancelled by user."
            )
            result_holder = {
                "success": False,
                "output": stdout_sink.getvalue(),
                "error": message,
                "execution_count": session.execution_count,
            }
        except SyntaxError as e:
            result_holder = {
                "success": False,
                "output": stdout_sink.getvalue(),
                "error": f"SyntaxError: {e.msg} (line {e.lineno})",
                "execution_count": session.execution_count,
            }
        except Exception:
            result_holder = {
                "success": False,
                "output": stdout_sink.getvalue(),
                "error": traceback.format_exc(),
                "execution_count": session.execution_count,
            }
        finally:
            session.namespace["__builtins__"] = previous_builtins
            if had_time_binding:
                session.namespace["time"] = previous_time_binding
            else:
                session.namespace.pop("time", None)
            finished.set()
            _release_exec_lock()

    worker = threading.Thread(target=_worker, daemon=True)
    worker.start()

    yield _serialize_stream_event({
        "type": "start",
        "execution_count": session.execution_count,
    })

    try:
        while True:
            if (
                not finished.is_set()
                and not timeout_triggered.is_set()
                and (py_time.monotonic() - started_at) > _TIMEOUT_SEC
            ):
                timeout_triggered.set()
                session.cancel_event.set()

            try:
                event = event_queue.get(timeout=0.05)
                yield _serialize_stream_event(event)
                continue
            except queue.Empty:
                pass

            if finished.is_set():
                break

        while True:
            try:
                event = event_queue.get_nowait()
                yield _serialize_stream_event(event)
            except queue.Empty:
                break

        yield _serialize_stream_event({
            "type": "done",
            **result_holder,
        })
    finally:
        # If the client disconnects mid-stream, request cancellation.
        if not finished.is_set():
            session.cancel_event.set()
            worker.join(timeout=0.2)
        _release_exec_lock()


# ---------------------------------------------------------------------------
# Variable inspector
# ---------------------------------------------------------------------------

def _safe_repr(value: Any, max_len: int = 120) -> str:
    """Return a truncated repr of a value."""
    try:
        r = repr(value)
    except Exception:
        r = f"<{type(value).__name__}>"
    if len(r) > max_len:
        r = r[:max_len - 3] + "..."
    return r


def _get_type_label(value: Any) -> str:
    """Return a short, friendly type label."""
    if isinstance(value, pd.DataFrame):
        return "DataFrame"
    if isinstance(value, pd.Series):
        return "Series"
    return type(value).__name__


def _get_size_bytes(value: Any) -> int:
    """Estimate memory usage in bytes."""
    try:
        if isinstance(value, pd.DataFrame):
            return int(value.memory_usage(deep=True).sum())
        if isinstance(value, pd.Series):
            return int(value.memory_usage(deep=True))
        return sys.getsizeof(value)
    except Exception:
        return 0


def _format_size(nbytes: int) -> str:
    """Format byte count as human-readable string."""
    if nbytes < 1024:
        return f"{nbytes} B"
    if nbytes < 1024 * 1024:
        return f"{nbytes / 1024:.1f} KB"
    if nbytes < 1024 * 1024 * 1024:
        return f"{nbytes / (1024 * 1024):.1f} MB"
    return f"{nbytes / (1024 * 1024 * 1024):.1f} GB"


def _get_preview(value: Any) -> str:
    """Return a preview string for the variable inspector."""
    if isinstance(value, pd.DataFrame):
        shape = f"{value.shape[0]} rows x {value.shape[1]} cols"
        cols = ", ".join(str(c) for c in value.columns[:8])
        if len(value.columns) > 8:
            cols += ", ..."
        return f"{shape} [{cols}]"
    if isinstance(value, pd.Series):
        return f"len={len(value)}, dtype={value.dtype}"
    return _safe_repr(value, 100)


def get_variables(session_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return user-defined variables from the session namespace."""
    session = _get_or_create_session_state(session_id)
    result: List[Dict[str, Any]] = []
    for key, value in session.namespace.items():
        # Skip built-in namespace items
        if key in session.builtin_keys:
            continue
        # Skip private/dunder names
        if key.startswith("_"):
            continue
        # Skip modules and functions (unless user-defined lambdas)
        if isinstance(value, types.ModuleType):
            continue

        size = _get_size_bytes(value)
        result.append({
            "name": key,
            "type": _get_type_label(value),
            "preview": _get_preview(value),
            "size_bytes": size,
            "size": _format_size(size),
        })

    result.sort(key=lambda v: v["name"])
    return result


def del_variable(name: str, session_id: Optional[str] = None) -> Dict[str, Any]:
    """Delete a user variable from the session namespace."""
    session = _get_or_create_session_state(session_id)
    if name in session.builtin_keys:
        return {"success": False, "message": f"Cannot delete built-in '{name}'."}
    if name not in session.namespace:
        return {"success": False, "message": f"Variable '{name}' not found."}
    del session.namespace[name]
    return {"success": True, "message": f"Variable '{name}' deleted."}


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

def reset_session(session_id: Optional[str] = None) -> Dict[str, Any]:
    """Reset the session namespace and execution counter."""
    session = _get_or_create_session_state(session_id)
    if not session.exec_lock.acquire(blocking=False):
        return {"success": False, "message": "Cannot reset while execution is running. Interrupt first."}
    try:
        _reset_session_state(session)
        return {"success": True, "message": "Session reset."}
    finally:
        session.exec_lock.release()


# ---------------------------------------------------------------------------
# API documentation
# ---------------------------------------------------------------------------

def get_api_help() -> List[Dict[str, str]]:
    """Return documentation for functions available in scripts."""
    return [
        {"name": "read_json(path)", "description": "Read a JSON file and return its contents as a Python object."},
        {"name": "write_json(path, data, indent=2)", "description": "Atomically write data to a JSON file. Path must be in an allowed directory."},
        {"name": "read_csv(path, **kwargs)", "description": "Read a CSV file into a pandas DataFrame."},
        {"name": "write_csv(path, df, index=False, **kwargs)", "description": "Atomically write a DataFrame to a CSV file. Path must be in an allowed directory."},
        {"name": "list_files(directory, pattern='*')", "description": "List files in a directory, optionally filtered by glob pattern."},
        {"name": "get_project_path(project_name='')", "description": "Return the project settings directory, or a specific project folder."},
        {"name": "get_data_path()", "description": "Return the data directory path."},
        {"name": "set_working_dir(path)", "description": "Add a directory to the write whitelist so write_json/write_csv can write to it."},
        {"name": "check_cancel()", "description": "Call inside long loops to allow user cancellation. Raises KeyboardInterrupt if cancelled."},
        {"name": "log(message)", "description": "Print a message to the output console."},
        {"name": "task_designer.register_task(task_id, name, description='')", "description": "Register a live Task Designer validation row when the macro is launched from Task Designer."},
        {"name": "task_designer.start_task(task_id)", "description": "Mark a Task Designer validation row as running."},
        {"name": "task_designer.complete_task(task_id, result, message='', details=None)", "description": "Complete a Task Designer validation row with Pass, Fail, Needs Review, Skipped, or Error."},
        {"name": "run_task_macro(macro_id, task_id='', name='', description='')", "description": "Run another macro as a Task Designer child row, capturing stdout as that row's result message."},
        {"name": "pd", "description": "The pandas module, available as 'pd'."},
        {"name": "json", "description": "The json standard library module."},
        {"name": "os", "description": "The os standard library module."},
        {"name": "math", "description": "The math standard library module."},
    ]


# ---------------------------------------------------------------------------
# Object introspection (Shift+Tab tooltip)
# ---------------------------------------------------------------------------

_IDENT_RE = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")
_MAX_DOC_LEN = 2000
_MAX_DICT_KEYS = 20
_MAX_DF_COLS = 30


def _extract_expression_at(code: str, cursor_pos: int) -> List[str]:
    """Extract candidate dotted identifier expressions around *cursor_pos*.

    Returns a list of candidates ordered by priority:
    1. The direct identifier under/adjacent to the cursor
    2. The callable name before the enclosing ``(`` if cursor is inside parens

    The caller should try each candidate in order until one resolves.
    """
    pos = max(0, min(cursor_pos, len(code)))
    candidates: List[str] = []

    # --- Candidate 1: direct identifier at cursor ---
    start = pos
    while start > 0 and (code[start - 1].isalnum() or code[start - 1] in ("_", ".")):
        start -= 1
    end = pos
    while end < len(code) and (code[end].isalnum() or code[end] == "_"):
        end += 1
    fragment = code[start:end].strip(".")
    if fragment and _IDENT_RE.fullmatch(fragment):
        candidates.append(fragment)

    # --- Candidate 2: callable before enclosing '(' ---
    # Walk backwards, skipping over string literals to handle cases like
    # func(r"E:\path\file.csv") where cursor is inside the string.
    depth = 0
    i = pos - 1
    in_str: Optional[str] = None  # track if we're inside a string (scanning backwards)
    while i >= 0:
        ch = code[i]
        # Simple backwards string skipping: when we hit a quote, scan back
        # to find its matching opening quote.
        if in_str is None and ch in ('"', "'"):
            quote = ch
            # Check for triple-quote
            if i >= 2 and code[i - 2:i + 1] == quote * 3:
                j = i - 3
                triple = quote * 3
                idx = code.rfind(triple, 0, j + 1)
                if idx >= 0:
                    i = idx - 1
                else:
                    break
                continue
            # Single quote — find matching opening quote (skip escaped quotes)
            j = i - 1
            while j >= 0:
                if code[j] == quote and (j == 0 or code[j - 1] != "\\"):
                    break
                j -= 1
            # Also handle raw-string prefix: r", b", etc.
            if j > 0 and code[j - 1] in ("r", "R", "b", "B", "f", "F", "u", "U"):
                j -= 1
            if j > 1 and code[j - 1:j + 1].lower() in ("rb", "br", "rf", "fr"):
                j -= 1
            i = j - 1
            continue

        if ch in (")", "]", "}"):
            depth += 1
        elif ch in ("(", "[", "{"):
            if depth == 0:
                # Found the unmatched opening paren
                j = i - 1
                while j >= 0 and code[j] in (" ", "\t"):
                    j -= 1
                name_end = j + 1
                while j >= 0 and (code[j].isalnum() or code[j] in ("_", ".")):
                    j -= 1
                name = code[j + 1:name_end].strip(".")
                if name and _IDENT_RE.fullmatch(name) and name not in candidates:
                    candidates.append(name)
                break
            depth -= 1
        i -= 1

    return candidates


def inspect_object(
    code: str,
    cursor_pos: int,
    session_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Introspect the Python object at *cursor_pos* within *code*.

    Returns a dict with ``found``, ``name``, ``type``, ``signature``,
    ``docstring``, and ``detail`` fields.
    """
    empty = {
        "found": False,
        "name": "",
        "type": "",
        "signature": "",
        "docstring": "",
        "detail": "",
    }

    candidates = _extract_expression_at(code, cursor_pos)
    if not candidates:
        return empty

    session = _get_or_create_session_state(session_id)
    ns = session.namespace

    # Try each candidate until one resolves in the session namespace
    obj = None
    expr = ""
    for candidate in candidates:
        try:
            obj = eval(candidate, {"__builtins__": builtins.__dict__}, ns)  # noqa: S307
            expr = candidate
            break
        except Exception:
            continue

    if not expr:
        return empty

    result: Dict[str, Any] = {
        "found": True,
        "name": expr,
        "type": type(obj).__name__,
        "signature": "",
        "docstring": "",
        "detail": "",
    }

    # Signature (for callables)
    if callable(obj):
        try:
            sig = inspect.signature(obj)
            result["signature"] = f"{expr}{sig}"
        except (ValueError, TypeError):
            result["signature"] = f"{expr}(...)"

    # Docstring
    doc = inspect.getdoc(obj)
    if doc:
        if len(doc) > _MAX_DOC_LEN:
            doc = doc[:_MAX_DOC_LEN] + "\n..."
        result["docstring"] = doc

    # Extra detail for common types
    detail_parts: List[str] = []
    try:
        if isinstance(obj, dict):
            keys = list(obj.keys())
            shown = keys[:_MAX_DICT_KEYS]
            key_strs = [repr(k) for k in shown]
            detail_parts.append(f"Keys ({len(keys)}): [{', '.join(key_strs)}{'...' if len(keys) > _MAX_DICT_KEYS else ''}]")
            detail_parts.append(f"Length: {len(obj)}")
        elif isinstance(obj, pd.DataFrame):
            cols = list(obj.columns)
            shown = cols[:_MAX_DF_COLS]
            detail_parts.append(f"Shape: {obj.shape}")
            detail_parts.append(f"Columns ({len(cols)}): {shown}{'...' if len(cols) > _MAX_DF_COLS else ''}")
            dtypes_str = ", ".join(f"{c}: {obj[c].dtype}" for c in shown)
            detail_parts.append(f"Dtypes: {dtypes_str}")
        elif isinstance(obj, pd.Series):
            detail_parts.append(f"Shape: {obj.shape}")
            detail_parts.append(f"Dtype: {obj.dtype}")
            detail_parts.append(f"Name: {obj.name}")
        elif isinstance(obj, (list, tuple, set, frozenset)):
            detail_parts.append(f"Length: {len(obj)}")
            if len(obj) > 0:
                try:
                    preview = repr(obj)
                    if len(preview) > 200:
                        preview = preview[:200] + "..."
                    detail_parts.append(f"Preview: {preview}")
                except Exception:
                    pass
        elif isinstance(obj, str):
            detail_parts.append(f"Length: {len(obj)}")
            preview = repr(obj)
            if len(preview) > 200:
                preview = preview[:200] + "..."
            detail_parts.append(f"Value: {preview}")
        elif isinstance(obj, (int, float, complex, bool)):
            detail_parts.append(f"Value: {repr(obj)}")
        elif isinstance(obj, types.ModuleType):
            if hasattr(obj, "__version__"):
                detail_parts.append(f"Version: {obj.__version__}")
            if hasattr(obj, "__file__"):
                detail_parts.append(f"File: {obj.__file__}")
    except Exception:
        pass

    if detail_parts:
        result["detail"] = "\n".join(detail_parts)

    return result
