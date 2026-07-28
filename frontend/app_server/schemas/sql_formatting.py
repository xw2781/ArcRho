from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


SqlDialect = Literal["tsql", "snowflake"]
OpenQueryMode = Literal["auto", "snowflake", "off"]


class SqlFormattingPreviewRequest(BaseModel):
    sql: str = Field(max_length=2_000_000)
    dialect: SqlDialect
    openquery_mode: OpenQueryMode = "auto"


class SqlFormattingDiagnostic(BaseModel):
    code: str
    message: str
    severity: Literal["info", "warning", "error"] = "warning"
    line: Optional[int] = None
    column: Optional[int] = None
    dialect: SqlDialect
    region_id: Optional[str] = None


class SqlFormattingAdvisory(BaseModel):
    code: str
    title: str
    message: str
    severity: Literal["info", "warning"] = "warning"
    line: Optional[int] = None
    column: Optional[int] = None
    dialect: SqlDialect
    region_id: Optional[str] = None
    evidence: Optional[str] = None


class SqlFormattingSafetyReport(BaseModel):
    parsed_before: bool
    parsed_after: bool
    token_equivalent: bool
    protected_regions_preserved: bool
    idempotent: bool
    safe_to_apply: bool
    reasons: List[str] = Field(default_factory=list)


class SqlFormattingNestedRegion(BaseModel):
    region_id: str
    linked_server: str
    dialect: Optional[Literal["snowflake"]] = None
    status: Literal["formatted", "unchanged", "skipped", "error"]
    host_start: int
    host_end: int
    original_sql: str
    formatted_sql: Optional[str] = None
    diagnostics: List[SqlFormattingDiagnostic] = Field(default_factory=list)


class SqlFormattingPreviewResponse(BaseModel):
    source_hash: str
    formatted_hash: str
    formatted_sql: str
    changed: bool
    diagnostics: List[SqlFormattingDiagnostic] = Field(default_factory=list)
    advisories: List[SqlFormattingAdvisory] = Field(default_factory=list)
    safety: SqlFormattingSafetyReport
    nested_regions: List[SqlFormattingNestedRegion] = Field(default_factory=list)
    engine: Dict[str, str]
    elapsed_ms: int
