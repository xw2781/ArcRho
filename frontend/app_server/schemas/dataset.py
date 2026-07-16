import re
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator


class PatchItem(BaseModel):
    r: int = Field(..., ge=0)
    c: int = Field(..., ge=0)
    value: Optional[float] = None


class PatchRequest(BaseModel):
    items: List[PatchItem]
    file_mtime: Optional[float] = None


class DatasetNotesLoadRequest(BaseModel):
    project_name: str
    reserving_class: str
    dataset_name: str


class DatasetNotesSaveRequest(BaseModel):
    project_name: str
    reserving_class: str
    dataset_name: str
    notes: str = ""


class DatasetSidecarLoadRequest(BaseModel):
    project_name: str
    reserving_class: str
    dataset_name: str


class DatasetCacheLoadRequest(BaseModel):
    project_name: str
    reserving_class: str
    dataset_name: str
    csv_file: str = ""
    origin_length: Optional[int] = Field(None, ge=1)
    development_length: Optional[int] = Field(None, ge=1)
    cumulative: bool = True
    calendar: bool = False


class DatasetCalculatedPreviewRequest(BaseModel):
    project_name: str
    reserving_class: str
    changed_dataset_name: str
    changed_dataset_type_name: str = ""
    values: List[List[Optional[float]]] = Field(default_factory=list)
    mask: Optional[List[List[bool]]] = None
    origin_labels: Optional[List[str]] = None
    development_labels: Optional[List[str]] = None


class DatasetExternalLinkTargetCell(BaseModel):
    row: int = Field(..., ge=0, strict=True)
    column: int = Field(..., ge=0, strict=True)
    source_cell: Optional[str] = None

    @field_validator("source_cell")
    @classmethod
    def normalize_source_cell(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip().replace("$", "").upper()
        if not re.fullmatch(r"[A-Z]+[1-9][0-9]*", normalized):
            raise ValueError("source_cell must be a valid Excel cell address")
        return normalized


class DatasetExternalLink(BaseModel):
    reference: str = Field(..., min_length=1, strict=True)
    target_cells: List[DatasetExternalLinkTargetCell] = Field(..., min_length=1)

    @field_validator("reference")
    @classmethod
    def normalize_reference(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("reference must not be blank")
        return normalized


class DatasetSidecarSaveRequest(BaseModel):
    project_name: str
    reserving_class: str
    dataset_name: str
    dataset_type: str = ""
    instance_name: str = ""
    source_kind: str = ""
    data_format: str = ""
    origin_length: int = Field(..., ge=1)
    development_length: int = Field(..., ge=1)
    cumulative: bool = True
    transposed: bool = False
    calendar: bool = False
    number_format: str = ""
    decimal_places: int = Field(1, ge=0, le=6)
    origin_labels: Optional[List[str]] = None
    csv_file: str = ""
    method_type: str = ""
    status: Optional[int] = None
    precedents: Optional[List[str]] = None
    external_links: Optional[List[DatasetExternalLink]] = None
    values: Optional[List[List[Optional[float]]]] = None
    mask: Optional[List[List[bool]]] = None


class EmptyDatasetCacheCreateRequest(BaseModel):
    project_name: str
    reserving_class: str
    dataset_type: str
    instance_name: str = ""
    data_format: str = "Triangle"
    origin_length: int = Field(12, ge=1)
    development_length: int = Field(12, ge=1)
    cumulative: bool = True
    calendar: bool = False


class CachedDatasetDeleteRequest(BaseModel):
    project_name: str
    reserving_class: str
    dataset_names: List[str] = Field(default_factory=list)
