// Parse input from formula bar.
// Supports:
// - "" -> null
// - "123.45" -> number
// - "=1+2*3" -> evaluated number (basic safe check)

export function parseFormulaInput(text) {
  const t = (text ?? "").trim();
  if (t === "") return { ok: true, value: null };

  // percentage input like "12.5%"
  if (!t.startsWith("=") && t.endsWith("%")) {
    const num = Number(t.slice(0, -1).replace(/,/g, ""));
    if (!Number.isFinite(num)) {
      return { ok: false, error: `Invalid percentage: "${t}"` };
    }
    return { ok: true, value: num / 100 };
  }

  // plain number
  if (!t.startsWith("=")) {
    const cleaned = t.replace(/,/g, "");
    const x = Number(cleaned);
    if (!Number.isFinite(x)) return { ok: false, error: `Invalid number: "${t}"` };
    return { ok: true, value: x };
  }

  // formula
  const expr = t.slice(1).trim();
  if (expr === "") return { ok: true, value: null };

  // Safety: allow only digits, operators, parentheses, dot, spaces
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
    return { ok: false, error: "Formula contains invalid characters (allowed: 0-9 + - * / ( ) .)" };
  }

  // Evaluate with Function (still guarded by regex above)
  try {
    const fn = new Function(`return (${expr});`);
    const out = fn();
    const x = Number(out);
    if (!Number.isFinite(x)) return { ok: false, error: `Formula result is not a finite number: ${String(out)}` };
    return { ok: true, value: x };
  } catch (e) {
    return { ok: false, error: `Formula error: ${e?.message || String(e)}` };
  }
}
