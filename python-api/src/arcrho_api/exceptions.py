"""Exception types raised by arcrho_api."""


class ArcRhoApiError(Exception):
    """Base exception for ArcRho API errors."""


class InvalidArcRhoServerError(ArcRhoApiError):
    """Raised when a server root does not look like an Arco Server folder."""


class ProjectNotFoundError(ArcRhoApiError):
    """Raised when a project folder cannot be found."""


class InvalidDfmJsonError(ArcRhoApiError):
    """Raised when a DFM JSON file is missing required structure."""


class DfmDataError(ArcRhoApiError):
    """Raised when a DFM helper cannot operate on available method data."""


class ReadOnlyError(ArcRhoApiError):
    """Raised when a write is attempted through a read-only client."""

