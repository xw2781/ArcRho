/*
===============================================================================
DFM clean-state key - the text that decides whether the window still holds
what was last loaded or saved. It is projected from the payload Save sends,
keeping only what a user can edit in the window. A leaf module so the rule
can be tested without the page.
===============================================================================
*/

// Values the window derives from the source data or holds from the last save
// take no part: the input triangle, ratio values, average values, the ultimate
// vector, the ratio-basis column, revisions, and timestamps. A ratio edit swaps
// the stored ultimate vector for a locally recomputed one, and an async load can
// settle the rest after the baseline was recorded, so any of them would keep a
// reverted window dirty. What is left is exactly the set of user choices.
export function buildDfmCleanStateKey(methodPayload, notesText = "") {
  const payload = methodPayload && typeof methodPayload === "object" ? methodPayload : {};
  const ratiosTab = plainObject(payload["ratios_tab"]);
  const averageFormulas = plainObject(ratiosTab["average_formulas"]);
  const resultsTab = plainObject(payload["results_tab"]);
  const owned = {
    "details_tab": plainObject(payload["details_tab"]),
    "ratios_tab": {
      excluded: plainObject(ratiosTab["ratio_triangle"]).excluded ?? [],
      "average_formulas": { ...averageFormulas, values: userEntryValues(averageFormulas) },
      "cell_notes": ratiosTab["cell_notes"] ?? null,
    },
    "curves_tab": payload["curves_tab"] ?? null,
    "results_tab": {
      "ratio_basis_dataset": resultsTab["ratio_basis_dataset"] ?? "",
      "ultimate_ratio_decimal_places": resultsTab["ultimate_ratio_decimal_places"] ?? null,
    },
  };
  return `${JSON.stringify(owned)}\n${String(notesText ?? "")}`;
}

// The `values` rows mix computed averages with the numbers a User Entry row
// holds and the frozen values of a benchmark row; only those rows are kept.
function userEntryValues(averageFormulas) {
  const settings = plainObject(averageFormulas["custom_average_formula_settings"]);
  const types = Array.isArray(settings.average_type) ? settings.average_type : [];
  const bases = Array.isArray(settings.base) ? settings.base : [];
  const values = Array.isArray(averageFormulas.values) ? averageFormulas.values : [];
  return values.map((row, index) => {
    const type = String(types[index] ?? "").trim().toLowerCase();
    const base = String(bases[index] ?? "").trim().toLowerCase();
    return type === "user_entry" || base === "benchmark" ? row : null;
  });
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
