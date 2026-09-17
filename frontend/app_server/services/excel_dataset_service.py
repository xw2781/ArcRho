"""Excel reads publications; only datasets without a sidecar may be calculated.

This policy belongs to the hosted ``dataset_csv`` operation. Dataset editors
and propagation keep using the ordinary runtime calculation service.
"""
from __future__ import annotations

import io
import os
import tempfile
import threading
from typing import Any

import pandas as pd
from fastapi import HTTPException

from arcrho_api.sidecar_core_contract import is_vector_format, stored_lengths
from arcrho_engine_calculation_contract import ENGINE_CALCULATION_CSV_FIELD, OUTPUT_VARIANT_CANONICAL
from app_server.helpers import _canon_dataset_name, read_dataset_csv as read_numeric_csv
from app_server.services import (
    arcrho_runtime_service as runtime,
    calculated_dataset_service as calculated,
    dependent_propagation_service,
    dataset_sidecar_status_service,
    engine_calculation_service as engine,
    file_read_cache,
    precedent_cache_service,
)

# Fixed lock stripes bound memory while sharing concurrent identical requests.
# Unique Engine output directories also isolate results that finish after a
# timeout or originate in another Gateway process.
_CACHE_LOCKS = tuple(threading.RLock() for _ in range(64))


def _require_available(pairs: list) -> None:
    state = dependent_propagation_service.get_reserving_class_busy(
        runtime._pair_value(pairs, "ProjectName"), runtime._pair_value(pairs, "Path")
    )
    if state.get("busy"):
        raise HTTPException(423, "This reserving class is being refreshed in ArcRho. Retry Excel Refresh when it finishes.")


def _publication(data_path: str, pairs: list) -> dict | None:
    path = runtime._dataset_sidecar_path(data_path, pairs)
    try:
        payload = file_read_cache.read_json_file_cached(path)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise HTTPException(503, "The published dataset metadata cannot be read. Refresh it in the ArcRho frontend.") from error
    if not isinstance(payload, dict) or not runtime._cache_payload_name_matches(
        payload, runtime._request_dataset_name(pairs)
    ) or not payload.get("csv_file"):
        raise HTTPException(422, "The published dataset metadata is invalid. Refresh it in the ArcRho frontend.")
    return payload


def _failure(data_path: str, message: str, status: str = "published_dataset_unavailable") -> dict:
    return {"ok": False, "status": status, "need_request": False, "data_path": data_path, "message": message}


def _csv(values: Any) -> str:
    buffer = io.StringIO()
    pd.DataFrame(values).to_csv(buffer, header=False, index=False)
    return buffer.getvalue()


def _validated_csv_text(path: str) -> str:
    """Preserve CSV spelling, but refuse Engine error text masquerading as data."""
    text = runtime._csv_file_text(path)
    pd.read_csv(io.StringIO(text), header=None, dtype="float64")
    return text


def _published(data_path: str, pairs: list, payload: dict, allow_derived: bool) -> dict:
    name = runtime._request_dataset_name(pairs)
    source_path = os.path.join(os.path.dirname(data_path), os.path.basename(str(payload["csv_file"])))
    source_origin, source_development = stored_lengths(payload)
    vector = is_vector_format(payload.get("data_format"))
    # Engine stored_* fields describe source-table granularity. The published
    # CSV may have been generated at coarser periods, recorded in its filename.
    if str(payload.get("source_kind") or "").lower() == "engine":
        settings = runtime._dependency_cache_settings(payload, payload.get("data_format"), source_path)
        source_origin = int(settings.get("periodlength" if vector else "originlength") or source_origin)
        source_development = int(settings.get("developmentlength") or source_development)
    variant = runtime._parse_cache_variant(source_path)
    source_cumulative = variant.get("cumulative", bool(payload.get("cumulative", True)))
    source_calendar = variant.get("calendar", bool(payload.get("calendar", False)))
    native_payload = {**payload, "cumulative": source_cumulative, "calendar": source_calendar}
    target_origin = runtime._pair_int_value(pairs, "OriginLength", 12)
    target_development = runtime._pair_int_value(pairs, "DevelopmentLength", 12)
    reason = ""
    if vector != runtime._request_is_vector(pairs):
        reason = "the requested data format differs from the publication"
    elif not vector and (
        source_cumulative != runtime._pair_bool_value(pairs, "Cumulative", True)
        or source_calendar != runtime._pair_bool_value(pairs, "Calendar", False)
    ):
        reason = "the requested cumulative or calendar mode differs from the publication"
    same_periods = target_origin == source_origin and (vector or target_development == source_development)
    if not reason and not same_periods:
        reason = precedent_cache_service.rollup_reason(native_payload, target_origin, target_development)
        if not allow_derived:
            reason = "derived views are disabled"
    if reason:
        return _failure(data_path, f"'{name}' cannot be read at the requested shape: {reason}. Use its published shape or refresh it in the ArcRho frontend.")
    try:
        if same_periods:
            text = _validated_csv_text(source_path)
        else:
            frame = read_numeric_csv(source_path, dtype="float64", keep_default_na=True)
            text = _csv(precedent_cache_service.rollup_rows(
                runtime._pair_value(pairs, "ProjectName"), native_payload,
                frame.to_numpy().tolist(), target_origin, target_development,
            ))
    except FileNotFoundError:
        return _failure(data_path, f"'{name}' has no published CSV. Refresh it in the ArcRho frontend.")
    except (ValueError, pd.errors.ParserError, pd.errors.EmptyDataError):
        return _failure(data_path, f"'{name}' does not contain a valid numeric published CSV. Refresh it in the ArcRho frontend.")
    except OSError:
        return _failure(data_path, f"'{name}' cannot be read from its published CSV. Check access to the dataset in the ArcRho frontend.")
    return {
        "ok": True, "need_request": False, "data_path": source_path,
        "sidecar_written": False, "local_cache_status": "cache_exact" if same_periods else "cache_derived",
        ENGINE_CALCULATION_CSV_FIELD: text,
    }


