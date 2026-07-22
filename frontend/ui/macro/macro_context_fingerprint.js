const VOLATILE_METHOD_METADATA_KEYS = new Set([
  "last modified",
]);

function canonicalizeJsonValue(value, path = []) {
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeJsonValue(item, [...path, String(index)]));
  }
  if (!value || typeof value !== "object") return value;

  const isMethodMetadata = path.length === 2
    && path[0] === "activeJson"
    && path[1] === "method metadata";
  const out = {};
  Object.keys(value).sort().forEach((key) => {
    if (isMethodMetadata && VOLATILE_METHOD_METADATA_KEYS.has(key)) return;
    out[key] = canonicalizeJsonValue(value[key], [...path, key]);
  });
  return out;
}

export function canonicalizeMacroContext(context = {}) {
  return canonicalizeJsonValue({
    activeJson: context.activeJson || null,
    fields: context.fields || {},
    methodPath: String(context.methodPath || context.targetPath || ""),
  });
}

function hashMacroContextText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function macroContextFingerprint(context = {}) {
  return hashMacroContextText(JSON.stringify(canonicalizeMacroContext(context)));
}
