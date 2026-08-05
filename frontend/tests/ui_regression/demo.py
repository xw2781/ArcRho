"""Live demo / self-check for the ArcRho UI regression harness.

Starts the inspector console and walks a short scenario against the running ArcRho app, so a
human can watch the stream, the tally, and pause/resume without a full suite existing yet.

Commands the running build does not support are reported honestly as unsupported rather than
faked - the point of the demo is to show what the harness actually observes.

    py -3.10 frontend/tests/ui_regression/demo.py --port 8787 --hold 900
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[2]
for _path in (str(_HERE), str(_REPO_ROOT / "python-api" / "src")):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from inspector import InspectorServer  # noqa: E402
from report import RunReport, StepResult, FAIL, REVIEW  # noqa: E402

from arcrho_api.ui_testing import UiTestClient  # noqa: E402


# A realistic opening slice of the DFM scenario. `live` marks steps we actually send to the app.
DEMO_STEPS = [
    ("preflight", "app.health", {}, True),
    ("shell", "shell.listTabs", {}, True),
    ("project_instance", "projectInstance.context", {}, True),
    ("project_instance", "ui.pointer", {"enabled": True}, True),
    ("project_instance", "ui.captureScreenshot", {"name": "project-instance", "review": True}, True),
    ("dfm", "projectInstance.openDataset",
     {"name": "Claim Counts--CWOP", "openMethod": True, "methodType": "DFM"}, False),
    ("dfm", "page.snapshot", {"as": "dfm_loaded"}, False),
    ("dfm", "assert", {"path": "grid.columnCount", "op": "gt", "value": 0}, False),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="ArcRho UI regression harness demo")
    parser.add_argument("--port", type=int, default=8787, help="inspector port (0 = ephemeral)")
    parser.add_argument("--hold", type=float, default=900.0, help="seconds to keep the console up")
    parser.add_argument("--step-delay", type=float, default=1.4, help="pause between steps")
    parser.add_argument("--app-url", default=None, help="override ArcRho app URL")
    args = parser.parse_args()

    inspector = InspectorServer(port=args.port)
    url = inspector.start()
    print(f"\n  Inspector console:  {url}\n", flush=True)

    client = UiTestClient(app_url=args.app_url, default_timeout_sec=8.0)
    run_id = time.strftime("%Y%m%d-%H%M%S")
    artifact_dir = _REPO_ROOT / "frontend" / "test_artifacts" / "ui_regression" / run_id
    shots_dir = artifact_dir / "screenshots"
    report = RunReport(run_id, artifact_dir, project="NJ_Annual_Prod_202605_Fake")

    inspector.log(f"Demo run {run_id} starting")
    time.sleep(1.5)  # give a viewer a moment to connect before the first step

    for index, (section_name, op, step_args, live) in enumerate(DEMO_STEPS, start=1):
        if not inspector.wait_if_paused():
            inspector.log("Aborted by inspector.")
            break

        section = report.section(section_name, title=section_name.replace("_", " ").title())
        inspector.step(index, op, section=section_name, scenario="demo", args=step_args)
        started = time.monotonic()

        ok = True
        detail = ""
        if op == "app.health":
            health = client.queue_status()
            ok = bool(health.get("ok"))
            detail = "queue reachable" if ok else f"unreachable: {health.get('error', '')[:80]}"
            if not ok:
                # The queue endpoint is new; fall back to a command round-trip to prove liveness.
                probe = client.command("projectInstance.context", timeout_sec=5.0)
                ok = probe.ok or "Unsupported" in probe.error
                detail = "app reachable (queue endpoint needs backend restart)" if ok else probe.error[:90]
        elif op == "ui.captureScreenshot" and live:
            outcome = client.save_screenshot(
                step_args["name"], shots_dir / f"{step_args['name']}.png", review=True
            )
            ok = outcome.ok
            detail = outcome.result.get("path", "") if ok else outcome.error[:90]
            if ok:
                section.review_images.append({"name": step_args["name"], "flagged": False})
        elif live:
            outcome = client.command(op, step_args, timeout_sec=8.0)
            ok = outcome.ok
            detail = (
                str(outcome.result)[:110] if ok else outcome.error[:110]
            )
        else:
            ok = False
            detail = "requires the page automation protocol (Phase 2) - not built yet"

        duration_ms = int((time.monotonic() - started) * 1000)
        result = StepResult(index=index, op=op, ok=ok, detail=detail, duration_ms=duration_ms)
        target = section.layer_a if op == "app.health" else section.layer_b
        target.append(result)
        if not ok:
            section.record(REVIEW if "not built yet" in detail else FAIL, detail)
        inspector.result(op, ok, detail)
        time.sleep(max(0.1, args.step_delay))

    report.finish()
    paths = report.write()
    inspector.log(f"Report written: {paths['markdown']}")
    print(f"  Report: {paths['markdown']}")
    print(f"  Overall: {report.overall()}  (release_blocked={report.release_blocked()})\n")

    inspector.log("Demo finished. Console stays up - try Pause / Resume / Abort.")
    deadline = time.monotonic() + max(0.0, args.hold)
    try:
        while time.monotonic() < deadline and not inspector.aborted.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    inspector.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
