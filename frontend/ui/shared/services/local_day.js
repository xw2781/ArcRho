// The local calendar day a timestamp falls on, as "YYYY-M-D". The history stores keep one record
// per item per day: opening an item again today replaces today's record for it, while the records
// it left on earlier days stay exactly as they were. The Browsing History page groups by the same
// key, so a store and the page can never disagree about which day a record belongs to.
export function localDayKey(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const date = new Date(n);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
