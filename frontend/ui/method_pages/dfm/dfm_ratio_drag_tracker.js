export function createRatioDragVisitTracker() {
  const visitedKeys = new Set();

  return {
    visit(key) {
      const normalizedKey = String(key || "");
      if (!normalizedKey || visitedKeys.has(normalizedKey)) return false;
      visitedKeys.add(normalizedKey);
      return true;
    },
    reset() {
      visitedKeys.clear();
    },
  };
}
