import {
  assertSameTriangleShape,
  booleanAt,
  columnCount,
  latestByColumn,
  matrixLike,
  normalizeTriangle,
  unweightedLogInflation,
  weightedFixedEffectsLogInflation,
} from "./calculation_helpers.js";

const INFLATION_SELECTIONS = new Set([
  "case_column",
  "case_all",
  "paid_column",
  "paid_all",
  "user",
]);
const AVERAGE_SELECTIONS = new Set(["latest", "monotone", "loess", "user"]);

function positiveRatio(numerator, denominator) {
  if (!(numerator > 0) || !(denominator > 0)) return 0;
  return numerator / denominator;
}

function normalizeNumberVector(value, count, name, fallback = 0) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: count }, (_, index) => {
    const entry = source[index];
    if (entry === null || entry === undefined || entry === "") return fallback;
    const number = Number(entry);
    if (!Number.isFinite(number)) {
      throw new TypeError(`${name}[${index}] must be numeric or blank.`);
    }
    return number;
  });
}

function normalizeSelectionVector(value, count, allowed, fallback, name) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: count }, (_, index) => {
    const entry = source[index];
    const selection = entry === null || entry === undefined || entry === ""
      ? fallback
      : String(entry).trim().toLowerCase();
    if (!allowed.has(selection)) {
      throw new RangeError(`Unsupported ${name} selection: ${entry}`);
    }
    return selection;
  });
}

function estimateInflationByColumn(averages, exclusions) {
  return Array.from({ length: columnCount(averages) }, (_, columnIndex) => {
    const points = [];
    averages.forEach((row, rowIndex) => {
      const value = row[columnIndex];
      if (
        value > 0
        && !booleanAt(exclusions, rowIndex, columnIndex)
      ) {
        points.push({ x: rowIndex, value });
      }
    });
    return unweightedLogInflation(points);
  });
}

function estimateOverallInflation(averages, exclusions, weightAt) {
  const groups = Array.from(
    { length: columnCount(averages) },
    (_, columnIndex) => {
      const points = [];
      averages.forEach((row, rowIndex) => {
        const value = row[columnIndex];
        const weight = weightAt(rowIndex, columnIndex);
        if (
          value > 0
          && weight > 0
          && !booleanAt(exclusions, rowIndex, columnIndex)
        ) {
          points.push({ x: rowIndex, value, weight });
        }
      });
      return points;
    },
  );
  return weightedFixedEffectsLogInflation(groups);
}

function monotoneLatestAverages(latest) {
  const observations = latest
    .map((value, index) => ({ index, value }))
    .filter(({ value }) => value > 0);
  if (observations.length === 0) return latest.map(() => 0);

  const blocks = [];
  observations.forEach((observation) => {
    blocks.push({
      first: observation.index,
      last: observation.index,
      sum: observation.value,
      count: 1,
      value: observation.value,
    });
    while (
      blocks.length > 1
      && blocks[blocks.length - 2].value > blocks[blocks.length - 1].value
    ) {
      const right = blocks.pop();
      const left = blocks.pop();
      const sum = left.sum + right.sum;
      const count = left.count + right.count;
      blocks.push({
        first: left.first,
        last: right.last,
        sum,
        count,
        value: sum / count,
      });
    }
  });

  const fittedObservations = new Map();
  blocks.forEach((block) => {
    observations.forEach((observation) => {
      if (block.first <= observation.index && observation.index <= block.last) {
        fittedObservations.set(observation.index, block.value);
      }
    });
  });
  return latest.map((_, index) => {
    let chosen = fittedObservations.get(observations[0].index);
    observations.forEach((observation) => {
      if (observation.index <= index) {
        chosen = fittedObservations.get(observation.index);
      }
    });
    return chosen;
  });
}

