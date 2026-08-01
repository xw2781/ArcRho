from typing import Optional
from uuid import UUID

from pydantic import BaseModel

from app_server import config


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
    LocalOnly: bool = False
    AllowDerived: bool = True
    WriteSidecar: bool = True
    TemporarySessionId: Optional[UUID] = None
    timeout_sec: float = config.ENGINE_REQUEST_TIMEOUT_SEC


class ArcRhoVecRequest(BaseModel):
    Path: str
    ProjectName: str
    InstanceName: Optional[str] = None
    DatasetTypeName: Optional[str] = None
    VectorName: Optional[str] = None
    PeriodLength: int = 12
    Cumulative: bool = True
    Calendar: bool = False
    Transposed: bool = False
    LocalOnly: bool = False
    AllowDerived: bool = True
    WriteSidecar: bool = True
    TemporarySessionId: Optional[UUID] = None
    timeout_sec: float = config.ENGINE_REQUEST_TIMEOUT_SEC


class ArcRhoHeadersRequest(BaseModel):
    periodType: int = 0
    Transposed: bool = False
    Calendar: bool = False
    PeriodLength: int = 12
    ProjectName: str
    StoredPeriodLength: int = -1
    timeout_sec: float = config.ENGINE_REQUEST_TIMEOUT_SEC


class ArcRhoHeadersCacheClearRequest(BaseModel):
    ProjectName: str
    OriginLength: Optional[int] = None
    DevelopmentLength: Optional[int] = None
