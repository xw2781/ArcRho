from __future__ import annotations

from typing import Dict

from fastapi import APIRouter

from app_server.services import user_identity_service

router = APIRouter()


@router.get("/app/user-identity")
def get_user_identity() -> Dict[str, str]:
    return user_identity_service.get_current_identity()
