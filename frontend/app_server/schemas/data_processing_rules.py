from __future__ import annotations

from typing import List, Literal, Optional, Union

from pydantic import (
    BaseModel,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
)


JsonScalar = Union[StrictStr, StrictInt, StrictFloat, StrictBool]
JsonConditionValue = Union[JsonScalar, List[JsonScalar]]


class _StrictModel(BaseModel):
    class Config:
        extra = "forbid"


class DataProcessingRuleTarget(_StrictModel):
    source_measure: str


class DataProcessingRequestCondition(_StrictModel):
    field: str
    level: StrictInt
    operator: Literal["equals", "not_equals", "in", "not_in"]
    value: Union[StrictStr, List[StrictStr]]


class DataProcessingRowCondition(_StrictModel):
    field: str
    operator: Literal[
        "equals",
        "not_equals",
        "in",
        "not_in",
        "is_blank",
        "is_not_blank",
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
    ]
    value: Optional[JsonConditionValue] = None


class DataProcessingRequestConditions(_StrictModel):
    all: List[DataProcessingRequestCondition] = Field(default_factory=list)


class DataProcessingRowConditions(_StrictModel):
    all: List[DataProcessingRowCondition] = Field(default_factory=list)


class DataProcessingRuleAction(_StrictModel):
    type: Literal["keep_members", "exclude_members"]
    field: str
    level: Optional[StrictInt] = None
    members: List[str] = Field(default_factory=list)


class DataProcessingRule(_StrictModel):
    id: str
    name: str
    enabled: StrictBool = True
    target: DataProcessingRuleTarget
    request_conditions: DataProcessingRequestConditions = Field(
        default_factory=DataProcessingRequestConditions
    )
    row_conditions: DataProcessingRowConditions = Field(
        default_factory=DataProcessingRowConditions
    )
    action: DataProcessingRuleAction


class DataProcessingRulesData(_StrictModel):
    json_format: Optional[Literal["arcrho-data-processing-rules-v1"]] = None
    revision: Optional[StrictInt] = None
    updated_at: Optional[str] = None
    updated_by: Optional[str] = None
    rules: List[DataProcessingRule] = Field(default_factory=list)


class DataProcessingRulesValidateRequest(_StrictModel):
    project_name: str
    data: DataProcessingRulesData


class DataProcessingRulesSaveRequest(_StrictModel):
    project_name: str
    expected_revision: StrictInt
    data: DataProcessingRulesData
