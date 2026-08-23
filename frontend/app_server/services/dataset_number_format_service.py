from __future__ import annotations

import getpass
import json
import os
import re
import threading
import uuid
from datetime import datetime
from typing import Any, Dict, List

from fastapi import HTTPException

from arcrho_api.io import persisted_json_text
from arcrho_api.timestamps import utc_now_text
from app_server import config


JSON_FORMAT = "arcrho-dataset-number-formats-v4"
DEFAULT_NUMBER_FORMAT = "0,000"
DEFAULT_DECIMAL_PLACES = 0
_WRITE_LOCK = threading.Lock()
_WRITE_LOCK_TIMEOUT_SECONDS = 5.0


def _clean_lookup_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()


def normalize_number_format(value: Any, fallback: str = DEFAULT_NUMBER_FORMAT) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").replace("\t", " ").strip()
    fallback_text = str(fallback or DEFAULT_NUMBER_FORMAT).strip() or DEFAULT_NUMBER_FORMAT
    return (text or fallback_text)[:64]


def number_format_decimal_places(value: Any) -> int:
    text = normalize_number_format(value)
    match = re.search(r"[0#,]+(?:\.[0#]+)?", text)
    numeric = match.group(0) if match else DEFAULT_NUMBER_FORMAT
    dot_index = numeric.find(".")
    if dot_index < 0:
        return DEFAULT_DECIMAL_PLACES
    return max(0, min(6, len(numeric[dot_index + 1 :])))


def normalize_decimal_places(value: Any, fallback: int = DEFAULT_DECIMAL_PLACES) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(0, min(6, parsed))


def _empty_document() -> Dict[str, Any]:
    return {
        "json_format": JSON_FORMAT,
        "revision": 0,
        "default_number_format": DEFAULT_NUMBER_FORMAT,
        "updated_at": "",
        "updated_by": "",
        "overrides": [],
    }


def _normalize_document(raw: Any, *, strict: bool) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        if strict:
            raise ValueError("The number-format configuration root must be a JSON object.")
        return _empty_document()

    stored_format = str(raw.get("json_format") or "").strip()
    if stored_format and stored_format != JSON_FORMAT:
        if strict:
            raise ValueError(f"Unsupported number-format JSON contract: {stored_format}.")
        return _empty_document()

    document = _empty_document()
    document["revision"] = max(0, int(raw.get("revision") or 0))
    document["default_number_format"] = normalize_number_format(raw.get("default_number_format"))
    document["updated_at"] = str(raw.get("updated_at") or "").strip()
    document["updated_by"] = str(raw.get("updated_by") or "").strip()
    raw_overrides = raw.get("overrides")
    if raw_overrides is None:
        raw_overrides = []
    if not isinstance(raw_overrides, list):
        if strict:
            raise ValueError("The number-format configuration overrides must be an array.")
        raw_overrides = []

    overrides: List[Dict[str, str]] = []
    seen = {}
    for index, item in enumerate(raw_overrides, start=1):
        if not isinstance(item, dict):
            if strict:
                raise ValueError(f"Override row {index} must be a JSON object.")
            continue
        dataset_type_name = _clean_lookup_text(item.get("dataset_type_name"))[:256]
        raw_number_format = str(item.get("number_format") or "").replace("\r", " ").replace("\n", " ").replace("\t", " ").strip()
        if not dataset_type_name or not raw_number_format:
            if strict:
                raise ValueError(f"Override row {index} requires dataset_type_name and number_format.")
            continue
        number_format = normalize_number_format(raw_number_format)
        key = dataset_type_name.casefold()
        if key in seen:
            if seen[key] != number_format and strict:
                raise ValueError(f"Override row {index} conflicts with the existing Dataset Type Name override: {dataset_type_name}.")
            continue
        seen[key] = number_format
        overrides.append({
            "dataset_type_name": dataset_type_name,
            "number_format": number_format,
        })
    document["overrides"] = overrides
    return document


def _read_document(*, strict: bool) -> Dict[str, Any]:
    path = config.get_dataset_number_formats_path()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        return _empty_document()
    except Exception as error:
        if strict:
            raise HTTPException(500, f"Failed to read dataset number-format configuration: {str(error)}") from error
        return _empty_document()
    try:
        return _normalize_document(raw, strict=strict)
    except (TypeError, ValueError) as error:
        if strict:
            raise HTTPException(500, f"Dataset number-format configuration is invalid: {str(error)}") from error
        return _empty_document()


def get_preferences(*, dataset_type_name: Any = "") -> Dict[str, Any]:
    document = _read_document(strict=True)
    payload = {
        "ok": True,
        "path": config.get_dataset_number_formats_path(),
        **document,
    }
    if _clean_lookup_text(dataset_type_name):
        number_format = _document_number_format(document, dataset_type_name)
        payload["resolved_number_format"] = number_format
        payload["resolved_decimal_places"] = number_format_decimal_places(number_format)
    return payload


def _document_number_format(document: Dict[str, Any], dataset_type_name: Any) -> str:
    dataset_type_key = _clean_lookup_text(dataset_type_name).casefold()
    for item in document["overrides"]:
        if item["dataset_type_name"].casefold() == dataset_type_key:
            return item["number_format"]
    return document["default_number_format"]


def dataset_type_number_format(dataset_type_name: Any) -> str:
    document = _read_document(strict=False)
    return _document_number_format(document, dataset_type_name)


def dataset_type_number_format_settings(dataset_type_name: Any) -> Dict[str, Any]:
    number_format = dataset_type_number_format(dataset_type_name)
    return {
        "number_format": number_format,
        "decimal_places": number_format_decimal_places(number_format),
    }


def save_preferences(
    *,
    expected_revision: int,
    default_number_format: str,
    overrides: List[Dict[str, Any]],
) -> Dict[str, Any]:
    if not _WRITE_LOCK.acquire(timeout=_WRITE_LOCK_TIMEOUT_SECONDS):
        raise HTTPException(423, "Dataset number-format preferences are being saved by another request. Please retry.")
    try:
        current = _read_document(strict=True)
        current_revision = int(current.get("revision") or 0)
        if int(expected_revision) != current_revision:
            raise HTTPException(409, "Dataset number-format preferences changed in another window. Reload and try again.")
        try:
            candidate = _normalize_document({
                "revision": current_revision + 1,
                "default_number_format": default_number_format,
                "updated_at": utc_now_text(),
                "updated_by": getpass.getuser() or "unknown",
                "overrides": overrides,
            }, strict=True)
        except (TypeError, ValueError) as error:
            raise HTTPException(400, str(error)) from error

        path = config.get_dataset_number_formats_path()
        directory = os.path.dirname(path)
        temp_path = f"{path}.{uuid.uuid4()}.tmp"
        try:
            os.makedirs(directory, exist_ok=True)
            with open(temp_path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(persisted_json_text(candidate))
            os.replace(temp_path, path)
        except Exception as error:
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
            except OSError:
                pass
            raise HTTPException(500, f"Failed to save dataset number-format preferences: {str(error)}") from error
        return {"ok": True, "path": path, **candidate}
    finally:
        _WRITE_LOCK.release()
