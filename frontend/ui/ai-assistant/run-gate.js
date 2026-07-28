export function createAssistantRunGate() {
  let owner = null;

  return Object.freeze({
    tryAcquire(kind = "assistant") {
      if (owner) return null;
      const token = Object.freeze({ kind: String(kind || "assistant") });
      owner = token;
      return token;
    },
    owns(token) {
      return !!token && owner === token;
    },
    release(token) {
      if (!token || owner !== token) return false;
      owner = null;
      return true;
    },
  });
}
