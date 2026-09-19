from typing import List

from pydantic import BaseModel


class ExcelLinkListRequest(BaseModel):
    project_name: str
    reserving_class: str


class ExcelLinkRetargetRequest(BaseModel):
    project_name: str
    reserving_class: str
    old_workbook_path: str
    new_workbook_path: str


class ExcelLinkTarget(BaseModel):
    # "dataset" or "dfm", and the object's own name.
    kind: str
    name: str


class ExcelLinkRefreshRequest(BaseModel):
    project_name: str
    reserving_class: str
    targets: List[ExcelLinkTarget]


class ExcelLinkBreakTarget(BaseModel):
    # One manager row: the object, and the one workbook it stops reading.
    # A blank path breaks every link the object holds.
    kind: str
    name: str
    workbook_path: str = ""


class ExcelLinkBreakRequest(BaseModel):
    project_name: str
    reserving_class: str
    targets: List[ExcelLinkBreakTarget]
