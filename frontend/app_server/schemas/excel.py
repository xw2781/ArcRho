from typing import List

from pydantic import BaseModel


class ExcelCellReadRequest(BaseModel):
    book_path: str
    sheet: str
    cell: str


class ExcelBatchReadRequest(BaseModel):
    items: List[ExcelCellReadRequest]


class ExcelOpenRequest(BaseModel):
    book_path: str
    sheet: str = ""
    cell: str = ""
