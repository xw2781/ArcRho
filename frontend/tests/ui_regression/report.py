"""Run report for the ArcRho UI regression workflow.

Emits `report.md` (the table a release decision is made from) and `report.json` (machine-readable,
same data). Verdicts are deliberately coarse: the point of a pre-release sweep is to sort sections
into "fine", "broken", and "a human needs to look at this".
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PASS = "PASS"
FAIL = "FAIL"
REVIEW = "REVIEW"
SKIP = "SKIP"
BLOCKED = "BLOCKED"

# Ordered worst-first: a section takes the most severe verdict any of its steps produced.
_VERDICT_SEVERITY = {FAIL: 4, BLOCKED: 3, REVIEW: 2, PASS: 1, SKIP: 0}

_VERDICT_MEANING = {
    PASS: "every assertion passed and no screenshot was flagged",
    FAIL: "at least one assertion failed - blocks release",
    REVIEW: "assertions passed but a screenshot changed or was flagged - needs a human",
    SKIP: "section deselected for this run",
    BLOCKED: "section could not run (missing wiring or unavailable dependency)",
}


@dataclass
class StepResult:
    index: int
    op: str
    ok: bool
    detail: str = ""
    expected: Any = None
    actual: Any = None
    duration_ms: int = 0
    screenshot: str = ""
    review: bool = False

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "index": self.index,
            "op": self.op,
            "ok": self.ok,
            "duration_ms": self.duration_ms,
        }
        if self.detail:
            payload["detail"] = self.detail
        if self.expected is not None or self.actual is not None:
            payload["expected"] = self.expected
            payload["actual"] = self.actual
        if self.screenshot:
            payload["screenshot"] = self.screenshot
            payload["review"] = self.review
        return payload


@dataclass
class SectionResult:
    section: str
    title: str = ""
    risk: str = ""
    verdict: str = PASS
    notes: list[str] = field(default_factory=list)
    layer_a: list[StepResult] = field(default_factory=list)
    layer_b: list[StepResult] = field(default_factory=list)
    review_images: list[dict[str, Any]] = field(default_factory=list)

    def record(self, verdict: str, note: str = "") -> None:
        if _VERDICT_SEVERITY.get(verdict, 0) > _VERDICT_SEVERITY.get(self.verdict, 0):
            self.verdict = verdict
        if note and note not in self.notes:
            self.notes.append(note)

    @staticmethod
    def _tally(steps: list[StepResult]) -> str:
        if not steps:
            return "-"
        return f"{sum(1 for s in steps if s.ok)}/{len(steps)}"

    def layer_a_tally(self) -> str:
        return self._tally(self.layer_a)

    def layer_b_tally(self) -> str:
        return self._tally(self.layer_b)

    def layer_c_tally(self) -> str:
        if not self.review_images:
            return "-"
        flagged = sum(1 for item in self.review_images if item.get("flagged"))
        return f"{len(self.review_images) - flagged} ok" if not flagged else f"{flagged} flagged"

    def to_json(self) -> dict[str, Any]:
        return {
            "section": self.section,
            "title": self.title,
            "risk": self.risk,
            "verdict": self.verdict,
            "notes": self.notes,
            "layer_a": [s.to_json() for s in self.layer_a],
            "layer_b": [s.to_json() for s in self.layer_b],
            "review_images": self.review_images,
        }


class RunReport:
    def __init__(self, run_id: str, artifact_dir: Path, *, project: str = "", app_version: str = ""):
        self.run_id = run_id
        self.artifact_dir = Path(artifact_dir)
        self.project = project
        self.app_version = app_version
        self.started_at = datetime.now(timezone.utc)
        self.finished_at: datetime | None = None
        self.sections: list[SectionResult] = []
        self.preflight: list[StepResult] = []

    def section(self, name: str, *, title: str = "", risk: str = "") -> SectionResult:
        existing = next((s for s in self.sections if s.section == name), None)
        if existing:
            return existing
        created = SectionResult(section=name, title=title or name, risk=risk)
        self.sections.append(created)
        return created

    def finish(self) -> None:
        self.finished_at = datetime.now(timezone.utc)

    # -- verdict rollup ----------------------------------------------------------

    def overall(self) -> str:
        worst = PASS
        for section in self.sections:
            if _VERDICT_SEVERITY.get(section.verdict, 0) > _VERDICT_SEVERITY.get(worst, 0):
                worst = section.verdict
        if not self.sections:
            return SKIP
        return worst

    def release_blocked(self) -> bool:
        return any(s.verdict in (FAIL, BLOCKED) for s in self.sections)

    def needs_human(self) -> list[SectionResult]:
        return [s for s in self.sections if s.verdict in (REVIEW, FAIL, BLOCKED)]

    # -- output ------------------------------------------------------------------

    def to_json(self) -> dict[str, Any]:
        duration = None
        if self.finished_at:
            duration = int((self.finished_at - self.started_at).total_seconds())
        return {
            "run_id": self.run_id,
            "project": self.project,
            "app_version": self.app_version,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "duration_sec": duration,
            "overall": self.overall(),
            "release_blocked": self.release_blocked(),
            "preflight": [s.to_json() for s in self.preflight],
            "sections": [s.to_json() for s in self.sections],
        }

    def to_markdown(self) -> str:
        overall = self.overall()
        duration = ""
        if self.finished_at:
            duration = f"{int((self.finished_at - self.started_at).total_seconds())}s"

        lines: list[str] = []
        lines.append("# ArcRho UI Regression Report")
        lines.append("")
        lines.append(f"- Run: `{self.run_id}`")
        if self.app_version:
            lines.append(f"- App version: `{self.app_version}`")
        if self.project:
            lines.append(f"- Project: `{self.project}`")
        lines.append(f"- Started: {self.started_at.isoformat(timespec='seconds')}")
        if duration:
            lines.append(f"- Duration: {duration}")
        lines.append(f"- **Overall: `{overall}`**"
                     + ("  -  release blocked" if self.release_blocked() else ""))
        lines.append("")

        lines.append("## Sections")
        lines.append("")
        lines.append("| Section | Layer A | Layer B | Layer C | Verdict | Notes |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for section in self.sections:
            note = "; ".join(section.notes)[:160]
            lines.append(
                f"| {section.title} | {section.layer_a_tally()} | {section.layer_b_tally()} "
                f"| {section.layer_c_tally()} | `{section.verdict}` | {note} |"
            )
        lines.append("")

        attention = self.needs_human()
        if attention:
            lines.append("## Needs Review")
            lines.append("")
            for section in attention:
                lines.append(f"### {section.title} - `{section.verdict}`")
                lines.append("")
                for note in section.notes:
                    lines.append(f"- {note}")
                failures = [s for s in section.layer_a + section.layer_b if not s.ok]
                for step in failures:
                    detail = step.detail or "(no detail)"
                    lines.append(f"- Step {step.index} `{step.op}` failed: {detail}")
                    if step.expected is not None or step.actual is not None:
                        lines.append(f"  - expected: `{step.expected!r}`")
                        lines.append(f"  - actual: `{step.actual!r}`")
                for image in section.review_images:
                    if image.get("flagged"):
                        lines.append(
                            f"- Screenshot `{image.get('name')}` flagged: {image.get('comment', '')}"
                        )
                lines.append("")
        else:
            lines.append("No section needs human review.")
            lines.append("")

        lines.append("## Verdict Meanings")
        lines.append("")
        for verdict, meaning in _VERDICT_MEANING.items():
            lines.append(f"- `{verdict}` - {meaning}")
        lines.append("")
        lines.append("## Artifacts")
        lines.append("")
        lines.append(f"- Directory: `{self.artifact_dir}`")
        lines.append("- `report.json` - machine-readable results")
        lines.append("- `screenshots/` - per-section PNGs")
        lines.append("- `snapshots/` - structured render state per checkpoint")
        lines.append("- `logs/run.log` - full step log")
        return "\n".join(lines).rstrip() + "\n"

    def write(self) -> dict[str, Path]:
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        json_path = self.artifact_dir / "report.json"
        md_path = self.artifact_dir / "report.md"
        json_path.write_text(
            json.dumps(self.to_json(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        md_path.write_text(self.to_markdown(), encoding="utf-8")
        return {"json": json_path, "markdown": md_path}