class _Reader:
    def __init__(self, timeout_sec: float, local_only: bool, allow_derived: bool):
        self.timeout_sec = timeout_sec
        self.local_only = local_only
        self.allow_derived = allow_derived
        self.results: dict[str, dict] = {}
        self.active: set[str] = set()
        self.rows: dict[str, list] = {}
        self.scans: dict[tuple[str, str], Any] = {}

    def read(self, pairs: list) -> dict:
        data_path = engine.resolve_engine_output_path(pairs, OUTPUT_VARIANT_CANONICAL)
        key = os.path.normcase(os.path.abspath(data_path))
        if key in self.active:
            return _failure(data_path, "Calculated dataset dependency cycle detected.", "calculation_failed")
        if key in self.results:
            return self.results[key]
        payload = _publication(data_path, pairs)
        if payload is not None:
            result = _published(data_path, pairs, payload, self.allow_derived)
        else:
            project = runtime._pair_value(pairs, "ProjectName")
            if project not in self.rows:
                self.rows[project] = calculated._dataset_type_rows(project)
            rows = self.rows[project]
            name = runtime._pair_value(pairs, "DatasetName") or runtime._pair_value(pairs, "TriangleName")
            contract = calculated._calculated_dataset_contract_from_rows(rows, name)
            if contract is not None:
                self.active.add(key)
                try:
                    result = self.calculate(pairs, data_path, contract, rows)
                finally:
                    self.active.remove(key)
            else:
                row = next((row for row in rows if _canon_dataset_name(row["name"]) == _canon_dataset_name(name)), {})
                if not row.get("generated"):
                    result = _failure(data_path, f"'{name}' has no published dataset and cannot be generated. Refresh it in the ArcRho frontend.")
                else:
                    result = self.generate(pairs, data_path, key)
        if result.get("ok"):
            self.results[key] = result
        return result

    def calculate(self, pairs: list, data_path: str, contract: dict, rows: list) -> dict:
        components = {}
        for name in contract["precedents"]:
            row = contract["precedent_contracts"].get(_canon_dataset_name(name), {})
            dependency_pairs = runtime._dependency_request_pairs(
                pairs, name, row.get("data_format") or "Triangle",
            )
            dependency_pairs = self.resolve_instance(dependency_pairs, name, row)
            response = self.read(dependency_pairs)
            if not response.get("ok"):
                return _failure(data_path, str(response.get("message") or f"Cannot read dependency '{name}'."), "calculation_failed")
            components[_canon_dataset_name(name)] = pd.read_csv(
                io.StringIO(response[ENGINE_CALCULATION_CSV_FIELD]), header=None, dtype="float64"
            ).to_numpy()
        try:
            values = calculated.evaluate_formula(contract["formula"], [row["name"] for row in rows], components)
        except (ValueError, KeyError, SyntaxError) as error:
            return _failure(data_path, f"Unable to calculate '{contract['name']}': {error}", "calculation_failed")
        return {"ok": True, "need_request": False, "status": "calculated_in_memory", "sidecar_written": False,
                ENGINE_CALCULATION_CSV_FIELD: _csv(values)}

    def resolve_instance(self, pairs: list, name: str, row: dict) -> list:
        """Use the existing formula dependency selector for named instances."""
        path = engine.resolve_engine_output_path(pairs, OUTPUT_VARIANT_CANONICAL)
        if _publication(path, pairs) is not None:
            return pairs
        project, reserving_class = runtime._pair_value(pairs, "ProjectName"), runtime._pair_value(pairs, "Path")
        key = (project, reserving_class)
        if key not in self.scans:
            self.scans[key] = calculated._scan_dataset_cache_folder(project, reserving_class)
        candidates = calculated._candidate_csvs(
            project, reserving_class, name,
            {"origin_length": runtime._pair_int_value(pairs, "OriginLength", 12),
             "development_length": runtime._pair_int_value(pairs, "DevelopmentLength", 12),
             "cumulative": runtime._pair_bool_value(pairs, "Cumulative", True),
             "calendar": runtime._pair_bool_value(pairs, "Calendar", False)},
            expected_data_format=row.get("data_format") or "Triangle", scan=self.scans[key],
        )
        if len(candidates) > 1:
            raise HTTPException(422, f"Ambiguous calculated dataset dependency: {name}.")
        if candidates:
            instance = str(candidates[0].get("sidecar", {}).get("dataset_name") or "").strip()
            if instance:
                return [(key, instance if key == "InstanceName" else value) for key, value in pairs]
        return pairs

    def generate(self, pairs: list, data_path: str, key: str) -> dict:
        with _CACHE_LOCKS[hash(key) % len(_CACHE_LOCKS)]:
            # Another request may have filled the cache, or the frontend may
            # have published this instance while this request waited.
            _require_available(pairs)
            payload = _publication(data_path, pairs)
            if payload is not None:
                return _published(data_path, pairs, payload, self.allow_derived)
            processing_hash = runtime._processing_hash_getter(pairs)
            if os.path.isfile(data_path) and runtime._runtime_cache_provenance_matches(data_path, pairs, processing_hash):
                try:
                    text = _validated_csv_text(data_path)
                except (ValueError, pd.errors.ParserError, pd.errors.EmptyDataError):
                    # Old runtime versions could record provenance for an
                    # Engine error CSV. Repair it through the normal cache miss.
                    pass
                else:
                    return {"ok": True, "need_request": False, "sidecar_written": False,
                            "local_cache_status": "cache_exact", "data_path": data_path,
                            ENGINE_CALCULATION_CSV_FIELD: text}
            if self.local_only:
                return _failure(data_path, "The temporary dataset needs generation; local-only reads cannot refresh it.", "local_cache_unavailable")
            os.makedirs(os.path.dirname(data_path), exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".excel-", dir=os.path.dirname(data_path)) as folder:
                staging_path = os.path.join(folder, os.path.basename(data_path))
                # Capture provenance before calculation, then verify the inputs
                # stayed unchanged. A late timed-out Engine writes only here.
                before = processing_hash()
                result = engine.run_engine_calculation(pairs, staging_path, self.timeout_sec)
                if not result.get("ok"):
                    return {**result, "need_request": True, "data_path": data_path}
                try:
                    text = _validated_csv_text(staging_path)
                except (ValueError, pd.errors.ParserError, pd.errors.EmptyDataError):
                    return _failure(data_path, "The ArcRho Engine returned invalid dataset values. The previous cache was preserved; check the dataset's processing configuration.", "engine_error")
                with dataset_sidecar_status_service.sidecar_write_lock(runtime._dataset_sidecar_path(data_path, pairs)):
                    _require_available(pairs)
                    payload = _publication(data_path, pairs)
                    if payload is not None:
                        return _published(data_path, pairs, payload, self.allow_derived)
                    if runtime._processing_hash_getter(pairs)() != before:
                        return _failure(data_path, "The source or processing settings changed during calculation. Retry Excel Refresh.", "inputs_changed")
                    dataset_sidecar_status_service.replace_staged_file(staging_path, data_path)
                    runtime._require_runtime_cache_provenance(data_path, pairs, processing_hash)
                return {"ok": True, "need_request": True, "sidecar_written": False, "data_path": data_path,
                        ENGINE_CALCULATION_CSV_FIELD: text}


def read_dataset_csv(pairs: list, timeout_sec: float, local_only: bool = False, allow_derived: bool = True) -> dict:
    """Return one Excel request, sharing dependencies only within that request."""
    _require_available(pairs)
    result = _Reader(timeout_sec, local_only, allow_derived).read(pairs)
    _require_available(pairs)
    return result
