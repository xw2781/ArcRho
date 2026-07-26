import re
from pathlib import Path
import math
import threading
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

import pythoncom
import win32com.client
import win32timezone  # noqa: F401 - required by pywin32 COM date conversion in frozen builds.

from arcrho_bridge.bridge_utils import read_json, write_json, write_json_with_compact_rows


CONNECTION_NAME = "JGO_CO1SQLWPV22"
DFM_METHOD_JSON_FORMAT = "arcrho-dfm-method-by-tab-v1"
RESULT_SELECTION_JSON_FORMAT = "arcrho-result-selection-method-by-tab-v2"
DFM_COMPACT_ROW_KEYS = (
    "input data triangle values",
    "ratio values",
    "excluded",
    "selected",
    "values",
)


class ResQClient:
    def __init__(self):
        self.app = None
        self._disconnect_lock = threading.RLock()
        self._com_thread_id = None
        self._com_initialized = False

    def _ensure_com_initialized(self):
        thread_id = threading.get_ident()
        if self._com_initialized and self._com_thread_id == thread_id:
            return
        pythoncom.CoInitialize()
        self._com_initialized = True
        self._com_thread_id = thread_id

    def _uninitialize_com(self):
        if not self._com_initialized:
            return
        if self._com_thread_id != threading.get_ident():
            return
        pythoncom.CoUninitialize()
        self._com_initialized = False
        self._com_thread_id = None

    def _connect(self):
        with self._disconnect_lock:
            if self.app is not None and self._com_thread_id != threading.get_ident():
                raise RuntimeError("ResQ COM connection is owned by another bridge worker thread.")
            self._ensure_com_initialized()
            if self.app is None:
                try:
                    self.app = win32com.client.Dispatch("ResQ3Automation.ResQApplication")
                    self.app.ConnectByName(CONNECTION_NAME, "", "")
                except Exception:
                    self.app = None
                    self._uninitialize_com()
                    raise
            return self.app

    def disconnect_if_idle(self):
        return

    def _disconnect(self):
        with self._disconnect_lock:
            if self.app is not None and self._com_thread_id != threading.get_ident():
                return
            app = self.app
            self.app = None
        if app is None:
            self._uninitialize_com()
            return
        try:
            app.Disconnect()
        except Exception:
            pass
        finally:
            self._uninitialize_com()

    def close(self):
        self._disconnect()

    def write_dfm_payload(self, request):
        self._connect()
        try:
            dfm = self._dfm_method(request)
            output_vector = self._optional_value(dfm, "OutputVector", None)
            output_dataset = self._clean_label(request.get("OutputVector") or self._nested_name(dfm, "OutputVector"))
            output_type = self._clean_label(self._nested_name(output_vector, "DatasetType") if output_vector is not None else "")
            output_category = self._clean_label(
                self._nested_name(self._optional_value(output_vector, "DatasetType", None), "Category")
                if output_vector is not None else ""
            )
            average_data = self._average_data(dfm)
            origin_labels, data_development_labels = self._labels(dfm)
            ratio_development_labels = self._ratio_development_labels(data_development_labels)
            cell_notes = self._cell_notes_data(
                dfm,
                origin_labels,
                ratio_development_labels,
                average_data.get("label", []),
            )
            payload = {
                "json format": DFM_METHOD_JSON_FORMAT,
                "details tab": {
                    "name": self._clean_label(request.get("MethodName") or self._optional_value(dfm, "Name", "")),
                    "output type": output_type or output_dataset,
                    "output dataset": output_dataset,
                    "output dataset_category": output_category,
                    "output category": output_category,
                    "input triangle": self._nested_name(dfm, "InputTriangle"),
                    "origin length": self._optional_value(dfm, "OriginLength", ""),
                    "development length": self._optional_value(dfm, "DevelopmentLength", ""),
                    "decimal places": self._optional_value(dfm, "RatioDecimalPlaces", request.get("DecimalPlaces", 4)),
                },
                "data tab": {
                    "origin labels": origin_labels,
                    "development labels": data_development_labels,
                    "input data triangle values": [],
                    "input data triangle csv path": "",
                },
                "ratios tab": {
                    "ratio triangle": {
                        "origin labels": origin_labels,
                        "development labels": ratio_development_labels,
                        "ratio values": [],
                        "excluded": self._excluded_ratio_pattern(dfm),
                    },
                    "average formulas": average_data,
                    "cell notes": cell_notes,
                },
                "results tab": {
                    "ratio basis dataset": self._nested_name(dfm, "SummaryRatioBasis"),
                    "ultimate ratio decimal places": self._optional_value(dfm, "SummaryRatioDecimalPlaces", 2),
                    "ultimate vector": [],
                },
                "method metadata": {
                    "last modified": self._dfm_last_modified(dfm),
                },
            }
            write_json_with_compact_rows(request["DataPath"], payload, compact_row_keys=DFM_COMPACT_ROW_KEYS)
            return payload
        finally:
            self._disconnect()

    def write_sync_dfm_payload(self, request):
        self._connect()
        try:
            dfm = self._dfm_method(request)
            payload = read_json(request["MethodJsonPath"])
            excluded_count = self._sync_excluded_ratios(dfm, payload)
            user_entry_count = self._sync_user_entry_values(dfm, payload)
            selected_count = self._sync_selected_ratios(dfm, payload)
            cell_notes_changed = self._sync_cell_notes(dfm, payload)
            dfm.Save()
            payload = {
                "ok": True,
                "status": "passed",
                "message": "Remote database updated",
                "updated": {
                    "excluded ratios": excluded_count,
                    "selected ratios": selected_count,
                    "user entry values": user_entry_count,
                    "cell notes": cell_notes_changed,
                },
            }
            write_json(request["DataPath"], payload)
            return payload
        finally:
            self._disconnect()

    def write_result_selection_payload(self, request):
        self._connect()
        try:
            result_selection = self._result_selection_method(request)
            origin_length = int(self._optional_value(result_selection, "OriginLength", request.get("OriginLength", 12)) or 12)
            origin_count = self._positive_int_member(result_selection, "OriginCount", 0)
            if origin_count <= 0:
                raise RuntimeError(f"Result Selection {request.get('MethodName', '')!r} does not expose a positive OriginCount.")

            origin_labels = [
                self._result_selection_origin_label(result_selection, origin_index)
                for origin_index in range(1, origin_count + 1)
            ]
            loaded_datasets = [
                self._result_selection_source_payload(result_selection, dataset_index, origin_count, origin_length)
                for dataset_index in range(1, int(self._optional_value(result_selection, "DatasetCount", 0) or 0) + 1)
            ]
            ultimate_overrides = self._result_selection_ultimate_overrides(result_selection, origin_count, origin_length)
            calculated_ultimate = self._result_selection_calculated_ultimate(loaded_datasets, origin_count)
            selected_ultimate = self._result_selection_selected_ultimate(calculated_ultimate, ultimate_overrides, origin_count)

            output_vector = self._optional_value(result_selection, "OutputVector", None)
            name = self._clean_label(
                request.get("MethodName")
                or self._nested_name(result_selection, "OutputVector")
                or self._optional_value(result_selection, "Name", "")
            )
            output_type = self._nested_name(output_vector, "DatasetType") if output_vector is not None else ""
            ratio_basis_dataset = self._result_selection_ratio_basis_dataset_name(result_selection)
            ratio_basis_values = []
            if ratio_basis_dataset:
                values = []
                for origin_index in range(1, origin_count + 1):
                    try:
                        values.append(self._rs_json_number(
                            self._result_selection_ratio_basis_value(
                                result_selection,
                                origin_index,
                                origin_length,
                            )
                        ))
                    except Exception:
                        values.append(None)
                ratio_basis_values.append({"name": ratio_basis_dataset, "values": values})
            payload = {
                "json_format": RESULT_SELECTION_JSON_FORMAT,
                "details_tab": {
                    "name": name,
                    "output_type": self._clean_label(request.get("OutputType") or output_type or name),
                    "origin_length": origin_length,
                    "ratio_basis_datasets": [ratio_basis_dataset] if ratio_basis_dataset else [],
                    "active_ratio_basis_dataset": ratio_basis_dataset,
                    "show_ratios_as_percentages": True,
                    "statistic_decimal_places": 1,
                },
                "method_tab": {
                    "origin_labels": origin_labels,
                    "show_weights": True,
                    "loaded_datasets": loaded_datasets,
                    "ratio_basis_values": ratio_basis_values,
                    "calculated_ultimate": calculated_ultimate,
                    "selected_ultimate": selected_ultimate,
                    "ultimate_overrides": ultimate_overrides,
                },
                "results_tab": {},
                "validation_tab": {},
                "method_metadata": {
                    "last_modified": self._result_selection_last_modified(result_selection),
                },
            }
            write_json(request["DataPath"], payload)
            return payload
        finally:
            self._disconnect()

    def write_sync_result_selection_payload(self, request):
        self._connect()
        try:
            result_selection = self._result_selection_method(request)
            payload = read_json(request["MethodJsonPath"])
            origin_length_changed = self._sync_result_selection_origin_length(result_selection, payload)
            weight_count = self._sync_result_selection_weights(result_selection, payload)
            ultimate_count = self._sync_result_selection_ultimate_overrides(result_selection, payload)
            result_selection.Save()
            status_payload = {
                "ok": True,
                "status": "passed",
                "message": "Remote Result Selection updated",
                "updated": {
                    "origin length": origin_length_changed,
                    "weights": weight_count,
                    "ultimate overrides": ultimate_count,
                },
            }
            write_json(request["DataPath"], status_payload)
            return status_payload
        finally:
            self._disconnect()

    def write_error(self, request, message):
        data_path = request.get("DataPath")
        if not data_path:
            return
        write_json(
            Path(data_path),
            {
                "ok": False,
                "status": "error",
                "message": str(message),
            },
        )

    def _dfm_method(self, request):
        project = self.app.Projects().Item(request["ProjectName"])
        reserving_class = project.ReservingClasses().Item(request["Path"])
        return reserving_class.DFMMethods().Item(request["MethodName"])

    def _result_selection_method(self, request):
        project = self.app.Projects().Item(request["ProjectName"])
        reserving_class = project.ReservingClasses().Item(request["Path"])
        method_name = request["MethodName"]
        collection = None
        try:
            collection = reserving_class.ResultSelections()
        except Exception:
            pass
        if collection is not None:
            try:
                candidate = collection.Item(method_name)
                if self._is_result_selection_method(candidate):
                    return candidate
            except Exception:
                pass
            candidate = self._find_result_selection_by_smart_name(collection, method_name)
            if candidate is not None:
                return candidate
        try:
            candidate = reserving_class.GetResultSelection(method_name)
            if self._is_result_selection_method(candidate):
                return candidate
        except Exception:
            pass
        raise RuntimeError(f"Result Selection not found: {method_name}")

    def _is_result_selection_method(self, candidate):
        return candidate is not None and self._positive_int_member(candidate, "OriginCount", 0) > 0

    def _find_result_selection_by_smart_name(self, collection, requested_name):
        requested_keys = self._result_selection_search_keys(requested_name)
        if not requested_keys:
            return None
        for result_selection in self._iter_resq_collection(collection):
            if not self._is_result_selection_method(result_selection):
                continue
            candidate_keys = set()
            candidate_keys.update(self._result_selection_search_keys(self._nested_name(result_selection, "OutputVector")))
            candidate_keys.update(self._result_selection_search_keys(self._optional_value(result_selection, "Name", "")))
            if requested_keys.intersection(candidate_keys):
                return result_selection
        return None

    def _iter_resq_collection(self, collection):
        try:
            for item in collection:
                yield item
            return
        except Exception:
            pass
        count = self._positive_int_member(collection, "Count", 0)
        for index in range(1, count + 1):
            try:
                yield collection.Item(index)
            except Exception:
                continue

    def _result_selection_search_keys(self, value):
        raw = str(value or "").strip().lower()
        if not raw:
            return set()
        whitespace_normalized = self._label_key(raw)
        syntax_normalized = re.sub(r"[^a-z0-9]+", "", whitespace_normalized)
        return {key for key in (raw, whitespace_normalized, syntax_normalized) if key}

    def _result_selection_origin_label(self, result_selection, origin_index):
        try:
            return self._clean_label(result_selection.OriginLabel(origin_index))
        except Exception:
            return str(origin_index)

    def _result_selection_source_payload(self, result_selection, dataset_index, origin_count, origin_length):
        dataset = result_selection.Dataset(dataset_index)
        dataset_type = self._optional_value(dataset, "DatasetType", None)
        data_format_code = self._optional_value(dataset_type, "DataFormat", -1)
        method_type_code = self._optional_value(dataset, "MethodType", 0)
        data_format = "Triangle" if int(data_format_code or -1) == 0 else "Vector"
        method_type = self._method_type_name(method_type_code)
        name = self._clean_label(self._optional_value(dataset, "Name", "")) or f"Source {dataset_index}"
        dataset_type_name = self._clean_label(self._optional_value(dataset_type, "Name", ""))
        values = []
        weights = []
        for origin_index in range(1, origin_count + 1):
            try:
                values.append(self._rs_json_number(self._result_selection_dataset_value(result_selection, dataset_index, origin_index, origin_length)))
            except Exception:
                values.append(None)
            try:
                weights.append(max(0.0, self._rs_json_number(
                    self._result_selection_weight(result_selection, dataset_index, origin_index)
                ) or 0.0))
            except Exception:
                weights.append(0)
        return {
            "name": name,
            "dataset_type": dataset_type_name,
            "data_format": data_format,
            "method_type": method_type,
            "category": self._nested_name(dataset_type, "Category") if dataset_type is not None else "",
            "source_kind": self._result_selection_source_kind(name, dataset_type_name, data_format, method_type_code),
            "origin_length": self._positive_int_member(dataset, "OriginLength", origin_length),
            "values": values,
            "weights": weights,
        }

    def _result_selection_source_kind(self, name, dataset_type, data_format, method_type_code):
        try:
            method_code = int(method_type_code)
        except Exception:
            method_code = 0
        if method_code == 1:
            return "dfm"
        if method_code == 4:
            return "result_selection"
        if str(data_format or "").strip().lower() == "triangle":
            return "engine" if self._clean_label(dataset_type) == self._clean_label(name) else "input"
        return "input"

    def _result_selection_calculated_ultimate(self, loaded_datasets, origin_count):
        ultimate = []
        for row_index in range(origin_count):
            numerator = 0.0
            denominator = 0.0
            for source in loaded_datasets:
                if not isinstance(source, dict):
                    continue
                values = source.get("values") if isinstance(source.get("values"), list) else []
                weights = source.get("weights") if isinstance(source.get("weights"), list) else []
                try:
                    value = float(values[row_index])
                    weight = max(0.0, float(weights[row_index]))
                except (IndexError, TypeError, ValueError):
                    continue
                if not math.isfinite(value) or not math.isfinite(weight) or weight <= 0:
                    continue
                numerator += value * weight
                denominator += weight
            ultimate.append(self._rs_json_number(numerator / denominator) if denominator > 0 else None)
        return ultimate

    def _result_selection_selected_ultimate(self, calculated_ultimate, ultimate_overrides, origin_count):
        selected = []
        for row_index in range(origin_count):
            override = ultimate_overrides[row_index] if row_index < len(ultimate_overrides) else None
            selected.append(override if override is not None else calculated_ultimate[row_index])
        return selected

    def _result_selection_ratio_basis_dataset_name(self, result_selection):
        for args, kwargs in (
            ((1,), {}),
            ((), {"DatasetIndex": 1}),
            ((), {"arg0": 1}),
        ):
            try:
                dataset = result_selection.RatioBasisDataset(*args, **kwargs)
                return self._clean_label(self._optional_value(dataset, "Name", ""))
            except Exception:
                continue
        return ""

    def _result_selection_ratio_basis_value(self, result_selection, origin_index, origin_length):
        return self._call_result_selection_member(
            result_selection,
            "RatioBasisValues",
            (
                ((origin_index, origin_length), {}),
                ((origin_index,), {}),
                ((), {"OriginIndex": origin_index, "OriginLength": origin_length}),
            ),
        )

    def _result_selection_ultimate_overrides(self, result_selection, origin_count, origin_length):
        overrides = []
        for origin_index in range(1, origin_count + 1):
            try:
                is_overridden = bool(result_selection.UltimateOverridden(origin_index))
            except Exception:
                is_overridden = False
            if not is_overridden:
                overrides.append(None)
                continue
            try:
                overrides.append(self._rs_json_number(self._result_selection_ultimate(result_selection, origin_index, origin_length)))
            except Exception:
                overrides.append(None)
        return overrides

    def _result_selection_dataset_value(self, result_selection, dataset_index, origin_index, origin_length):
        return self._call_result_selection_member(
            result_selection,
            "DatasetValues",
            (
                ((dataset_index, origin_index, origin_length), {}),
                ((), {"DatasetIndex": dataset_index, "OriginIndex": origin_index, "OriginLength": origin_length}),
            ),
        )

    def _result_selection_weight(self, result_selection, dataset_index, origin_index):
        return self._call_result_selection_member(
            result_selection,
            "Weights",
            (
                ((dataset_index, origin_index), {}),
                ((), {"DatasetIndex": dataset_index, "OriginIndex": origin_index}),
            ),
        )

    def _result_selection_ultimate(self, result_selection, origin_index, origin_length):
        return self._call_result_selection_member(
            result_selection,
            "Ultimates",
            (
                ((origin_index, origin_length), {}),
                ((origin_index,), {}),
                ((), {"OriginIndex": origin_index, "OriginLength": origin_length}),
            ),
        )

    def _call_result_selection_member(self, result_selection, member_name, call_shapes):
        member = getattr(result_selection, member_name)
        last_error = None
        for args, kwargs in call_shapes:
            try:
                return member(*args, **kwargs)
            except Exception as exc:
                last_error = exc
        raise last_error or RuntimeError(f"Unable to call Result Selection member: {member_name}")

    def _method_type_name(self, code):
        try:
            value = int(code)
        except Exception:
            value = 0
        return {
            0: "None",
            1: "DFM",
            2: "BF",
            3: "CC",
            4: "Result Selection",
        }.get(value, "")

    def _sync_result_selection_origin_length(self, result_selection, payload):
        details_tab = self._dict_path(payload, ("details_tab",))
        if "origin_length" not in details_tab:
            return False
        try:
            origin_length = int(details_tab.get("origin_length") or 0)
        except Exception:
            return False
        if origin_length <= 0:
            return False
        result_selection.OriginLength = origin_length
        return True

    def _sync_result_selection_weights(self, result_selection, payload):
        method_tab = self._dict_path(payload, ("method_tab",))
        sources = method_tab.get("loaded_datasets") if isinstance(method_tab, dict) else None
        if not isinstance(sources, list):
            return 0
        source_indexes = self._result_selection_dataset_indexes(result_selection)
        origin_count = self._positive_int_member(result_selection, "OriginCount", 0)
        updates = 0
        for source in sources:
            if not isinstance(source, dict):
                continue
            dataset_index = source_indexes.get(self._label_key(source.get("name")))
            weights = source.get("weights")
            if dataset_index is None or not isinstance(weights, list):
                continue
            for origin_index, raw_value in enumerate(weights, start=1):
                if origin_index > origin_count:
                    break
                value = self._number_or_zero(raw_value)
                result_selection.SetWeights(dataset_index, origin_index, value)
                updates += 1
        return updates

    def _sync_result_selection_ultimate_overrides(self, result_selection, payload):
        method_tab = self._dict_path(payload, ("method_tab",))
        overrides = method_tab.get("ultimate_overrides") if isinstance(method_tab, dict) else None
        if not isinstance(overrides, list):
            return 0
        try:
            result_selection.ClearOverriddenUltimates()
        except Exception:
            pass
        origin_length = int(self._optional_value(result_selection, "OriginLength", 12) or 12)
        origin_count = self._positive_int_member(result_selection, "OriginCount", 0)
        updates = 0
        for origin_index, raw_value in enumerate(overrides, start=1):
            if origin_index > origin_count:
                break
            value = self._number_or_none(raw_value)
            if value is None:
                continue
            result_selection.SetUltimates(origin_index, origin_length, value)
            updates += 1
        return updates

    def _result_selection_dataset_indexes(self, result_selection):
        out = {}
        dataset_count = int(self._optional_value(result_selection, "DatasetCount", 0) or 0)
        for dataset_index in range(1, dataset_count + 1):
            try:
                dataset = result_selection.Dataset(dataset_index)
                out.setdefault(self._label_key(self._optional_value(dataset, "Name", "")), dataset_index)
            except Exception:
                continue
        return out

    def _number_or_none(self, value):
        if value is None or value == "" or isinstance(value, bool):
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _number_or_zero(self, value):
        number = self._number_or_none(value)
        return 0.0 if number is None else number

    def _rs_json_number(self, value):
        number = self._number_or_none(value)
        if number is None or not math.isfinite(number):
            return None
        if isinstance(value, int):
            return value
        try:
            rounded = Decimal(str(abs(number))).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
        except InvalidOperation:
            return None
        result = float(rounded)
        return -result if number < 0 else result

    def _positive_int_member(self, obj, attr_name, default=0):
        try:
            value = getattr(obj, attr_name)
        except Exception:
            return default
        for candidate in (value,):
            try:
                number = int(candidate)
                return number if number > 0 else default
            except Exception:
                pass
        if callable(value):
            try:
                number = int(value())
                return number if number > 0 else default
            except Exception:
                pass
        return default

    def _excluded_ratio_pattern(self, dfm):
        rows = int(dfm.OriginCount)
        row_widths = [
            max(int(dfm.DevelopmentCount(origin_index)) - 1, 0)
            for origin_index in range(1, rows + 1)
        ]
        columns = max(row_widths, default=0)
        pattern = []
        for origin_index, ratio_count in enumerate(row_widths, start=1):
            row = []
            for development_index in range(1, columns + 1):
                if development_index <= ratio_count:
                    row.append(int(dfm.ExcludedRatios(origin_index, development_index)))
                else:
                    row.append(2)
            pattern.append(self._trim_trailing_mask_cells(row))
        return pattern

    def _sync_excluded_ratios(self, dfm, payload):
        ratio_triangle = self._dict_path(payload, ("ratios tab", "ratio triangle"))
        pattern = ratio_triangle.get("excluded") if isinstance(ratio_triangle, dict) else None
        if not isinstance(pattern, list):
            return 0

        origin_count = int(self._optional_value(dfm, "OriginCount", 0) or 0)
        updates = 0
        for origin_index, row in enumerate(pattern, start=1):
            if origin_index > origin_count or not isinstance(row, list):
                continue
            ratio_count = max(int(dfm.DevelopmentCount(origin_index)) - 1, 0)
            for development_index, raw_value in enumerate(row, start=1):
                if development_index > ratio_count:
                    break
                value = self._excluded_value(raw_value)
                if value is None:
                    continue
                dfm.SetExcludedRatios(OriginIndex=origin_index, DevIndex=development_index, arg2=value)
                updates += 1
        return updates

    def _excluded_value(self, value):
        if value in (0, False, "0", "false", "False"):
            return 0
        if value in (1, True, "1", "true", "True"):
            return 1
        return None

    def _sync_selected_ratios(self, dfm, payload):
        average_formulas = self._dict_path(payload, ("ratios tab", "average formulas"))
        labels = average_formulas.get("label") if isinstance(average_formulas, dict) else None
        selected = average_formulas.get("selected") if isinstance(average_formulas, dict) else None
        if not isinstance(labels, list) or not isinstance(selected, list):
            return 0

        label_to_display_index = self._average_formula_display_indexes(dfm)
        column_count = self._development_column_count(dfm)
        updates = 0
        for development_index in range(1, column_count + 1):
            selected_label = self._selected_label_for_column(labels, selected, development_index - 1)
            if not selected_label:
                continue
            display_index = label_to_display_index.get(selected_label)
            if display_index is None:
                continue
            dfm.SetSelectedRatios(DevIndex=development_index, arg1=display_index)
            updates += 1
        return updates

    def _sync_user_entry_values(self, dfm, payload):
        average_formulas = self._dict_path(payload, ("ratios tab", "average formulas"))
        labels = average_formulas.get("label") if isinstance(average_formulas, dict) else None
        values = average_formulas.get("values") if isinstance(average_formulas, dict) else None
        if not isinstance(labels, list) or not isinstance(values, list):
            return 0

        row_index = self._user_entry_payload_row_index(average_formulas, labels)
        if row_index is None or row_index >= len(values) or not isinstance(values[row_index], list):
            return 0

        avg_index = self._user_entry_resq_index(dfm)
        if avg_index is None:
            return 0

        column_count = self._development_column_count(dfm)
        updates = 0
        for development_index, raw_value in enumerate(values[row_index], start=1):
            if development_index > column_count:
                break
            value = self._positive_number(raw_value)
            if value is None:
                continue
            self._set_user_entry_average_ratio_value(dfm, development_index, avg_index, value)
            updates += 1
        return updates

    def _user_entry_payload_row_index(self, average_formulas, labels):
        settings = average_formulas.get("custom average formula settings")
        average_types = settings.get("averageType") if isinstance(settings, dict) else None
        if isinstance(average_types, list):
            for index, average_type in enumerate(average_types):
                if str(average_type or "").strip().lower() == "user_entry":
                    return index

        for index, label in enumerate(labels):
            normalized = self._clean_label(label).lower()
            if normalized == "user entry" or normalized.startswith("user entry "):
                return index
        return None

    def _user_entry_resq_index(self, dfm):
        for api_index in range(1, 50):
            try:
                raw_name = str(dfm.AverageFormula(api_index))
            except Exception:
                break
            display_index, name = self._parse_average_formula_name(raw_name, api_index)
            normalized = self._clean_label(name).lower()
            if normalized == "user entry" or normalized.startswith("user entry "):
                return display_index
        return None

    def _positive_number(self, value):
        if value is None or isinstance(value, bool):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if number <= 0:
            return None
        return number

    def _set_user_entry_average_ratio_value(self, dfm, development_index, avg_index, value):
        try:
            dfm.SetUserRatios(DevIndex=development_index, AvgIndex=avg_index, arg2=value)
        except Exception as exc:
            raise RuntimeError(f"Unable to update DFM User Entry value in ResQ with SetUserRatios: {exc}") from exc

    def _average_formula_display_indexes(self, dfm):
        out = {}
        for api_index in range(1, 50):
            try:
                raw_name = str(dfm.AverageFormula(api_index))
            except Exception:
                break
            display_index, name = self._parse_average_formula_name(raw_name, api_index)
            out.setdefault(name, display_index)
            if name == "User Entry":
                break
        return out

    def _selected_label_for_column(self, labels, selected, column_index):
        for row_index, row in enumerate(selected):
            if row_index >= len(labels) or not isinstance(row, list) or column_index >= len(row):
                continue
            if row[column_index] in (1, True, "1", "true", "True"):
                return str(labels[row_index])
        return ""

    def _sync_cell_notes(self, dfm, payload):
        cell_notes = self._dict_path(payload, ("ratios tab", "cell notes"))
        if not cell_notes:
            return False
        # ResQ exposes DFM CellNotes as a read-side formatted string. The current
        # bridge examples do not expose a safe per-cell note setter, so remote
        # write-back intentionally leaves cell notes unchanged.
        _ = dfm
        return "read-only"

    def _dict_path(self, payload, path):
        current = payload
        for key in path:
            if not isinstance(current, dict):
                return {}
            current = current.get(key)
        return current if isinstance(current, dict) else {}

    def _trim_trailing_mask_cells(self, row):
        out = list(row)
        while out and out[-1] == 2:
            out.pop()
        return out

    def _average_data(self, dfm):
        formula_rows = self._average_formula_rows(dfm)
        column_count = self._development_column_count(dfm)
        display_indexes = [row["display_index"] for row in formula_rows]
        selected_indexes = [
            self._selected_average_display_index(dfm, development_index, display_indexes)
            for development_index in range(1, column_count + 1)
        ]

        return {
            "label": [row["name"] for row in formula_rows],
            "custom average formula settings": {
                "averageType": [row["averageType"] for row in formula_rows],
                "base": [row["base"] for row in formula_rows],
                "periods": [row["periods"] for row in formula_rows],
                "exclude": [row["exclude"] for row in formula_rows],
            },
            "selected": [
                [1 if selected_index == row["display_index"] else 0 for selected_index in selected_indexes]
                for row in formula_rows
            ],
            "values": self._user_entry_average_formula_values(dfm, formula_rows, column_count),
        }

    def _cell_notes_data(self, dfm, origin_labels, ratio_development_labels, average_labels):
        lines = str(self._optional_value(dfm, "CellNotes", "") or "").splitlines()
        development_label_map = self._development_note_label_map(ratio_development_labels)
        origin_label_set = {self._label_key(label) for label in origin_labels}
        average_label_set = {self._label_key(label) for label in average_labels}
        out = {
            "ratio main table": {},
            "ratio summary table": {},
        }
        for line in lines:
            parsed = self._parse_cell_note_line(line)
            if not parsed:
                continue
            col_label = development_label_map.get(self._label_key(parsed["x_label"]), parsed["x_label"])
            row_label = parsed["y_label"]
            note = parsed["note"]
            if not col_label or not row_label or not note:
                continue
            row_key = self._label_key(row_label)
            table_key = "ratio summary table" if row_key in average_label_set and row_key not in origin_label_set else "ratio main table"
            out.setdefault(table_key, {}).setdefault(row_label, {})[col_label] = note
        return out

    def _parse_cell_note_line(self, line):
        text = str(line or "").strip()
        if not text:
            return None
        match = re.match(
            r'^\s*"(?P<tab>(?:[^"]|"")*)"\s*,\s*Cell\[(?P<x_label>.*?),\s*(?P<y_label>.*?)\]\s*,\s*"(?P<note>(?:[^"]|"")*)"',
            text,
        )
        if not match:
            return None
        return {
            "tab": self._unescape_resq_note_value(match.group("tab")),
            "x_label": self._clean_label(match.group("x_label")),
            "y_label": self._clean_label(match.group("y_label")),
            "note": self._unescape_resq_note_value(match.group("note")).strip(),
        }

    def _development_note_label_map(self, ratio_development_labels):
        out = {}
        for label in ratio_development_labels:
            display_label = self._clean_label(label)
            if not display_label:
                continue
            out[self._label_key(display_label)] = display_label
            without_index = re.sub(r"^\(\s*\d+\s*\)\s*", "", display_label).strip()
            if without_index:
                out.setdefault(self._label_key(without_index), display_label)
        return out

    def _unescape_resq_note_value(self, value):
        return str(value or "").replace('""', '"')

    def _clean_label(self, value):
        return re.sub(r"\s+", " ", str(value or "")).strip()

    def _label_key(self, value):
        return self._clean_label(value).lower()

    def _average_formula_rows(self, dfm):
        rows = []
        for api_index in range(1, 20):
            try:
                raw_name = str(dfm.AverageFormula(api_index))
            except Exception:
                break

            display_index, name = self._parse_average_formula_name(raw_name, api_index)
            row = {
                "api_index": api_index,
                "display_index": display_index,
                "name": name,
                "is_user_entry": name == "User Entry",
            }
            row.update(self._formula_metadata(name, row["is_user_entry"]))
            rows.append(row)
            if row["is_user_entry"]:
                break
        return rows

    def _parse_average_formula_name(self, raw_name, api_index):
        match = re.match(r"^\s*(\d+)\s*:\s*(.*?)\s*$", raw_name)
        if not match:
            return api_index - 1, raw_name.strip()
        return int(match.group(1)), match.group(2)

    def _selected_average_display_index(self, dfm, development_index, display_indexes):
        try:
            selected_index = int(dfm.SelectedRatios(development_index))
        except Exception:
            return None

        display_index_set = set(display_indexes)
        if selected_index in display_index_set:
            return selected_index
        if selected_index - 1 in display_index_set:
            return selected_index - 1
        return selected_index

    def _user_entry_average_formula_values(self, dfm, formula_rows, column_count):
        values = [[] for _ in formula_rows]
        for row_index, row in enumerate(formula_rows):
            if not row["is_user_entry"]:
                continue
            values[row_index] = [
                self._snapshot_value(self._average_ratio_value(dfm, development_index, row["api_index"]))
                for development_index in range(1, column_count + 1)
            ]
            break
        return values

    def _formula_metadata(self, name, is_user_entry):
        if is_user_entry:
            return {
                "averageType": "user_entry",
                "base": "simple",
                "periods": "all",
                "exclude": 0,
            }

        match = re.match(r"^(Simple|Volume) - (all|\d+)(?: Ex hi/lo)?$", name, re.IGNORECASE)
        if match:
            periods = match.group(2).lower()
            return {
                "averageType": "custom",
                "base": match.group(1).lower(),
                "periods": "all" if periods == "all" else int(periods),
                "exclude": 1 if "ex hi/lo" in name.lower() else 0,
            }

        return {
            "averageType": "custom",
            "base": self._formula_metadata_base(name),
            "periods": "all",
            "exclude": 0,
        }

    def _formula_metadata_base(self, name):
        base = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        return base or "custom"

    def _average_ratio_value(self, dfm, development_index, api_index):
        try:
            return self._json_value(dfm.AverageRatioValues(development_index, api_index))
        except Exception:
            return None

    def _labels(self, dfm):
        origin_count = int(self._optional_value(dfm, "OriginCount", 0) or 0)
        development_count = self._development_column_count(dfm)
        origin_labels = self._indexed_values(dfm, ("OriginLabel", "OriginLabels"), origin_count)
        development_labels = self._indexed_values(
            dfm,
            ("DevelopmentLabel", "DevelopmentLabels", "DevLabel", "DevLabels"),
            development_count,
        )
        return origin_labels, development_labels

    def _ratio_development_labels(self, data_development_labels):
        if len(data_development_labels) < 2:
            return data_development_labels

        parsed = [self._development_label_number(label) for label in data_development_labels]
        if any(value is None for value in parsed):
            return data_development_labels

        labels = [
            f"({index}) {parsed[index - 1]}-{parsed[index]}"
            for index in range(1, len(parsed))
        ]
        labels.append(f"{parsed[-1]} - Ult")
        return labels

    def _development_label_number(self, label):
        if isinstance(label, (int, float)) and not isinstance(label, bool):
            return int(label)
        match = re.match(r"^\s*(\d+)", str(label))
        if not match:
            return None
        return int(match.group(1))

    def _indexed_values(self, obj, attr_names, count):
        for attr_name in attr_names:
            values = []
            for index in range(1, count + 1):
                try:
                    attr = getattr(obj, attr_name)
                    value = attr(index) if callable(attr) else attr[index - 1]
                    values.append(self._clean_label(value))
                except Exception:
                    values = []
                    break
            if values:
                return values
        return []

    def _development_column_count(self, dfm):
        rows = int(dfm.OriginCount)
        if rows <= 0:
            return 0
        return max(int(dfm.DevelopmentCount(origin_index)) for origin_index in range(1, rows + 1))

    def _optional_value(self, obj, attr_name, default):
        try:
            value = getattr(obj, attr_name)
            if callable(value):
                value = value()
            return value
        except Exception:
            return default

    def _nested_name(self, obj, attr_name):
        try:
            value = getattr(obj, attr_name)
            return self._clean_label(value.Name)
        except Exception:
            return ""

    def _nested_value(self, obj, attr_name, nested_attr_name, default):
        try:
            value = getattr(obj, attr_name)
            nested_value = getattr(value, nested_attr_name)
            if callable(nested_value):
                nested_value = nested_value()
            return nested_value
        except Exception:
            return default

    def _dfm_last_modified(self, dfm):
        try:
            modified = dfm.OutputVector.Modified
        except Exception:
            return ""
        if hasattr(modified, "replace") and hasattr(modified, "isoformat"):
            try:
                return modified.replace(tzinfo=None).isoformat()
            except Exception:
                pass
        normalized = self._json_value(modified)
        if self._has_json_value(normalized):
            return normalized
        return ""

    def _result_selection_last_modified(self, result_selection):
        try:
            modified = result_selection.OutputVector.Modified
        except Exception:
            return ""
        if hasattr(modified, "replace") and hasattr(modified, "isoformat"):
            try:
                return modified.replace(tzinfo=None).isoformat()
            except Exception:
                pass
        normalized = self._json_value(modified)
        if self._has_json_value(normalized):
            return normalized
        return ""

    def _has_json_value(self, value):
        if value is None or isinstance(value, bool):
            return False
        if isinstance(value, str):
            return bool(value.strip())
        if isinstance(value, (int, float)):
            return value > 0
        return True

    def _json_value(self, value):
        if hasattr(value, "isoformat"):
            return value.isoformat()
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        try:
            return float(value)
        except Exception:
            pass
        return str(value)

    def _snapshot_value(self, value):
        value = self._json_value(value)
        if isinstance(value, bool) or value is None:
            return value
        if isinstance(value, (int, float)):
            return round(value, 4)
        return value
