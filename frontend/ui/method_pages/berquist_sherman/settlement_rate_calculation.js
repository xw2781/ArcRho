import {
  assertSameTriangleShape,
  columnCount,
  latestByColumn,
  matrixLike,
  normalizeTriangle,
} from "./calculation_helpers.js";

const ADJUSTMENT_TYPES = new Set(["unadjusted", "pairs", "all", "loess"]);
export const DEFAULT_LOESS_SPAN = 7;
const MIN_LOESS_SPAN = 2;
const MAX_LOESS_SPAN = 99;

export function normalizeLoessSpan(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LOESS_SPAN;
  return Math.min(MAX_LOESS_SPAN, Math.max(MIN_LOESS_SPAN, Math.trunc(number)));
}

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
      points.push({ x: closed, logPaid: Math.log(paid) });
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
    return Math.exp((lower.logPaid + upper.logPaid) / 2);
  }
  const weight = (selectedClosedClaims - lower.x) / (upper.x - lower.x);
  return Math.exp(lower.logPaid + weight * (upper.logPaid - lower.logPaid));
}

function allPointsEstimate(points, selectedClosedClaims) {
  if (!Number.isFinite(selectedClosedClaims) || points.length < 2) return 0;
  const count = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.logPaid, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
  const sumXY = points.reduce(
    (sum, point) => sum + point.x * point.logPaid,
    0,
  );
  const denominator = count * sumXX - sumX * sumX;
  if (!denominator) return 0;
  const slope = (count * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / count;
  return Math.exp(intercept + slope * selectedClosedClaims);
}

function loessEstimate(points, selectedClosedClaims, span) {
  if (!Number.isFinite(selectedClosedClaims)) return null;
  if (points.length < 2) return 0;

  // ResQ "Loess (n)": weighted straight-line fit over the span+1 nearest
  // neighbours; the furthest neighbour's tri-cube weight is exactly zero.
  const distances = points
    .map((point) => Math.abs(point.x - selectedClosedClaims))
    .sort((a, b) => a - b);
  const bandwidth = distances[Math.min(span, points.length - 1)];
  const weighted = [];
  for (const point of points) {
    const distance = Math.abs(point.x - selectedClosedClaims);
    if (!(bandwidth > 0) || distance >= bandwidth) continue;
    const scaled = distance / bandwidth;
    weighted.push({ x: point.x, y: point.logPaid, weight: (1 - scaled ** 3) ** 3 });
  }
  if (weighted.length < 2) return null;

  const weightSum = weighted.reduce((sum, point) => sum + point.weight, 0);
  const meanX = weighted.reduce((sum, point) => sum + point.weight * point.x, 0) / weightSum;
  const meanY = weighted.reduce((sum, point) => sum + point.weight * point.y, 0) / weightSum;
  const sxx = weighted.reduce(
    (sum, point) => sum + point.weight * (point.x - meanX) ** 2,
    0,
  );
  if (!(sxx > 0)) return null;
  const slope = weighted.reduce(
    (sum, point) => sum + point.weight * (point.x - meanX) * (point.y - meanY),
    0,
  ) / sxx;
  return Math.exp(meanY + slope * (selectedClosedClaims - meanX));
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
