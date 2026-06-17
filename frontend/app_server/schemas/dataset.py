from typing import List, Optional

from pydantic import BaseModel, Field


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
    csv_file: str = ""


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
