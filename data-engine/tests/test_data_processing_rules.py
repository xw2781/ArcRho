from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd
from pandas.testing import assert_frame_equal, assert_series_equal


ENGINE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

from arcrho_engine.data_processing_rules import (  # noqa: E402
    CompiledCondition,
    DataProcessingRulesError,
    ReservingClassConfigurationError,
    build_base_row_weights,
    build_configuration_file_signature,
    build_reserving_class_catalog,
    build_weighted_source_frame,
    compile_data_processing_rules,
    evaluate_row_conditions,
    request_conditions_match,
    resolve_request_path,
)


def _field_mapping():
    return {
        "rows": [
            {
                "field_name": "IBNRCAT",
                "significance": "Reserving Class",
                "level": 5,
            },
            {
                "field_name": "Earned_Exposure",
                "significance": "Dataset",
                "level": None,
            },
            {
                "field_name": "STATE_CD",
                "significance": "Reserving Class",
                "level": 3,
            },
            {
                "field_name": "Remaining_Budget_Exposure",
                "significance": "Dataset",
                "level": None,
            },
            {
                "field_name": "Earned_Premium",
                "significance": "Dataset",
                "level": None,
            },
            {
                "field_name": "acc_yrmo",
                "significance": "Origin Date",
                "level": None,
            },
            {
                "field_name": "sys_yrmo",
                "significance": "Development Date",
                "level": None,
            },
        ]
    }


def _reserving_class_types(extra_rows=None):
    rows = [
        ["NJ", "3", "", '"NJ"'],
        ["NY", "3", "", '"NY"'],
        ["Shared", "3", "", '"Shared"'],
        ["All States", "3", "NJ + NY", '"NJ" + "NY"'],
        ["Net States", "3", "NJ - NY", '"NJ" - "NY"'],
        ["BI", "5", "", '"BI"'],
        ["UMBI", "5", "", '"UMBI"'],
        ["BIR51", "5", "", '"BIR51"'],
        ["UMBIR51", "5", "", '"UMBIR51"'],
        ["PD", "5", "", '"PD"'],
        ["UMPD", "5", "", '"UMPD"'],
        ["CMP", "5", "", '"CMP"'],
        ["CMP_CAT", "5", "", '"CMP_CAT"'],
        ["COL", "5", "", '"COL"'],
        ["Shared", "5", "", '"Shared"'],
        [
            "BI Total",
            "5",
            "BI + UMBI + BIR51 + UMBIR51",
            '"BI" + "UMBI" + "BIR51" + "UMBIR51"',
        ],
        [
            "TOTAL PA",
            "5",
            "BI + UMBI + BIR51 + UMBIR51 + PD + UMPD + CMP - CMP_CAT + COL",
            (
                '"BI" + "UMBI" + "BIR51" + "UMBIR51" + "PD" + '
                '"UMPD" + "CMP" - "CMP_CAT" + "COL"'
            ),
        ],
    ]
    rows.extend(extra_rows or [])
    return {
        "columns": ["Name", "Level", "Formula", "Source"],
        "rows": rows,
    }


def _dataset_types():
    return {
        "columns": ["Name", "Data Format", "Source"],
        "rows": [
            ["Earned Exposure", "Vector", "Earned_Exposure"],
            [
                "Total Earned Exposure",
                "Vector",
                "Earned_Exposure + Remaining_Budget_Exposure",
            ],
            ["Earned Premium", "Vector", "Earned_Premium"],
        ],
    }


def _condition(field, level, value):
    return {
        "field": field,
        "level": level,
        "operator": "equals",
        "value": value,
    }


def _rule(
    rule_id,
    source_measure,
    action_type,
    members,
    *,
    request_type="TOTAL PA",
    row_conditions=None,
    enabled=True,
):
    return {
        "id": rule_id,
        "name": rule_id.replace("-", " ").title(),
        "enabled": enabled,
        "target": {"source_measure": source_measure},
        "request_conditions": {
            "all": [_condition("IBNRCAT", 5, request_type)]
        },
        "row_conditions": {"all": list(row_conditions or [])},
        "action": {
            "type": action_type,
            "field": "IBNRCAT",
            "level": 5,
            "members": list(members),
        },
    }