function selectInflation({
  selection,
  columnIndex,
  caseByColumn,
  caseOverall,
  paidByColumn,
  paidOverall,
  userInflation,
}) {
  if (selection === "case_column") return caseByColumn[columnIndex];
  if (selection === "case_all") return caseOverall;
  if (selection === "paid_column") return paidByColumn[columnIndex];
  if (selection === "paid_all") return paidOverall;
  return userInflation[columnIndex];
}

function selectAverage({
  selection,
  columnIndex,
  latest,
  monotone,
  user,
}) {
  if (selection === "latest") return latest[columnIndex];
  if (selection === "monotone") return monotone[columnIndex];
  if (selection === "user") return user[columnIndex];
  throw new RangeError("Loess average case reserves are not supported in the annual MVP.");
}

export function calculateCaseReserveAdequacy(input = {}) {
  const incurredClaims = normalizeTriangle(input.incurredClaims, "incurredClaims");
  const paidClaims = normalizeTriangle(input.paidClaims, "paidClaims");
  const reportedClaimNumbers = normalizeTriangle(
    input.reportedClaimNumbers,
    "reportedClaimNumbers",
  );
  const closedClaimNumbers = normalizeTriangle(
    input.closedClaimNumbers,
    "closedClaimNumbers",
  );
  assertSameTriangleShape(incurredClaims, paidClaims, "paidClaims");
  assertSameTriangleShape(incurredClaims, reportedClaimNumbers, "reportedClaimNumbers");
  assertSameTriangleShape(incurredClaims, closedClaimNumbers, "closedClaimNumbers");

  const developmentCount = columnCount(incurredClaims);
  const openClaimNumbers = matrixLike(
    incurredClaims,
    (rowIndex, columnIndex) => {
      const reported = reportedClaimNumbers[rowIndex][columnIndex];
      const closed = closedClaimNumbers[rowIndex][columnIndex];
      return Number.isFinite(reported) && Number.isFinite(closed)
        ? reported - closed
        : null;
    },
  );
  const caseReserves = matrixLike(incurredClaims, (rowIndex, columnIndex) => {
    const incurred = incurredClaims[rowIndex][columnIndex];
    const paid = paidClaims[rowIndex][columnIndex];
    return Number.isFinite(incurred) && Number.isFinite(paid)
      ? incurred - paid
      : null;
  });
  const averageCaseReserves = matrixLike(
    incurredClaims,
    (rowIndex, columnIndex) => positiveRatio(
      caseReserves[rowIndex][columnIndex],
      openClaimNumbers[rowIndex][columnIndex],
    ),
  );
  const incrementalClosedClaimNumbers = matrixLike(
    incurredClaims,
    (rowIndex, columnIndex) => {
      const current = closedClaimNumbers[rowIndex][columnIndex];
      if (!Number.isFinite(current)) return null;
      const previous = columnIndex > 0
        ? closedClaimNumbers[rowIndex][columnIndex - 1]
        : 0;
      return Number.isFinite(previous) ? current - previous : null;
    },
  );
  const incrementalPaidClaims = matrixLike(
    incurredClaims,
    (rowIndex, columnIndex) => {
      const current = paidClaims[rowIndex][columnIndex];
      if (!Number.isFinite(current)) return null;
      const previous = columnIndex > 0 ? paidClaims[rowIndex][columnIndex - 1] : 0;
      return Number.isFinite(previous) ? current - previous : null;
    },
  );
  const averagePaidClaims = matrixLike(
    incurredClaims,
    (rowIndex, columnIndex) => positiveRatio(
      incrementalPaidClaims[rowIndex][columnIndex],
      incrementalClosedClaimNumbers[rowIndex][columnIndex],
    ),
  );

  const caseInflationByColumn = estimateInflationByColumn(
    averageCaseReserves,
    input.avgCaseReserveExclusions,
  );
  const paidInflationByColumn = estimateInflationByColumn(
    averagePaidClaims,
    input.avgPaidClaimsExclusions,
  );
  const caseInflationOverall = estimateOverallInflation(
    averageCaseReserves,
    input.avgCaseReserveExclusions,
    (rowIndex, columnIndex) => openClaimNumbers[rowIndex][columnIndex],
  );
  const paidInflationOverall = estimateOverallInflation(
    averagePaidClaims,
    input.avgPaidClaimsExclusions,
    (rowIndex, columnIndex) => incrementalClosedClaimNumbers[rowIndex][columnIndex],
  );

  const inflationSelection = normalizeSelectionVector(
    input.inflationSelection,
    developmentCount,
    INFLATION_SELECTIONS,
    "paid_all",
    "inflation",
  );
  const userInflation = normalizeNumberVector(
    input.userInflation,
    developmentCount,
    "userInflation",
  );
  const selectedInflation = inflationSelection.map((selection, columnIndex) => (
    selectInflation({
      selection,
      columnIndex,
      caseByColumn: caseInflationByColumn,
      caseOverall: caseInflationOverall,
      paidByColumn: paidInflationByColumn,
      paidOverall: paidInflationOverall,
      userInflation,
    })
  ));

  const latest = latestByColumn(averageCaseReserves, 0);
  const latestAverageCaseReserves = latest.values;
  const monotoneAverageCaseReserves = monotoneLatestAverages(
    latestAverageCaseReserves,
  );
  const loessAverageCaseReserves = Array(developmentCount).fill(null);
  const averageCaseReserveSelection = normalizeSelectionVector(
    input.averageCaseReserveSelection,
    developmentCount,
    AVERAGE_SELECTIONS,
    "latest",
    "average case reserve",
  );
  const userAverageCaseReserves = normalizeNumberVector(
    input.userAverageCaseReserves,
    developmentCount,
    "userAverageCaseReserves",
  );
  const selectedAverageCaseReserves = averageCaseReserveSelection.map(
    (selection, columnIndex) => selectAverage({
      selection,
      columnIndex,
      latest: latestAverageCaseReserves,
      monotone: monotoneAverageCaseReserves,
      user: userAverageCaseReserves,
    }),
  );

  const adjustedAverageCaseReserves = matrixLike(
    incurredClaims,
    (rowIndex, columnIndex) => {
      const latestRowIndex = latest.rowIndexes[columnIndex];
      if (latestRowIndex < rowIndex) return null;
      const inflation = selectedInflation[columnIndex];
      if (!(inflation > -1)) {
        throw new RangeError(`selectedInflation[${columnIndex}] must be greater than -1.`);
      }
      return selectedAverageCaseReserves[columnIndex]
        / ((1 + inflation) ** (latestRowIndex - rowIndex));
    },
  );
  const adjustedIncurredClaims = matrixLike(
    incurredClaims,
    (rowIndex, columnIndex) => {
      const paid = paidClaims[rowIndex][columnIndex];
      const open = openClaimNumbers[rowIndex][columnIndex];
      const adjustedAverage = adjustedAverageCaseReserves[rowIndex][columnIndex];
      if (
        !Number.isFinite(paid)
        || !Number.isFinite(open)
        || !Number.isFinite(adjustedAverage)
      ) return null;
      return paid + adjustedAverage * open;
    },
  );

  return {
    openClaimNumbers,
    caseReserves,
    averageCaseReserves,
    incrementalClosedClaimNumbers,
    incrementalPaidClaims,
    averagePaidClaims,
    caseInflationByColumn,
    caseInflationOverall,
    paidInflationByColumn,
    paidInflationOverall,
    inflationSelection,
    userInflation,
    selectedInflation,
    latestAverageCaseReserves,
    monotoneAverageCaseReserves,
    loessAverageCaseReserves,
    averageCaseReserveSelection,
    userAverageCaseReserves,
    selectedAverageCaseReserves,
    adjustedAverageCaseReserves,
    adjustedIncurredClaims,
    output: adjustedIncurredClaims,
  };
}
