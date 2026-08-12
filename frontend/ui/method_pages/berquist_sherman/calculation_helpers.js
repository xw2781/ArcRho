export const DEFAULT_LOESS_SPAN = 7;
const MIN_LOESS_SPAN = 2;
const MAX_LOESS_SPAN = 99;

export function normalizeLoessSpan(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LOESS_SPAN;
  return Math.min(MAX_LOESS_SPAN, Math.max(MIN_LOESS_SPAN, Math.trunc(number)));
}

// B&S supports annual development triangles, whose available cells form the
// same upper-left staircase shown by the Dataset Viewer. ResQ and some legacy
// CSVs pad the unavailable lower-right area with numeric zeroes, so the value
// alone cannot distinguish a real zero observation from structural padding.
// Apply both the Dataset Viewer mask and the annual staircase at ingestion;
// calculations can then preserve the jagged shape by mapping the source rows.
export function normalizeAnnualTriangle(rawValues, rawMask = null) {
  const rows = Array.isArray(rawValues) ? rawValues : [];
  const masks = Array.isArray(rawMask) ? rawMask : [];
  const developmentCount = Math.max(
    0,
    ...rows.map((row) => Array.isArray(row) ? row.length : 1),
    ...masks.map((row) => Array.isArray(row) ? row.length : 0),
  );

  return rows.map((rawRow, rowIndex) => {
    const values = Array.isArray(rawRow) ? rawRow : [rawRow];
    const mask = Array.isArray(masks[rowIndex]) ? masks[rowIndex] : null;
    const structuralLength = Math.max(0, developmentCount - rowIndex);
    const candidateLength = Math.min(
      structuralLength,
      Math.max(values.length, mask?.length || 0),
    );
    let lastIncluded = candidateLength - 1;
    if (mask) {
      while (lastIncluded >= 0 && !mask[lastIncluded]) lastIncluded -= 1;
    } else {
      while (
        lastIncluded >= 0
        && (values[lastIncluded] === null
          || values[lastIncluded] === undefined
          || values[lastIncluded] === "")
      ) {
        lastIncluded -= 1;
      }
    }
    if (lastIncluded < 0) return [];

    return Array.from({ length: lastIncluded + 1 }, (_, columnIndex) => {
      if (mask && !mask[columnIndex]) return null;
      const value = values[columnIndex];
      if (value === null || value === undefined || value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    });
  });
}

// ResQ "Loess (n)": a tri-cube weighted straight-line fit over the span + 1
// nearest neighbours, evaluated at `target`. The furthest neighbour's weight is
// exactly zero, so it drops out of the fit. Returns null when too few
// neighbours carry weight; each method decides what a degenerate fit means.
// Settlement Rate fits log paid claims against closed counts and reverts to its
// pair-wise interpolation, while Case Reserve Adequacy fits the latest average
// case reserves against development period and reports zero.
export function loessFit(points, target, span, minimumPoints = 2) {
  if (!Number.isFinite(target) || points.length < minimumPoints) return null;

  const distances = points
    .map((point) => Math.abs(point.x - target))
    .sort((a, b) => a - b);
  const bandwidth = distances[Math.min(span, points.length - 1)];
  const weighted = [];
  for (const point of points) {
    const distance = Math.abs(point.x - target);
    if (!(bandwidth > 0) || distance >= bandwidth) continue;
    const scaled = distance / bandwidth;
    weighted.push({ x: point.x, y: point.y, weight: (1 - scaled ** 3) ** 3 });
  }
  if (weighted.length < minimumPoints) return null;

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
  return meanY + slope * (target - meanX);
}

export function normalizeTriangle(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty triangle.`);
  }
  return value.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new TypeError(`${name}[${rowIndex}] must be an array.`);
    }
    return row.map((cell, columnIndex) => {
      if (cell === null || cell === undefined || cell === "") return null;
      const number = Number(cell);
      if (!Number.isFinite(number)) {
        throw new TypeError(`${name}[${rowIndex}][${columnIndex}] must be numeric or blank.`);
      }
      return number;
    });
  });
}

export function assertSameTriangleShape(reference, candidate, name) {
  if (candidate.length !== reference.length) {
    throw new RangeError(`${name} must have the same number of rows as the primary triangle.`);
  }
  reference.forEach((row, rowIndex) => {
    if (candidate[rowIndex].length !== row.length) {
      throw new RangeError(`${name}[${rowIndex}] must match the primary triangle row length.`);
    }
  });
}

export function columnCount(triangle) {
  return triangle.reduce((maximum, row) => Math.max(maximum, row.length), 0);
}

export function matrixLike(triangle, getValue) {
  return triangle.map((row, rowIndex) => (
    row.map((_, columnIndex) => getValue(rowIndex, columnIndex))
  ));
}

export function latestByColumn(triangle, fallback = 0) {
  const count = columnCount(triangle);
  const values = Array(count).fill(fallback);
  const rowIndexes = Array(count).fill(-1);
  for (let columnIndex = 0; columnIndex < count; columnIndex += 1) {
    for (let rowIndex = triangle.length - 1; rowIndex >= 0; rowIndex -= 1) {
      const value = triangle[rowIndex]?.[columnIndex];
      if (Number.isFinite(value)) {
        values[columnIndex] = value;
        rowIndexes[columnIndex] = rowIndex;
        break;
      }
    }
  }
  return { values, rowIndexes };
}

export function unweightedLogInflation(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const count = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  points.forEach(({ x, value }) => {
    const y = Math.log(value);
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  });
  const denominator = count * sumXX - sumX * sumX;
  if (!denominator) return 0;
  const slope = (count * sumXY - sumX * sumY) / denominator;
  return Math.exp(slope) - 1;
}

export function weightedFixedEffectsLogInflation(groups) {
  let numerator = 0;
  let denominator = 0;
  groups.forEach((group) => {
    const weightSum = group.reduce((sum, point) => sum + point.weight, 0);
    if (!(weightSum > 0)) return;
    const meanX = group.reduce(
      (sum, point) => sum + point.weight * point.x,
      0,
    ) / weightSum;
    const meanY = group.reduce(
      (sum, point) => sum + point.weight * Math.log(point.value),
      0,
    ) / weightSum;
    group.forEach((point) => {
      const centeredX = point.x - meanX;
      const centeredY = Math.log(point.value) - meanY;
      numerator += point.weight * centeredX * centeredY;
      denominator += point.weight * centeredX * centeredX;
    });
  });
  if (!denominator) return 0;
  return Math.exp(numerator / denominator) - 1;
}

export function booleanAt(matrix, rowIndex, columnIndex) {
  return matrix?.[rowIndex]?.[columnIndex] === true;
}
