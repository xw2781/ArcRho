// The ArcRho timestamp text.
//
// One rule, so a Created or Last Modified reads the same wherever it is shown:
// `M/D/YYYY h:mm:ss AM/PM` in the reader's local time. The Project Instance
// dataset table established it and the Excel Link Manager follows it, which is
// why it lives here rather than in either page.
//
// The accepted inputs are what ArcRho's producers actually write: an ISO 8601
// string from a sidecar or an OOXML document property, and an epoch number
// (seconds or milliseconds) from a file stat.

function toText(value) {
  return String(value ?? "").trim();
}

/**
 * Seconds since the epoch for a timestamp value, or 0 when it is unusable.
 *
 * Sorting and "which of these two is newer" comparisons run on this rather
 * than on the formatted text, which does not sort.
 */
export function arcrhoTimestampSeconds(value) {
  const text = toText(value);
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1000000000000 ? numeric / 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

/**
 * The displayed timestamp text, or "" for a blank value.
 *
 * A value that is neither an epoch number nor a date the browser can parse is
 * shown tidied rather than dropped, so an unexpected format from an older file
 * still tells the reader something.
 */
export function formatArcrhoTimestamp(value) {
  const text = toText(value);
  if (!text) return "";
  const numeric = Number(text);
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric > 1000000000000 ? numeric : numeric * 1000)
    : new Date(text);
  if (!Number.isNaN(date.getTime())) {
    const pad = (part) => String(part).padStart(2, "0");
    const hours = date.getHours();
    const hour12 = hours % 12 || 12;
    const suffix = hours >= 12 ? "PM" : "AM";
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${hour12}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${suffix}`;
  }
  return text
    .replace("T", " ")
    .replace(/\.\d+(?=Z?$)/u, "")
    .replace(/Z$/u, "")
    .slice(0, 16);
}
