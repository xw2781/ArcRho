"""Live inspection console for the ArcRho UI regression harness.

Hosted by the *runner*, not by the app under test. That placement is the whole point: a scenario
that crashes, hangs, or restarts ArcRho is exactly when a human most needs to see which step was
executing, and a console living inside the app would die with it. The runner is also the only
process that knows the current scenario and step.

Transport is Server-Sent Events over `http.server` - stdlib only, matching `arcrho-api`'s
zero-dependency posture.

Pause-on-failure is nearly free here because the runner owns the execution loop: the console sets
a flag, the runner blocks before the next step, and the app sits frozen in its failing state for
as long as a human needs.
"""
from __future__ import annotations

import json
import queue
import sys
import threading
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

_CONSOLE_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>ArcRho UI Test Inspector</title>
<style>
  :root { color-scheme: light dark; --bg:#f8fafc; --fg:#1f2937; --muted:#64748b;
          --line:#e3e8f0; --card:#ffffff; --accent:#2563eb;
          --pass:#047857; --fail:#b91c1c; --review:#b45309; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f172a; --fg:#e2e8f0; --muted:#94a3b8; --line:#1e293b; --card:#111c33; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.45 "Segoe UI",system-ui,sans-serif; }
  header { position:sticky; top:0; background:var(--card); border-bottom:1px solid var(--line);
           padding:10px 14px; display:flex; align-items:center; gap:12px; }
  h1 { font-size:14px; margin:0; font-weight:650; flex:1 1 auto; }
  .dot { width:9px; height:9px; border-radius:999px; background:var(--muted); flex:0 0 auto; }
  .dot.live { background:var(--pass); }
  .dot.paused { background:var(--review); }
  button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--fg);
           border-radius:6px; padding:4px 10px; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  main { padding:14px; display:grid; gap:12px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; min-width:0; }
  .card h2 { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
             margin:0 0 8px; font-weight:650; }
  .now { font-size:15px; font-weight:600; overflow-wrap:anywhere; }
  .sub { color:var(--muted); margin-top:3px; overflow-wrap:anywhere; }
  .tally { display:flex; gap:16px; font-variant-numeric:tabular-nums; }
  .tally b { display:block; font-size:20px; }
  .pass b { color:var(--pass); } .fail b { color:var(--fail); } .review b { color:var(--review); }
  #log { max-height:38vh; overflow:auto; font-family:Consolas,monospace; font-size:12px; }
  #log div { padding:2px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
  #log .no { color:var(--fail); }
  #log .yes { color:var(--muted); }
  img { max-width:100%; border:1px solid var(--line); border-radius:6px; display:block; }
  .grid-full { grid-column: 1 / -1; }
</style></head><body>
<header>
  <span class="dot" id="dot"></span>
  <h1>ArcRho UI Test Inspector</h1>
  <button id="pause">Pause</button>
  <button id="resume" class="primary">Resume</button>
  <button id="abort">Abort</button>
</header>
<main>
  <section class="card">
    <h2>Now running</h2>
    <div class="now" id="step">waiting for the runner...</div>
    <div class="sub" id="where"></div>
    <div class="sub" id="args"></div>
  </section>
  <section class="card">
    <h2>Tally</h2>
    <div class="tally">
      <span class="pass"><b id="nPass">0</b>pass</span>
      <span class="fail"><b id="nFail">0</b>fail</span>
      <span class="review"><b id="nReview">0</b>review</span>
    </div>
    <div class="sub" id="last"></div>
  </section>
  <section class="card grid-full">
    <h2>Latest screenshot</h2>
    <img id="shot" alt="No screenshot captured yet">
  </section>
  <section class="card grid-full">
    <h2>Log</h2>
    <div id="log"></div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let nPass = 0, nFail = 0, nReview = 0;
  const post = (what) => fetch("/control", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ action: what })
  });
  $("pause").onclick = () => post("pause");
  $("resume").onclick = () => post("resume");
  $("abort").onclick = () => { if (confirm("Abort the run?")) post("abort"); };

  const source = new EventSource("/events");
  source.onopen = () => $("dot").classList.add("live");
  source.onerror = () => $("dot").classList.remove("live");
  source.onmessage = (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.kind === "step") {
      $("step").textContent = `${msg.index}. ${msg.op}`;
      $("where").textContent = `${msg.section || ""}${msg.scenario ? " / " + msg.scenario : ""}`;
      $("args").textContent = msg.args ? JSON.stringify(msg.args) : "";
    } else if (msg.kind === "result") {
      if (msg.ok) nPass++; else nFail++;
      $("nPass").textContent = nPass; $("nFail").textContent = nFail;
      $("last").textContent = msg.detail || "";
      const row = document.createElement("div");
      row.className = msg.ok ? "yes" : "no";
      row.textContent = `${msg.ok ? "PASS" : "FAIL"}  ${msg.op}  ${msg.detail || ""}`;
      $("log").prepend(row);
    } else if (msg.kind === "screenshot") {
      if (msg.review) { nReview++; $("nReview").textContent = nReview; }
      if (msg.dataUrl) $("shot").src = msg.dataUrl;
    } else if (msg.kind === "state") {
      $("dot").classList.toggle("paused", !!msg.paused);
      if (msg.paused) $("step").textContent += "   [PAUSED]";
    } else if (msg.kind === "log") {
      const row = document.createElement("div");
      row.textContent = msg.text || "";
      $("log").prepend(row);
    }
  };
