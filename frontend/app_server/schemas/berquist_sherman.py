from __future__ import annotations

from pydantic import BaseModel, Field


class BerquistShermanLoadRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    reserving_class: str = Field(..., min_length=1)
    # The persisted routing identity of the variant, which selects the method
    # JSON filename prefix. The page sends its contract's `method_type`.
    method_type: str = Field(..., min_length=1)
    method_name: str = Field(..., min_length=1)
