// `methodType` is the persisted routing identity shared with sidecars,
// `index.json`, method JSON, and the ResQ migration, so it must not drift.
// `displayLabel` is the ResQ wording every user-visible surface shows instead.
const CONTRACTS = Object.freeze({
  sr: Object.freeze({
    variant: "sr",
    methodType: "B&S Settlement Rate Adjustment",
    displayLabel: "Berquist Sherman SR",
    sourceKind: "berquist_sherman_sr",
    filenamePrefix: "BSSR@",
    jsonFormat: "arcrho-berquist-sherman-sr-method-by-tab-v1",
  }),
  cra: Object.freeze({
    variant: "cra",
    methodType: "B&S Case Reserve Adequacy Adjustment",
    displayLabel: "Berquist Sherman CRA",
    sourceKind: "berquist_sherman_cra",
    filenamePrefix: "BSCRA@",
    jsonFormat: "arcrho-berquist-sherman-cra-method-by-tab-v1",
  }),
});

export const BERQUIST_SHERMAN_VARIANTS = Object.freeze(Object.keys(CONTRACTS));

const VARIANT_BY_ALIAS = new Map(
  Object.values(CONTRACTS).flatMap((contract) => [
    [contract.variant, contract.variant],
    [contract.methodType.toLowerCase(), contract.variant],
    [contract.displayLabel.toLowerCase(), contract.variant],
    [contract.sourceKind, contract.variant],
    [contract.filenamePrefix.slice(0, -1).toLowerCase(), contract.variant],
    [contract.jsonFormat, contract.variant],
  ])
);

// Any surface that shows a method type resolves it here, so a B&S identity from
// a sidecar, index, or window dataset renders as its ResQ label.
export function berquistShermanDisplayLabel(methodType) {
  return getBerquistShermanContract(methodType)?.displayLabel || String(methodType ?? "");
}

export function normalizeBerquistShermanVariant(value) {
  return VARIANT_BY_ALIAS.get(String(value || "").trim().toLowerCase()) || "";
}

export function getBerquistShermanContract(variant) {
  return CONTRACTS[normalizeBerquistShermanVariant(variant)] || null;
}
