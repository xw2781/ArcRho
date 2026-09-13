# Check: a PC with no access gives itself access when Excel opens

A five-minute manual check that the add-in installs this PC's own ArcRho
Server credential the first time it loads, that a credential deliberately
turned off is left alone, and that a PC away from the office pays one short
failure rather than a hang. There is no automated harness for the add-in's
VBA, so this is the check.

## What it needs

- The beta add-in built from this clone:
  `powershell -NoProfile -ExecutionPolicy Bypass -File excel-addin\tools\build_xlam.ps1`
- The helper deployed on the share at
  `<workspace>\apps\ArcRho Credential\ArcRho Credential.exe`
- A credential of your own at `%APPDATA%\ArcRho\arcrho_gateway.json` to copy
  aside and put back at the end, so the check leaves the PC as it found it.

Excel is driven over COM. Set `DisplayAlerts`, `EnableEvents` and
`ScreenUpdating` to `False` the moment the application object exists — a modal
alert from an invisible instance lands on the desktop and blocks the call for
ever — then turn `EnableEvents` back on for the one line that opens the
add-in, because the whole point is to let `Workbook_Open` run. Never write a
formula into a cell that might sit in an array formula: call the function with
`Application.Run` instead, which returns the same array and touches no sheet.

## The four checks

1. **The helper runs from the share.** Move the credential aside and start
   `ArcRho Credential.exe` the way the add-in does — through `WScript.Shell`,
   hidden, waiting for it — handing it the workspace root as its one argument.
   It must exit 0 with no warning dialog and the credential must be back.
2. **Excel sets the PC up on its own.** Move the credential aside again, open
   the beta `.xlam`, and confirm the credential is back with no command run by
   hand, then ask for a triangle and confirm it returns figures.
3. **An opt-out is honoured.** Put `{"enabled": false}` in the credential file,
   open the add-in, and confirm the file is untouched and a formula shows the
   "not set up to read ArcRho data" line rather than figures.
4. **A dead share fails quickly.** Time the add-in's own guard — `Dir$` against
   a path on a host that does not exist — and confirm it comes back with an
   error in about a second and raises no dialog.

## Result, 2026-09-12, `L-H2MQ6280FVP`, add-in 2.6.0

Against `NJ_Annual_Prod_202605_Fake`, reserving class
`HPPREF\HO+DF\NJ\Legacy\HOL`, dataset `Net Loss--Incurred Adjusted***` asked
for at one month by one month.

| Check | Result |
| :--- | :--- |
| Helper from the share | exit 0 in 14.05 s, no dialog, credential back and byte-identical to the one moved aside |
| Excel opens with no credential | credential installed during `Workbook_Open` in 11.78 s; `ArcRhoTri` then returned a 120 x 113 array in 0.47 s |
| `enabled: false` left alone | file unchanged; the formula answered "(this PC is not set up to read ArcRho data. Ask the ArcRho team to give you access, then restart Excel.)" |
| Host that does not exist | VBA error 52 after 1.34 s, nothing shown, nothing left running |

The same secret came back in check 1 because this user was already in the
shared registry: enrollment reuses an entry rather than replacing it, so a
second run cannot lock the first one out.

The eleven to fourteen seconds is the whole enrollment — reading the shared
registry over the share, asking the Gateway whether it is there, writing both
files — and is paid once on a PC that has never had a credential. The loading
window says what is happening while it runs.
