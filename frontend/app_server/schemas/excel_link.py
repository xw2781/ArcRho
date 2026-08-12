from pydantic import BaseModel


class ExcelLinkListRequest(BaseModel):
    project_name: str
    reserving_class: str


class ExcelLinkRetargetRequest(BaseModel):
    project_name: str
    reserving_class: str
    old_workbook_path: str
    new_workbook_path: str
    refresh_values: bool = False
