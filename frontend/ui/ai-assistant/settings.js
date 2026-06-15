export function normalizeReadableRootList(folders = []) {
  const seen = new Set();
  const roots = [];
  for (const folder of Array.isArray(folders) ? folders : []) {
    const text = String(folder || "").trim();
    if (!text) continue;
    const key = text.replace(/[\\/]+$/g, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(text);
  }
  return roots;
}
