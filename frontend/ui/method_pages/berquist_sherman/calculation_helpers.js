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
