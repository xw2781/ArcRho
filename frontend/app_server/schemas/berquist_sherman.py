from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field

from app_server.schemas.dataset import DatasetSidecarSaveRequest


class BerquistShermanLoadRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    reserving_class: str = Field(..., min_length=1)
    # The persisted routing identity of the variant, which selects the method
    # JSON filename prefix. The page sends its contract's `method_type`.
    method_type: str = Field(..., min_length=1)
    method_name: str = Field(..., min_length=1)


class BerquistShermanSaveRequest(BerquistShermanLoadRequest):
    # The complete method payload as the page built it; the page owns the schema.
    method: Dict[str, Any]
    # The output CSV, as text, with the bare file name it is stored under in the
    # reserving class's dataset cache. Both are omitted by a write that only
    # rewrites the method JSON in place.
    csv_file: Optional[str] = None
    output_csv: Optional[str] = None
    # The output dataset's sidecar, saved in the same hosted call so the whole
    # save is one round trip. It is the canonical sidecar-save body rather than
    # a second copy of that field list; the project and the reserving class it
    # carries must be the ones this request already names. Omitted by the same
    # method-JSON-only write as the two fields above, which publishes nothing
    # and queues no dependent walk.
    sidecar: Optional[DatasetSidecarSaveRequest] = None
