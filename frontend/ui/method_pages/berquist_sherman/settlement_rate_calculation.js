import {
  assertSameTriangleShape,
  columnCount,
  latestByColumn,
  loessFit,
  matrixLike,
  normalizeLoessSpan,
  normalizeTriangle,
} from "./calculation_helpers.js";

const ADJUSTMENT_TYPES = new Set(["unadjusted", "pairs", "all", "loess"]);

function normalizeNumberVector(value, count, name) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: count }, (_, index) => {
    const entry = source[index];
    if (entry === null || entry === undefined || entry === "") return null;
    const number = Number(entry);
    if (!Number.isFinite(number)) {
      throw new TypeError(`${name}[${index}] must be numeric or blank.`);
    }
    return number;
  });
}

function rowPoints(closedClaimNumbers, paidClaims) {
  const points = [];
  paidClaims.forEach((paid, index) => {
    const closed = closedClaimNumbers[index];
    if (Number.isFinite(closed) && Number.isFinite(paid) && paid > 0) {
      points.push({ x: closed, y: Math.log(paid) });
    }
  });
  return points;
}

function pairwiseEstimate(points, selectedClosedClaims) {
  if (!Number.isFinite(selectedClosedClaims)) return null;
  if (points.length < 2) return 0;

  let pairIndex = selectedClosedClaims < points[0].x ? 0 : points.length - 2;
  for (let index = 0; index < points.length - 1; index += 1) {
    if (
      points[index].x <= selectedClosedClaims
      && selectedClosedClaims <= points[index + 1].x
    ) {
      pairIndex = index;
    }
  }

  const lower = points[pairIndex];
  const upper = points[pairIndex + 1];
  if (lower.x === upper.x) {
    return Math.exp((lower.y + upper.y) / 2);
  }
  const weight = (selectedClosedClaims - lower.x) / (upper.x - lower.x);
  return Math.exp(lower.y + weight * (upper.y - lower.y));
}

function allPointsEstimate(points, selectedClosedClaims) {
  if (!Number.isFinite(selectedClosedClaims) || points.length < 2) return 0;
  const count = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
  const sumXY = points.reduce(
    (sum, point) => sum + point.x * point.y,
    0,
  );
  const denominator = count * sumXX - sumX * sumX;
  if (!denominator) return 0;
  const slope = (count * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / count;
  return Math.exp(intercept + slope * selectedClosedClaims);
}

function loessEstimate(points, selectedClosedClaims, span) {
  const fitted = loessFit(points, selectedClosedClaims, span);
  return fitted === null ? null : Math.exp(fitted);
}

function defaultAdjustmentForRow(points) {
  return points.length < 2 ? "unadjusted" : "pairs";
}

function selectedAdjustmentAt(selection, rowIndex, columnIndex, fallback) {
  const raw = selection?.[rowIndex]?.[columnIndex];
  const value = raw === null || raw === undefined || raw === ""
    ? fallback
    : String(raw).trim().toLowerCase();
  if (!ADJUSTMENT_TYPES.has(value)) {
    throw new RangeError(`Unsupported settlement-rate adjustment: ${raw}`);
  }
  return value;
}

export function calculateSettlementRate(input = {}) {
  const paidClaims = normalizeTriangle(input.paidClaims, "paidClaims");
  const closedClaimNumbers = normalizeTriangle(
    input.closedClaimNumbers,
    "closedClaimNumbers",
  );
  assertSameTriangleShape(paidClaims, closedClaimNumbers, "closedClaimNumbers");

  const rowCount = paidClaims.length;
  const developmentCount = columnCount(paidClaims);
  const ultimateClaimNumbers = normalizeNumberVector(
    input.ultimateClaimNumbers,
    rowCount,
    "ultimateClaimNumbers",
  );
  if (ultimateClaimNumbers.some((value) => !Number.isFinite(value))) {
    throw new RangeError("ultimateClaimNumbers must contain one value per origin period.");
  }

  const proportionSettled = matrixLike(paidClaims, (rowIndex, columnIndex) => {
    const closed = closedClaimNumbers[rowIndex][columnIndex];
    const ultimate = ultimateClaimNumbers[rowIndex];
    if (!Number.isFinite(closed)) return null;
    return ultimate ? closed / ultimate : 0;
  });

  const defaults = latestByColumn(proportionSettled, 0).values;
  const enteredProportions = normalizeNumberVector(
    input.selectedProportionSettled,
    developmentCount,
    "selectedProportionSettled",
  );
  const defaultFlags = Array.isArray(input.selectedProportionIsDefault)
    ? input.selectedProportionIsDefault
    : [];
  const selectedProportionSettled = defaults.map((defaultValue, index) => {
    const entered = enteredProportions[index];
    if (defaultFlags[index] === true || !Number.isFinite(entered)) return defaultValue;
    return entered;
  });

  const selectedClaimNumbers = matrixLike(
    paidClaims,
    (rowIndex, columnIndex) => (
      ultimateClaimNumbers[rowIndex] * selectedProportionSettled[columnIndex]
    ),
  );
  const pointsByRow = paidClaims.map((row, rowIndex) => (
    rowPoints(closedClaimNumbers[rowIndex], row)
  ));
  const pairsAdjustment = matrixLike(
    paidClaims,
    (rowIndex, columnIndex) => pairwiseEstimate(
      pointsByRow[rowIndex],
      selectedClaimNumbers[rowIndex][columnIndex],
    ),
  );
  const allAdjustment = matrixLike(
    paidClaims,
    (rowIndex, columnIndex) => allPointsEstimate(
      pointsByRow[rowIndex],
      selectedClaimNumbers[rowIndex][columnIndex],
    ),
  );
  const loessSpan = normalizeLoessSpan(input.loessSpan);
  const loessAdjustment = matrixLike(paidClaims, (rowIndex, columnIndex) => {
    const estimate = loessEstimate(
      pointsByRow[rowIndex],
      selectedClaimNumbers[rowIndex][columnIndex],
      loessSpan,
    );
    // ResQ reverts to pair-wise interpolation when the Loess fit fails.
    return estimate === null
      ? pairwiseEstimate(
          pointsByRow[rowIndex],
          selectedClaimNumbers[rowIndex][columnIndex],
        )
      : estimate;
  });
  const effectiveSelectedAdjustment = matrixLike(
    paidClaims,
    (rowIndex, columnIndex) => selectedAdjustmentAt(
      input.selectedAdjustment,
      rowIndex,
      columnIndex,
      defaultAdjustmentForRow(pointsByRow[rowIndex]),
    ),
  );
  const adjustedPaidClaims = matrixLike(paidClaims, (rowIndex, columnIndex) => {
    const selection = effectiveSelectedAdjustment[rowIndex][columnIndex];
    if (selection === "unadjusted") return paidClaims[rowIndex][columnIndex];
    if (selection === "all") return allAdjustment[rowIndex][columnIndex];
    if (selection === "loess") return loessAdjustment[rowIndex][columnIndex];
    return pairsAdjustment[rowIndex][columnIndex];
  });

  return {
    loessSpan,
    proportionSettled,
    selectedProportionSettled,
    selectedClaimNumbers,
    pairsAdjustment,
    allAdjustment,
    loessAdjustment,
    selectedAdjustment: effectiveSelectedAdjustment,
    adjustedPaidClaims,
    output: adjustedPaidClaims,
  };
}
