from typing import Optional

from pydantic import BaseModel


class ArcRhoTriRequest(BaseModel):
    Path: str
    TriangleName: str
    ProjectName: str
    InstanceName: Optional[str] = None
    DatasetTypeName: Optional[str] = None
    Cumulative: bool = True
    Calendar: bool = False
    OriginLength: int = 12
    DevelopmentLength: int = 12
    timeout_sec: float = 6.0


class ArcRhoHeadersRequest(BaseModel):
    periodType: int = 0
    Transposed: bool = False
    Calendar: bool = False
    PeriodLength: int = 12
    ProjectName: str
    StoredPeriodLength: int = -1
    timeout_sec: float = 6.0


class ArcRhoHeadersCacheClearRequest(BaseModel):
    ProjectName: str
    OriginLength: Optional[int] = None
    DevelopmentLength: Optional[int] = None
