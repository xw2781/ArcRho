from pydantic import BaseModel


class TableSummaryRefreshRequest(BaseModel):
    # The summary always describes the project-owned imported master table, so
    # the project identifies the request; there is no caller-supplied path.
    project_name: str
    refresh_reserving: bool = True
