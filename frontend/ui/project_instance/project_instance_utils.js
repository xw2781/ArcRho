export function toText(value) {
  return String(value ?? "").trim();
}

export function normalizeLookupKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

export function normalizePath(value) {
  return toText(value)
    .split("\\")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\\");
}

export function sanitizeDatasetFileName(value, fallback = "Dataset") {
  const cleaned = toText(value).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

export function getCachedDatasetKey(value) {
  return normalizeLookupKey(value);
}

export function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

export function clampNumber(value, min, max) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return min;
  return Math.max(min, Math.min(raw, max));
}

export function installProjectInstanceUtils(ctx) {
  Object.assign(ctx.api, {
    toText,
    normalizeLookupKey,
    normalizePath,
    sanitizeDatasetFileName,
    getCachedDatasetKey,
    prefersReducedMotion,
    clampNumber,
  });
}