</script></body></html>
"""


class InspectorServer:
    """SSE console the harness publishes to and a human watches."""

    def __init__(self, *, host: str = "127.0.0.1", port: int = 0):
        self._host = host
        self._requested_port = port
        self._subscribers: list[queue.Queue] = []
        self._lock = threading.Lock()
        self._history: list[dict[str, Any]] = []
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

        # Run-control state the runner polls between steps.
        self.paused = threading.Event()
        self.aborted = threading.Event()
        self._resume = threading.Event()
        self._resume.set()

    # -- lifecycle ---------------------------------------------------------------

    @property
    def port(self) -> int:
        return self._httpd.server_address[1] if self._httpd else 0

    @property
    def url(self) -> str:
        return f"http://{self._host}:{self.port}/"

    def start(self, *, open_browser: bool = False) -> str:
        server = _build_server(self, self._host, self._requested_port)
        self._httpd = server
        self._thread = threading.Thread(target=server.serve_forever, daemon=True)
        self._thread.start()
        if open_browser:
            try:
                webbrowser.open(self.url)
            except Exception:  # noqa: BLE001 - a missing browser must not fail the run
                pass
        return self.url

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None

    # -- publishing --------------------------------------------------------------

    def publish(self, payload: dict[str, Any]) -> None:
        message = {"ts": datetime.now(timezone.utc).isoformat(), **payload}
        with self._lock:
            self._history.append(message)
            if len(self._history) > 400:
                del self._history[:-400]
            subscribers = list(self._subscribers)
        for sink in subscribers:
            try:
                sink.put_nowait(message)
            except queue.Full:
                pass

    def step(self, index: int, op: str, *, section: str = "", scenario: str = "", args: Any = None) -> None:
        self.publish(
            {"kind": "step", "index": index, "op": op, "section": section,
             "scenario": scenario, "args": args}
        )

    def result(self, op: str, ok: bool, detail: str = "") -> None:
        self.publish({"kind": "result", "op": op, "ok": bool(ok), "detail": detail})

    def screenshot(self, name: str, *, data_url: str = "", review: bool = False) -> None:
        self.publish({"kind": "screenshot", "name": name, "dataUrl": data_url, "review": review})

    def log(self, text: str) -> None:
        self.publish({"kind": "log", "text": text})

    def _publish_state(self) -> None:
        self.publish({"kind": "state", "paused": self.paused.is_set(), "aborted": self.aborted.is_set()})

    # -- run control -------------------------------------------------------------

    def request_pause(self) -> None:
        self.paused.set()
        self._resume.clear()
        self._publish_state()

    def request_resume(self) -> None:
        self.paused.clear()
        self._resume.set()
        self._publish_state()

    def request_abort(self) -> None:
        self.aborted.set()
        # Release any waiter so the runner can observe the abort and unwind.
        self._resume.set()
        self._publish_state()

    def wait_if_paused(self, *, poll_sec: float = 0.25) -> bool:
        """Block while paused. Returns False when the run should abort."""
        while self.paused.is_set() and not self.aborted.is_set():
            self._resume.wait(timeout=poll_sec)
        return not self.aborted.is_set()

    def pause_for_failure(self, detail: str = "") -> None:
        self.log(f"PAUSED on failure: {detail}")
        self.request_pause()

    # -- subscriber plumbing -----------------------------------------------------

    def _subscribe(self) -> queue.Queue:
        sink: queue.Queue = queue.Queue(maxsize=500)
        with self._lock:
            for message in self._history[-80:]:
                try:
                    sink.put_nowait(message)
                except queue.Full:
                    break
            self._subscribers.append(sink)
        return sink

    def _unsubscribe(self, sink: queue.Queue) -> None:
        with self._lock:
            if sink in self._subscribers:
                self._subscribers.remove(sink)


def _build_server(inspector: InspectorServer, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: Any) -> None:  # noqa: A003 - silence stdlib access logging
            pass

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            if self.path in ("/", "/index.html"):
                self._send(200, _CONSOLE_HTML.encode("utf-8"), "text/html; charset=utf-8")
                return
            if self.path == "/events":
                self._stream_events()
                return
            self._send(404, b"not found", "text/plain; charset=utf-8")

        def do_POST(self) -> None:  # noqa: N802 - stdlib naming
            if self.path != "/control":
                self._send(404, b"not found", "text/plain; charset=utf-8")
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except ValueError:
                payload = {}
            action = str(payload.get("action") or "").strip().lower()
            if action == "pause":
                inspector.request_pause()
            elif action == "resume":
                inspector.request_resume()
            elif action == "abort":
                inspector.request_abort()
            body = json.dumps({"ok": True, "action": action}).encode("utf-8")
            self._send(200, body, "application/json")

        def _stream_events(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            sink = inspector._subscribe()
            try:
                while True:
                    try:
                        message = sink.get(timeout=15.0)
                        chunk = f"data: {json.dumps(message)}\n\n".encode("utf-8")
                    except queue.Empty:
                        chunk = b": keepalive\n\n"  # keeps proxies and the tab from dropping
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                inspector._unsubscribe(sink)

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

        def handle_error(self, request: Any, client_address: Any) -> None:
            # A viewer closing its tab aborts the SSE socket mid-read. That is normal, and the
            # stdlib default would print a full traceback into the run's console for each one.
            exc = sys.exc_info()[1]
            if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
                return
            super().handle_error(request, client_address)

    return Server((host, port), Handler)
