export function getHostErrorMessage(err, fallback) {
  return String(err?.message || err || fallback);
}
