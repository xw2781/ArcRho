"""Isolated dependent-propagation workspace for service unit tests.

A save preflights the live-Engine heartbeat plus the reserving-class hold and
then enqueues a real queue file, so a suite that runs saves must not share the
real ArcRho Server workspace: it would write junk requests onto the shared
server, and every save after the first — the next test's, or a second save in
the same test — would read the still-queued job as an active hold and be
refused with 423. No Engine consumes jobs during a unit test, so submission is
faked outright: the class always reads as writable and nothing is enqueued.
"""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path
from unittest import mock

from app_server.services import dependent_propagation_service

_TESTS_DIR = Path(__file__).resolve().parent


def _fake_submit(project_name, reserving_class, changed_roots, *, request_id=None):
    return {
        "ok": True,
        "job_id": request_id if request_id is not None else uuid.uuid4().hex,
        "status": "queued",
    }


class IsolatedPropagationWorkspace:
    """Patcher-shaped helper: append to a suite's ``self.patchers`` list.

    ``start()`` creates a fresh temp workspace root with one live Engine
    heartbeat, points ``dependent_propagation_service`` at it, and replaces
    job submission with a no-write fake; ``stop()`` undoes all of it.
    """

    def start(self) -> "IsolatedPropagationWorkspace":
        self._temp = tempfile.TemporaryDirectory(dir=str(_TESTS_DIR))
        root = Path(self._temp.name)
        instances = root / "runtime" / "instances" / "arcrho_engine"
        instances.mkdir(parents=True)
        (instances / "engine.json").write_text(
            '{"Server": "test"}\n', encoding="utf-8"
        )
        self._patches = [
            mock.patch.object(
                dependent_propagation_service.config,
                "load_workspace_paths",
                return_value={
                    "workspace_root": str(root),
                    "paths": {"projects_dir": "projects", "requests_dir": "requests"},
                },
            ),
            mock.patch.object(
                dependent_propagation_service,
                "submit_dependent_propagation_job",
                side_effect=_fake_submit,
            ),
        ]
        for patch in self._patches:
            patch.start()
        return self

    def stop(self) -> None:
        for patch in reversed(self._patches):
            patch.stop()
        self._temp.cleanup()
