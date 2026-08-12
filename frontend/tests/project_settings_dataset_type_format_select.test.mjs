import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedFormatValue,
  readFormatOptions,
} from "../ui/project_settings/project_settings_dataset_type_format_select.js";

const selectStub = () => ({
  options: [
    { value: "", textContent: "Select data format", disabled: true },
    { value: "Triangle", textContent: "Triangle", disabled: false },
    { value: "Vector", textContent: "Vector", disabled: false },
  ],
});

test("the native select owns the option list and the placeholder text", () => {
  const { options, placeholder } = readFormatOptions(selectStub());
  assert.equal(placeholder, "Select data format");
  assert.deepEqual(options, [
    { value: "Triangle", label: "Triangle" },
    { value: "Vector", label: "Vector" },
  ]);
});

test("a missing select yields no options rather than throwing", () => {
  assert.deepEqual(readFormatOptions(null), { placeholder: "", options: [] });
});

test("only the enabled option values are accepted", () => {
  const { options } = readFormatOptions(selectStub());
  assert.equal(isAllowedFormatValue("Triangle", options), true);
  assert.equal(isAllowedFormatValue(" Vector ", options), true);
  assert.equal(isAllowedFormatValue("", options), false);
  assert.equal(isAllowedFormatValue("Select data format", options), false);
  assert.equal(isAllowedFormatValue("triangle", options), false);
});
