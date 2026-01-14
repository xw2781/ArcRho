// DOM helpers and logging.

export function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

export function logLine(s) {
  const el = $("log");
  el.textContent += `${s}\n`;
  el.scrollTop = el.scrollHeight;
}
