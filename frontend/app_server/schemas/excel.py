from typing import List

from pydantic import BaseModel


class ExcelCellReadRequest(BaseModel):
    book_path: str
    sheet: str
    cell: str


class ExcelBatchReadRequest(BaseModel):
    items: List[ExcelCellReadRequest]


class ExcelFileMtimeBatchRequest(BaseModel):
    book_paths: List[str]


class ExcelOpenRequest(BaseModel):
    book_path: str
    sheet: str = ""
    cell: str = ""
