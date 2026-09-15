# DFM preview and save return HTTP 500: curve fit overflow on a factor one float step above 1

**Found:** 2026-09-14, in a DFM whose Ratios tab User Entry row had been filled from an Excel linked
range

## Symptom

Every preview and every save of the affected method fails:

```
DFM preview failed: HTTP 500
DFM save failed: HTTP 500
```

The messages carry no detail, because FastAPI answers an unhandled exception with a plain
`Internal Server Error` body that the client cannot read a `detail` out of
(`frontend/ui/method_pages/dfm/dfm_method_api.js:16`).

The same Excel range entered in other DFMs saves normally, which makes the Excel link look like the
cause. It is not: the link only delivers the value that the curve fit then chokes on.

### Nothing is logged

In developer mode the Electron shell spawns the app server with `stdio: "ignore"`
(`frontend/electron/backend_lifecycle.js:447`), so the back end's traceback goes nowhere: no
`arcrho-server-*.log`, no console window content, nothing under `runtime\logs`. Only the packaged
build pipes the server's output to a log file.

The traceback was captured by running a temporary cell through `POST /scripting/run`, which executes
in the app-server process. The cell added a `logging.FileHandler` to `uvicorn.error` and wrapped
`dfm_service.preview_dfm_method` / `save_dfm_method` so a failure wrote both the traceback and the
exact request payload to a scratch file. The probe lives only in the running process and dies with
the next app-server restart. It is the only way to see an unhandled server error in developer mode.

## Root cause

```
File "python-api\src\arcrho_api\dfm_contract.py", line 1891, in recalculate_dfm_method
    curves = curves_table(stored_chain[:-1], stored_chain[-1] if stored_chain else 1.0, method["curves_tab"])
File "python-api\src\arcrho_api\dfm_curves.py", line 401, in fit_curves
    fit = _fit_kind(kind, points)
File "python-api\src\arcrho_api\dfm_curves.py", line 325, in _fit_kind
    a, b = math.exp(math.exp(intercept)), math.exp(slope)
OverflowError: math range error
```

One of the method's selected development factors was `1.0000000000000002` — one float step above 1.
It reached the method from a User Entry cell in the Ratios tab, where an Excel linked range had
written the workbook's value at full double precision.

`_log_points` skips a factor of exactly 1, because the log of a zero excess is undefined, but it
kept this one. Its `ln(ln r)` is about **-36**, while every real point sat between -0.1 and -6.2:

| t | factor | `ln(ln r)` |
| --- | --- | --- |
| 1 | 2.484089 | -0.094 |
| 2 | 1.326552 | -1.264 |
| 3 | 1.184707 | -1.775 |
| 4 | 1.028533 | -3.571 |
| 6 | 1.021101 | -3.869 |
| 7 | 1.002263 | -6.092 |
| 8 | 1.001937 | -6.247 |
| 9 | **1.0000000000000002** | **-36.044** |

That single point pulled the Power regression's intercept from 0.61 to 6.60, and the Power curve is
fitted as `a = exp(exp(intercept))`. `exp(exp(6.6))` is `e**738`, past the largest double, so
`math.exp` raised `OverflowError`. Nothing caught it, so the whole method calculation failed and
both `/dfm/method/preview` and `/dfm/method/save` answered 500.

The crash needs a selected factor within a float step of 1, which is why it hits one method and not
its neighbours. The dust does not have to come from Excel: an in-app User Entry formula, an average
row, or the ratio arithmetic can all produce a result that is 1 plus a hair.

## Fix

Applied 2026-09-14, in the fit alone. No stored value is rounded and no other consumer changes:

- `python-api/src/arcrho_api/dfm_curves.py:72` — `UNIT_FACTOR_TOLERANCE = 1e-12`.
- `python-api/src/arcrho_api/dfm_curves.py:302` — `_log_points` skips a factor within that tolerance
  of 1, the way it already skipped a factor of exactly 1.
- `python-api/src/arcrho_api/dfm_curves.py:334` — `_fit_kind` catches `OverflowError` and rejects a
  non-finite parameter, so a curve that cannot be fitted is reported unfitted instead of failing the
  method.
- `frontend/ui/method_pages/dfm/dfm_curve_fit.js:44,182,206` — the same three changes in the browser
  mirror, where `Math.exp` returns `Infinity` rather than raising.
- Regression tests: `python-api/tests/test_dfm_curves.py:142` and
  `frontend/tests/dfm_curve_fit.test.mjs:108`. The ResQ parity fixture is unchanged and still passes.

The precision contract is untouched: an observed value is still stored exactly as read
(`canonical_input_number`, `python-api/src/arcrho_api/dfm_contract.py:127`). The tolerance exists
only to choose the points of a log regression.

### What the fix moves

Refitting every DFM of the reserving class this surfaced in, both ways, two methods change. In both
the old fits were nonsense driven by the dust point — R-squared near 0.5 with parameters up to
`1e+118` — against sane fits near 0.97 afterwards.

Most methods take every factor from Initial Selection, so their Curves tab is reference only and the
fix cannot reach a production number. A method that selects a curve column, or takes its tail from a
fitted curve, does carry the fit into its ultimates; none of the methods doing so in that class were
affected. Expect a method that had been fitting to dust to show visibly different curve numbers
afterwards. That is the repair, not a regression.

## Workaround before the fix ships

Retype the offending User Entry cell as `1`, or round the value at source in the workbook the link
points at. It reads as 1 either way, and the dust is what the fit chokes on.

## Deployment

The hosted save runs `dfm_service.save_dfm_method` inside ArcRho Engine, whose bundled copy at
`<server root>\apps\ArcRho Engine\_internal\arcrho_canonical\python-api\src\arcrho_api\dfm_curves.py:325`
still carries the unguarded line. The local app server picks the fix up on its next restart; the
Engine and the Gateway need a redeploy.

## Status

Fixed in the working tree. Pending an Engine and Gateway deploy.

## Follow-ups considered

- **Rounding Excel-entered values on the way in** was rejected. It would only close one of several
  doors the same dust can come through, and rounding a linked value to the method's decimal places
  would silently move results and break the point of linking to a workbook.
- **Naming the unfitted state.** An unfitted curve shows a blank status cell
  (`frontend/ui/method_pages/dfm/dfm_curves_tab.js:49`), which reads like a column nobody looked at.
- **A notice when a selected tail has no fit.** `curves_table` falls back to the Ratios tab tail
  (`python-api/src/arcrho_api/dfm_curves.py:533`) with nothing on screen to say so. A method that
  takes its tail from a fitted curve would have an ultimate change silently.
- **A log for the developer-mode back end.** Every unhandled server error in developer mode is lost
  today, which is why this took a live probe to diagnose.
