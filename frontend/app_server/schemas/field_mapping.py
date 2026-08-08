from typing import List, Optional

from pydantic import BaseModel, Field


class FieldMappingRow(BaseModel):
    field_name: str
    significance: Optional[str] = None
    dataset_type: Optional[str] = None
    level: Optional[int] = Field(default=None, ge=1)


class FieldMappingSaveRequest(BaseModel):
    project_name: str
    # Omitted (None) preserves the stored table_path; the CSV selection is
    # owned by the import-profile save, not the field mapping editor.
    table_path: Optional[str] = None
    rows: List[FieldMappingRow] = Field(default_factory=list)
