export function calcRatio(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb) || na === 0) return null;
  const v = nb / na;
  return Number.isFinite(v) ? v : null;
}

export function roundRatio(value, decimals = 6) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function formatRatio(value, decimals = 4) {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(decimals);
}

export function computeVolumeAllForColumn(model, col, excludedSet) {
  return computeAverageForColumn(model, col, excludedSet, { base: "volume", periods: "all" });
}

export function computeVolumeRecentForColumn(model, col, excludedSet, lookback = 8) {
  return computeAverageForColumn(model, col, excludedSet, { base: "volume", periods: lookback });
}

export function computeSimpleRecentForColumn(model, col, excludedSet, lookback = 8) {
  return computeAverageForColumn(model, col, excludedSet, { base: "simple", periods: lookback });
}

export function computeAverageForColumn(model, col, excludedSet, options = {}) {
  const baseRaw = String(options.base || "volume").toLowerCase();
  const base = baseRaw === "volume" ? "volume" : "simple";
  const periodsRaw = options.periods ?? "all";
  const periods = typeof periodsRaw === "string" && periodsRaw.toLowerCase() === "all"
    ? "all"
    : Number(periodsRaw);
  const lookback = Number.isFinite(periods) && periods > 0 ? Math.floor(periods) : null;

  const out = {
    sumA: 0,
    sumB: 0,
    sum: 0,
    totalValid: 0,
    totalIncluded: 0,
    value: null,
  };

  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return out;
  const vals = model.values;
  const mask = model.mask;
  const rowCount = Array.isArray(model.origin_labels) ? model.origin_labels.length : vals.length;

  const includeRow = (r) => {
    const hasA = !!(mask[r] && mask[r][col]);
    const hasB = !!(mask[r] && mask[r][col + 1]);
    if (!hasA || !hasB) return null;
    const ratio = calcRatio(vals?.[r]?.[col], vals?.[r]?.[col + 1]);
    if (!Number.isFinite(ratio)) return null;
    return ratio;
  };

  if (lookback) {
    let picked = 0;
    for (let r = rowCount - 1; r >= 0; r--) {
      if (picked >= lookback) break;
      const ratio = includeRow(r);
      if (!Number.isFinite(ratio)) continue;
      out.totalValid += 1;
      if (excludedSet && excludedSet.has(`${r},${col}`)) continue;
      picked += 1;
      out.totalIncluded += 1;
      if (base === "volume") {
        const a = Number(vals?.[r]?.[col]);
        const b = Number(vals?.[r]?.[col + 1]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) continue;
        out.sumA += a;
        out.sumB += b;
      } else {
        out.sum += ratio;
      }
    }
  } else {
    for (let r = 0; r < rowCount; r++) {
      const ratio = includeRow(r);
      if (!Number.isFinite(ratio)) continue;
      out.totalValid += 1;
      if (excludedSet && excludedSet.has(`${r},${col}`)) continue;
      out.totalIncluded += 1;
      if (base === "volume") {
        const a = Number(vals?.[r]?.[col]);
        const b = Number(vals?.[r]?.[col + 1]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) continue;
        out.sumA += a;
        out.sumB += b;
      } else {
        out.sum += ratio;
      }
    }
  }

  if (base === "volume") {
    if (out.sumA) out.value = out.sumB / out.sumA;
  } else if (out.totalIncluded > 0) {
    out.value = out.sum / out.totalIncluded;
  }

  return out;
}
