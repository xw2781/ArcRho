from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class UiAutomationCommandRequest(BaseModel):
    command: str
    target: Dict[str, Any] = Field(default_factory=dict)
    args: Dict[str, Any] = Field(default_factory=dict)
    timeout_sec: float = 30.0
    # The shell window that should run the command; empty lets any window take it.
    owner: str = ""


class UiAutomationPollRequest(BaseModel):
    client_id: Optional[str] = None
    timeout_sec: float = 20.0


class UiAutomationCommandResult(BaseModel):
    ok: bool = True
    result: Dict[str, Any] = Field(default_factory=dict)
    error: str = ""


class UiAutomationCommandDecline(UiAutomationCommandResult):
    """A window handing a command back; the answer settles it if no other window is left."""

    client_id: str = ""
