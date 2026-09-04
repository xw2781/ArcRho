"""Copy a reserving class aside where the workspace is local disk.

The two ResQ import macros copy the class they are about to rewrite into the
server's ``backups\\pre-import`` folder, one file at a time. Taken from a
Client PC every one of those copies is its own round trip over the mapped
drive, and the lookup that finds the class folder can read one index per class
on top of that. Registered as a hosted workspace mutation the whole copy runs
on the server host, so the macro pays one request instead.

The copy itself, the folder layout, what it leaves out, and the retention rule
are all ``arcrho_api.resq_import_backup``'s; this module adds no second
definition of a backup -- only the place it runs and the identity it is
stamped with.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import HTTPException

from arcrho_api.resq_import_backup import (
    back_up_reserving_class_on_disk,
    validate_backup_id,
)

from app_server import config
from app_server.services import user_identity_service


def back_up_reserving_class_for_import(
    project_name: str,
    reserving_class: str,
    backup_id: str,
    import_policy: str = "",
) -> Dict[str, Any]:
    """Take one pre-import backup of a reserving class on this host.

    Idempotent by backup id: an id whose copy is already finished here is
    reported as it stands rather than copied again under a second folder.
    """

    try:
        identifier = validate_backup_id(backup_id)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return back_up_reserving_class_on_disk(
        config.get_root_path(),
        project_name,
        reserving_class,
        backup_id=identifier,
        import_policy=import_policy,
        # The backup names the person who asked for it, not the profile the
        # ArcRho Server runs under.
        taken_by=user_identity_service.get_windows_login_name(),
    )