def _rules_payload(rules):
    return {
        "json_format": "arcrho-data-processing-rules-v1",
        "revision": 1,
        "rules": list(rules),
    }


def _source_rows():
    rows = []
    categories = [
        "BI",
        "UMBI",
        "BIR51",
        "UMBIR51",
        "PD",
        "UMPD",
        "CMP",
        "CMP_CAT",
        "COL",
    ]
    for state in ("NJ", "NY"):
        for category in categories:
            rows.append(
                {
                    "STATE_CD": state,
                    "IBNRCAT": category,
                    "acc_yrmo": 202001,
                    "sys_yrmo": 202012,
                    "Earned_Premium": 10.0,
                    "Earned_Exposure": 1.0,
                    "Remaining_Budget_Exposure": 2.0,
                }
            )
    return pd.DataFrame(rows)


class ReservingClassCompilerTests(unittest.TestCase):
    def test_configuration_signature_detects_optional_file_creation_change_and_deletion(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root = Path(tmp)
            paths = {
                "field_mapping": root / "field_mapping.json",
                "dataset_types": root / "dataset_types.json",
                "reserving_class_types": root / "reserving_class_types.json",
                "data_processing_rules": root / "data_processing_rules.json",
            }
            for key in ("field_mapping", "dataset_types", "reserving_class_types"):
                paths[key].write_text("{}", encoding="utf-8")

            required = {"field_mapping", "dataset_types", "reserving_class_types"}
            missing_rules_signature = build_configuration_file_signature(
                paths,
                required_keys=required,
            )
            paths["data_processing_rules"].write_text(
                '{"revision":1}',
                encoding="utf-8",
            )
            revision_one_signature = build_configuration_file_signature(
                paths,
                required_keys=required,
            )
            paths["data_processing_rules"].write_text(
                '{"revision":2}',
                encoding="utf-8",
            )
            revision_two_signature = build_configuration_file_signature(
                paths,
                required_keys=required,
            )
            paths["data_processing_rules"].unlink()
            deleted_rules_signature = build_configuration_file_signature(
                paths,
                required_keys=required,
            )

            self.assertNotEqual(missing_rules_signature, revision_one_signature)
            self.assertNotEqual(revision_one_signature, revision_two_signature)
            self.assertEqual(missing_rules_signature, deleted_rules_signature)

    def test_compiles_nested_subtraction_and_quoted_operator_names(self):
        payload = _reserving_class_types(
            extra_rows=[
                ["A", "5", "", '"A"'],
                ["B", "5", "", '"B"'],
                ["C", "5", "", '"C"'],
                ["A-B", "5", "", '"A-B"'],
                [
                    "Nested",
                    "5",
                    'A - (B - C) + "A-B"',
                    '"A" - ("B" - "C") + "A-B"',
                ],
            ]
        )
        catalog = build_reserving_class_catalog(_field_mapping(), payload)

        self.assertEqual(
            catalog.coefficients_for("IBNRCAT", 5, "Nested"),
            {"A": 1, "B": -1, "C": 1, "A-B": 1},
        )

    def test_sorts_fields_and_qualifies_duplicate_names_by_field_and_level(self):
        catalog = build_reserving_class_catalog(
            _field_mapping(),
            _reserving_class_types(),
        )

        self.assertEqual(
            [(item.field, item.level) for item in catalog.fields],
            [("STATE_CD", 3), ("IBNRCAT", 5)],
        )
        self.assertEqual(
            catalog.coefficients_for("STATE_CD", 3, "Shared"),
            {"Shared": 1},
        )
        self.assertEqual(
            catalog.coefficients_for("IBNRCAT", 5, "Shared"),
            {"Shared": 1},
        )

    def test_multiplies_signed_coefficients_across_selected_fields(self):
        catalog = build_reserving_class_catalog(
            _field_mapping(),
            _reserving_class_types(),
        )
        _, coefficients = resolve_request_path(
            catalog,
            ["Net States", "TOTAL PA"],
        )
        rows = pd.DataFrame(
            [
                {"STATE_CD": "NJ", "IBNRCAT": "CMP_CAT"},
                {"STATE_CD": "NY", "IBNRCAT": "CMP_CAT"},
                {"STATE_CD": "NJ", "IBNRCAT": "PD"},
                {"STATE_CD": "NY", "IBNRCAT": "PD"},
            ]
        )

        actual = build_base_row_weights(rows, coefficients)
        expected = pd.Series([-1, 1, 1, -1], dtype="int64")
        assert_series_equal(actual.reset_index(drop=True), expected)

    def test_membership_matches_aggregate_and_intermediate_stored_labels(self):
        # Some source measures (e.g. remaining-budget exposure) are stored at an
        # aggregate reserving-class label rather than decomposed to atomic members.
        # Row matching must accept the type's own name and intermediate composite
        # labels (from the Formula tree), not just the atomic Source leaves.
        catalog = build_reserving_class_catalog(
            _field_mapping(),
            _reserving_class_types(
                extra_rows=[
                    [
                        "Auto Roll",
                        "5",
                        '"BI Total" + PD',
                        '"BI" + "UMBI" + "BIR51" + "UMBIR51" + "PD"',
                    ],
                ]
            ),
        )

        membership = catalog.membership_coefficients_for("IBNRCAT", 5, "Auto Roll")
        # self name, intermediate composite label, and atomic leaves all present.
        self.assertEqual(membership["Auto Roll"], 1)
        self.assertEqual(membership["BI Total"], 1)
        self.assertEqual(membership["BI"], 1)
        self.assertEqual(membership["PD"], 1)
        # The atomic resolver stays strict (no self / intermediate names).
        atomic = catalog.coefficients_for("IBNRCAT", 5, "Auto Roll")
        self.assertNotIn("Auto Roll", atomic)
        self.assertNotIn("BI Total", atomic)

        rows = pd.DataFrame(
            [
                {"IBNRCAT": "Auto Roll"},  # stored at the selected aggregate label
                {"IBNRCAT": "BI Total"},   # stored at an intermediate label
                {"IBNRCAT": "BI"},         # stored atomically
                {"IBNRCAT": "COL"},        # unrelated member
            ]
        )
        assert_series_equal(
            build_base_row_weights(rows, {"IBNRCAT": membership}).reset_index(drop=True),
            pd.Series([1, 1, 1, 0], dtype="int64"),
        )
        # With atomic-only coefficients the aggregate/intermediate rows are missed.
        assert_series_equal(
            build_base_row_weights(rows, {"IBNRCAT": atomic}).reset_index(drop=True),
            pd.Series([0, 0, 1, 0], dtype="int64"),
        )

    def test_matches_numeric_raw_members_to_string_configuration_names(self):
        rows = pd.DataFrame({"NUMERIC_CLASS": [1, 2, 3]})

        actual = build_base_row_weights(
            rows,
            {"NUMERIC_CLASS": {"1": 1, "2": -1}},
        )

        expected = pd.Series([1, -1, 0], dtype="int64")
        assert_series_equal(actual.reset_index(drop=True), expected)

    def test_rejects_unsupported_and_unknown_source_components(self):
        with self.assertRaisesRegex(
            ReservingClassConfigurationError,
            "Unsupported operator",
        ):
            build_reserving_class_catalog(
                _field_mapping(),
                _reserving_class_types(
                    extra_rows=[
                        ["A", "5", "", '"A"'],
                        ["B", "5", "", '"B"'],
                        ["Bad", "5", "A * B", '"A" * "B"'],
                    ]
                ),
            )

        with self.assertRaisesRegex(
            ReservingClassConfigurationError,
            "unknown member",
        ):
            build_reserving_class_catalog(
                _field_mapping(),
                _reserving_class_types(
                    extra_rows=[
                        ["Bad", "5", "Missing", '"Missing"'],
                    ]
                ),
            )


class DataProcessingRuleTests(unittest.TestCase):
    def setUp(self):
        self.catalog = build_reserving_class_catalog(
            _field_mapping(),
            _reserving_class_types(),
        )

    def _compile(self, rules):
        return compile_data_processing_rules(
            _rules_payload(rules),
            catalog=self.catalog,
            field_mapping_payload=_field_mapping(),
            dataset_types_payload=_dataset_types(),
            source_columns=_source_rows().columns,
        )

    def test_applies_independent_measure_masks_and_raw_nj_condition(self):
        rules = self._compile(
            [
                _rule(
                    "earned-exposure-total-pa",
                    "Earned_Exposure",
                    "keep_members",
                    ["PD"],
                ),
                _rule(
                    "remaining-exposure-total-pa",
                    "Remaining_Budget_Exposure",
                    "keep_members",
                    ["PD", "UMPD"],
                ),
                _rule(
                    "earned-premium-nj-total-pa",
                    "Earned_Premium",
                    "exclude_members",
                    ["BI", "UMBI"],
                    row_conditions=[
                        {
                            "field": "STATE_CD",
                            "operator": "equals",
                            "value": "NJ",
                        }
                    ],
                ),
            ]
        )
        request_context, coefficients = resolve_request_path(
            self.catalog,
            ["All States", "TOTAL PA"],
        )
        source = _source_rows()
        original = source.copy(deep=True)

        actual = build_weighted_source_frame(
            source,
            passthrough_columns=["acc_yrmo", "sys_yrmo"],
            source_measures=[
                "Earned_Premium",
                "Earned_Exposure",
                "Remaining_Budget_Exposure",
            ],
            selected_coefficients=coefficients,
            request_context=request_context,
            rules=rules.rules,
        )

        assert_frame_equal(source, original)
        keyed = actual.assign(
            STATE_CD=source.loc[actual.index, "STATE_CD"],
            IBNRCAT=source.loc[actual.index, "IBNRCAT"],
        ).set_index(["STATE_CD", "IBNRCAT"])
        self.assertEqual(keyed.loc[("NJ", "BI"), "Earned_Premium"], 0)
        self.assertEqual(keyed.loc[("NY", "BI"), "Earned_Premium"], 10)
        self.assertEqual(keyed.loc[("NJ", "CMP_CAT"), "Earned_Premium"], -10)
        self.assertEqual(keyed.loc[("NY", "CMP_CAT"), "Earned_Premium"], -10)
        self.assertEqual(keyed.loc[("NJ", "PD"), "Earned_Exposure"], 1)
        self.assertEqual(keyed.loc[("NJ", "UMPD"), "Earned_Exposure"], 0)
        self.assertEqual(
            keyed.loc[("NJ", "PD"), "Remaining_Budget_Exposure"],
            2,
        )
        self.assertEqual(
            keyed.loc[("NJ", "UMPD"), "Remaining_Budget_Exposure"],
            2,
        )
        self.assertEqual(
            keyed.loc[("NJ", "CMP_CAT"), "Remaining_Budget_Exposure"],
            0,
        )

    def test_multiple_rules_intersect_without_file_order_behavior(self):
        keep_rule = _rule(
            "keep-pd-umpd",
            "Earned_Exposure",
            "keep_members",
            ["PD", "UMPD"],
        )
        exclude_rule = _rule(
            "exclude-umpd",
            "Earned_Exposure",
            "exclude_members",
            ["UMPD"],
        )
        context, coefficients = resolve_request_path(
            self.catalog,
            ["All States", "TOTAL PA"],
        )

        outputs = []
        for rule_order in ([keep_rule, exclude_rule], [exclude_rule, keep_rule]):
            compiled = self._compile(rule_order)
            outputs.append(
                build_weighted_source_frame(
                    _source_rows(),
                    passthrough_columns=["acc_yrmo", "sys_yrmo"],
                    source_measures=["Earned_Exposure"],
                    selected_coefficients=coefficients,
                    request_context=context,
                    rules=compiled.rules,
                )
            )

        assert_frame_equal(outputs[0], outputs[1])
        categories = _source_rows().loc[outputs[0].index, "IBNRCAT"]
        kept = outputs[0].loc[outputs[0]["Earned_Exposure"].ne(0)]
        self.assertEqual(
            set(categories.loc[kept.index]),
            {"PD"},
        )

    def test_partial_path_does_not_match_absent_request_level(self):
        compiled = self._compile(
            [
                _rule(
                    "total-pa-only",
                    "Earned_Premium",
                    "exclude_members",
                    ["BI"],
                )
            ]
        )
        context, coefficients = resolve_request_path(
            self.catalog,
            ["All States"],
        )
        source = _source_rows()

        actual = build_weighted_source_frame(
            source,
            passthrough_columns=["acc_yrmo", "sys_yrmo"],
            source_measures=["Earned_Premium"],
            selected_coefficients=coefficients,
            request_context=context,
            rules=compiled.rules,
        )

        self.assertTrue(actual["Earned_Premium"].eq(10).all())

    def test_request_conditions_match_negative_scalar_and_list_operators(self):
        raw_rule = _rule(
            "outside-total-pa",
            "Earned_Premium",
            "exclude_members",
            ["BI"],
        )
        condition = raw_rule["request_conditions"]["all"][0]

        for operator, value in (
            ("not_equals", "TOTAL PA"),
            ("not_in", ["TOTAL PA", "BI Total"]),
        ):
            condition.update({"operator": operator, "value": value})
            compiled = self._compile([raw_rule]).rules[0]
            with self.subTest(operator=operator):
                self.assertFalse(
                    request_conditions_match(
                        compiled.request_conditions,
                        {("IBNRCAT", 5): "TOTAL PA"},
                    )
                )
                self.assertTrue(
                    request_conditions_match(
                        compiled.request_conditions,
                        {("IBNRCAT", 5): "PD"},
                    )
                )

    def test_disabled_rule_preserves_normal_signed_membership(self):
        compiled = self._compile(
            [
                _rule(
                    "disabled-keep",
                    "Earned_Exposure",
                    "keep_members",
                    ["PD"],
                    enabled=False,
                )
            ]
        )
        context, coefficients = resolve_request_path(
            self.catalog,
            ["All States", "TOTAL PA"],
        )
        source = _source_rows()

        actual = build_weighted_source_frame(
            source,
            passthrough_columns=["acc_yrmo", "sys_yrmo"],
            source_measures=["Earned_Exposure"],
            selected_coefficients=coefficients,
            request_context=context,
            rules=compiled.rules,
        )

        keyed = actual.assign(
            STATE_CD=source.loc[actual.index, "STATE_CD"],
            IBNRCAT=source.loc[actual.index, "IBNRCAT"],
        ).set_index(["STATE_CD", "IBNRCAT"])
        self.assertEqual(keyed.loc[("NJ", "BI"), "Earned_Exposure"], 1)
        self.assertEqual(keyed.loc[("NJ", "CMP_CAT"), "Earned_Exposure"], -1)

    def test_missing_rules_is_empty_and_invalid_contracts_raise(self):
        empty = compile_data_processing_rules(
            None,
            catalog=self.catalog,
            field_mapping_payload=_field_mapping(),
            dataset_types_payload=_dataset_types(),
            source_columns=_source_rows().columns,
        )
        self.assertEqual(empty.revision, 0)
        self.assertEqual(empty.rules, ())

        with self.assertRaisesRegex(DataProcessingRulesError, "json_format"):
            compile_data_processing_rules(
                {"json_format": "future", "revision": 1, "rules": []},
                catalog=self.catalog,
                field_mapping_payload=_field_mapping(),
                dataset_types_payload=_dataset_types(),
                source_columns=_source_rows().columns,
            )

        duplicate = _rule(
            "duplicate-id",
            "Earned_Exposure",
            "keep_members",
            ["PD"],
        )
        with self.assertRaisesRegex(DataProcessingRulesError, "Duplicate rule id"):
            self._compile([duplicate, dict(duplicate)])

        invalid_field_rule = _rule(
            "unknown-row-field",
            "Earned_Exposure",
            "keep_members",
            ["PD"],
            row_conditions=[
                {
                    "field": "MISSING_FIELD",
                    "operator": "equals",
                    "value": "x",
                }
            ],
        )
        with self.assertRaisesRegex(DataProcessingRulesError, "does not exist"):
            self._compile([invalid_field_rule])

    def test_rejects_unknown_contract_fields(self):
        valid_rule = _rule(
            "strict-contract",
            "Earned_Exposure",
            "keep_members",
            ["PD"],
            row_conditions=[
                {
                    "field": "STATE_CD",
                    "operator": "equals",
                    "value": "NJ",
                }
            ],
        )

        top_level = _rules_payload([valid_rule])
        top_level["unexpected"] = True
        with self.assertRaisesRegex(DataProcessingRulesError, "unsupported field"):
            compile_data_processing_rules(
                top_level,
                catalog=self.catalog,
                field_mapping_payload=_field_mapping(),
                dataset_types_payload=_dataset_types(),
                source_columns=_source_rows().columns,
            )

        for section in ("rule", "condition", "action"):
            payload_rule = copy.deepcopy(valid_rule)
            if section == "rule":
                payload_rule["unexpected"] = True
            elif section == "condition":
                payload_rule["row_conditions"]["all"][0]["unexpected"] = True
            else:
                payload_rule["action"]["unexpected"] = True
            with self.subTest(section=section):
                with self.assertRaisesRegex(
                    DataProcessingRulesError,
                    "unsupported field",
                ):
                    self._compile([payload_rule])

    def test_keep_members_cannot_add_a_base_excluded_member(self):
        compiled = self._compile(
            [
                _rule(
                    "invalid-keep",
                    "Earned_Exposure",
                    "keep_members",
                    ["PD"],
                    request_type="BI Total",
                )
            ]
        )
        context, coefficients = resolve_request_path(
            self.catalog,
            ["All States", "BI Total"],
        )

        with self.assertRaisesRegex(
            DataProcessingRulesError,
            "cannot add members excluded",
        ):
            build_weighted_source_frame(
                _source_rows(),
                passthrough_columns=["acc_yrmo", "sys_yrmo"],
                source_measures=["Earned_Exposure"],
                selected_coefficients=coefficients,
                request_context=context,
                rules=compiled.rules,
            )

    def test_row_conditions_are_vectorized_and_blanks_do_not_match_negation(self):
        rows = pd.DataFrame(
            {
                "STATE_CD": ["NJ", "NY", None],
                "AMOUNT": [10, 20, None],
                "NOTE": ["", "ready", None],
            }
        )

        actual = evaluate_row_conditions(
            rows,
            [
                CompiledCondition(
                    field="STATE_CD",
                    operator="not_in",
                    value=("CT",),
                ),
                CompiledCondition(
                    field="AMOUNT",
                    operator="greater_than_or_equal",
                    value=15,
                ),
                CompiledCondition(
                    field="NOTE",
                    operator="is_not_blank",
                ),
            ],
        )

        expected = pd.Series([False, True, False], dtype=bool)
        assert_series_equal(actual.reset_index(drop=True), expected)


if __name__ == "__main__":
    unittest.main()
