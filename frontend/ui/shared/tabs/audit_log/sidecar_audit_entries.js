export const SIDECAR_AUDIT_ENTRY_LIMIT = 50;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeSidecarAuditEntries(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

      const hasSidecarField = hasOwn(raw, "event_date")
        || hasOwn(raw, "Event Date")
        || hasOwn(raw, "change_info")
        || hasOwn(raw, "Change Info");
      const hasProjectLogField = hasOwn(raw, "timestamp") || hasOwn(raw, "details");
      if (hasProjectLogField && !hasSidecarField) return null;

      const eventDate = String(raw.event_date ?? raw["Event Date"] ?? "").trim();
      const action = String(raw.action ?? raw.Action ?? "").trim();
      const changeInfo = String(raw.change_info ?? raw["Change Info"] ?? "").trim();
      const user = String(raw.user ?? raw.User ?? "").trim();
      if (!eventDate && !action && !changeInfo && !user) return null;

      return { eventDate, action, changeInfo, user };
    })
    .filter(Boolean)
    .slice(-SIDECAR_AUDIT_ENTRY_LIMIT);
}

export function formatSidecarAuditEventDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;

  const hours = date.getHours();
  const hour12 = hours % 12 || 12;
  const ampm = hours >= 12 ? "PM" : "AM";
  const pad2 = (number) => String(number).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${hour12}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${ampm}`;
}
