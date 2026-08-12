import assert from "node:assert/strict";
import test from "node:test";

import {
  filterCategoryOptions,
  isNewCategoryValue,
  normalizeCategoryOptions,
} from "../ui/project_settings/project_settings_dataset_type_category_combo.js";

test("category options are trimmed, case-insensitively deduplicated, and sorted", () => {
  assert.deepEqual(
    normalizeCategoryOptions([" Paid ", "incurred", "PAID", "", null, "Claim Count"]),
    ["Claim Count", "incurred", "Paid"],
  );
});

test("category filtering is case-insensitive and keeps typed new values distinct", () => {
  const options = ["Claim Count", "Incurred Loss", "Paid Loss"];
  assert.deepEqual(filterCategoryOptions(options, "loss"), ["Incurred Loss", "Paid Loss"]);
  assert.equal(isNewCategoryValue("paid loss", options), false);
  assert.equal(isNewCategoryValue("Expense", options), true);
  assert.equal(isNewCategoryValue("   ", options), false);
});
