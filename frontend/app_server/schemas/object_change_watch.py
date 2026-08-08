from typing import List, Literal, Optional

from pydantic import BaseModel


class ObjectChangeFingerprintRequest(BaseModel):
    project_name: str
    reserving_class: str
    kind: Literal["dataset", "method"]
    # dataset: the dataset instance whose sidecar is watched.
    # method: the method name; method_type selects the <PREFIX>@ file.
    name: str
    method_type: str = ""
    # Optional method output dataset instance; when given, its sidecar is
    # watched alongside the method JSON so status flips are also detected.
    output_dataset: str = ""


class ObjectChangeFileFingerprint(BaseModel):
    role: Literal["sidecar", "method"]
    exists: bool
    size: Optional[int] = None
    mtime_ns: Optional[int] = None


class ObjectChangeFingerprintResponse(BaseModel):
    ok: Literal[True]
    files: List[ObjectChangeFileFingerprint]
    token: str
