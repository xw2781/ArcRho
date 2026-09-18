# Arco Excel Add-in

`ArcRho.xlam` is loaded from the Arco Server share, so every user runs the
version that is on the share. Version 4.0.0 reads saved Arco results from the
workbook and loads missing results when a formula is entered or edited. Server
requests use HTTP; no worksheet function reads project data from the share.

The VBA source of record is [`src_vba/`](src_vba); the `.xlam` is built from it.

## Saved workbook results

Use **Refresh Worksheet** or **Refresh Workbook** to fetch current results,
then save the workbook. Its hidden `_ArcRhoCache` sheet holds one result array
per distinct request, including headers and project settings, with the snapshot
format and refresh time. Existing worksheet formulas stay in place.

Another user can open the saved workbook and read the same results without
dataset requests, source freshness checks, or Engine calculations. Ordinary
Excel recalculation uses that workbook's snapshot; other spreadsheet formulas
continue to calculate normally.

Typing, editing, or pasting an Arco formula loads any missing request as soon
as the entry is complete and adds the result to the workbook snapshot. This
includes changing the formula's explicit project name. If the same request is
already saved, the formula uses it without contacting the server or enrolling
the PC. Use a Refresh command when you want to update those existing results.
Workbooks created before 3.0.0 need one successful refresh and save to acquire
a snapshot for their existing formulas.

Repeated requests share one fetched result during refresh. A failed or cancelled
refresh preserves the previous snapshot. Refresh Worksheet updates that sheet's
requests while retaining saved requests used elsewhere in the workbook. Save
the workbook after refreshing or adding formulas to share the new values.
Snapshot data contains no credentials or raw source tables.

## Server refresh policy

- A dataset with a sidecar is read as published from the CSV named by the
  sidecar. Excel never rewrites that CSV or its metadata. Manual/input and
  generated datasets support coarser periods in memory with the same
  cumulative/calendar mode. A generated dataset asked for at a finer period, a
  non-multiple, or another mode is calculated by the Engine from its source
  table into a technical cache beside the publication, which stays as it is.
  Calculated and method outputs require their published shape, because
  aggregating a calculated ratio can change its meaning. A missing publication
  or an unsupported shape must be refreshed or corrected in the frontend; the
  message names the published and requested periods.
- A generated request without a sidecar reuses a matching technical cache while
  its source-table identity and processing configuration remain unchanged.
  Otherwise the server regenerates it without creating a permanent sidecar.
- Temporary calculated requests evaluate their formulas from published
  permanent inputs and current temporary inputs without publishing datasets.
- A propagation job covering the class asks the refresh to retry when the job
  has finished. Published values are the last successful publication; Excel
  does not repair a failed propagation job.

The old **always refresh** / `removeData` setting has been removed. Refresh
commands follow the server policy for every dataset.

## What this PC needs

- **The workspace share.** The add-in itself is loaded from it, and the shared
  library files listed at the end still come from it. Project data does not.
- **A credential for the Arco Server**, at
  `%APPDATA%\Arco\arcrho_gateway.json`. The add-in installs one for itself the
  first time an entered formula or a refresh needs server access, so reading a
  saved workbook needs no enrollment.

## The credential

The file holds this Windows user's name, the address of the Arco Server's
Gateway, and a secret. The matching entry lives in the shared registry at
`<workspace>\config\arcrho_gateway.json`. Only a person who can write to that
file under their own Windows account can add an entry to it, and that is how the
server knows who is asking: the share is the authentication, and the Gateway
itself hands nothing out to a caller that can only reach its port.

**It installs itself when server access is first needed.** When an entered
formula has no saved result, or a refresh starts, and no credential file exists,
the add-in runs `apps\Arco Credential\Arco Credential.exe`
from the share, hidden, and waits for it, with
`Setting this PC up to read Arco data ...` in the loading window. The whole
enrollment is paid once on a PC that has never had a credential. Opening and
recalculating a saved snapshot does not run the helper.

Three things about that first run are deliberate:

- It is tried **once per Excel session**. A PC away from the office pays one
  short enrollment failure, and never one per formula.
- It is skipped without a word when **the share cannot be reached**.
- A credential file that says `"enabled": false` is a **deliberate opt-out** and
  is left exactly as it is. A new data request reports that the PC is not
  configured; previously saved values remain available.

**On the rare PC where the first run does not work**, run the helper by hand from
a command prompt, handing it the workspace folder:

```
"\\Ne7saswpn02\e\Arco Server\apps\Arco Credential\Arco Credential.exe" "\\Ne7saswpn02\e\Arco Server"
```

It prints one line and exits non-zero when it installed nothing:

| Line | What it means |
| :--- | :--- |
| `ArcRho credential installed: <path>` | Done. Restart Excel, then refresh the workbook. |
| `ArcRho credential already present: <path>` | A credential file is already here and was left alone, whatever it says. |
| `ArcRho Server has no Gateway address for clients to use.` | The server is not yet configured to be reached by clients. Ask the Arco team. |
| `ArcRho credential not installed: <reason>` | The share or the Gateway could not be reached, or the registry could not be written. The reason is Windows' own. Nothing was written, so it is safe to try again. |

## Checking this PC

With the add-in loaded, run `CheckArcRhoGateway` in the Immediate window
(`Alt+F11`, then `Ctrl+G`). It signs one fixed request, then talks to the server
this PC is pointed at, and prints a line for each part:

| Line | What a working PC shows |
| :--- | :--- |
| `vector digest` | `match` |
| `vector signature` | `match` |
| `credential` | the user name and server address, or `none on this PC` |
| `health` | `200` |
| `capabilities` | `200` and the list of what this server serves |
| `signed request` | `400` — the signature was accepted and the deliberately unreadable request was then refused. `401` would mean the signature itself was refused. |

`cscript //nologo excel-addin\tools\verify_gateway_signing.vbs` checks the
signing half alone, without Excel and without sending anything.

## What each failure message means

### While loading or refreshing results

Refresh failures appear in Excel's status bar and preserve the previous
snapshot. A failed formula-entry load also leaves previously saved results
available. An existing formula absent from the snapshot during ordinary
recalculation displays
`(Arco: Refresh Worksheet or Refresh Workbook to load saved data.)`.

| Message | Cause and what to do |
| :--- | :--- |
| `This PC is not set up to load Arco data.` / `This PC is not set up to refresh Arco data.` | No usable credential on this PC: enrollment did not succeed, or the file says `"enabled": false`. Run the helper by hand as above, then restart Excel. |
| `Ask the Arco team to update the Arco Server.` | The server this PC reaches does not serve dataset figures over HTTP. The server has to be updated. |
| `(Arco Server not reached: <reason>)` | The request never arrived. The reason is Windows' own — a timeout, a refused connection, no network. `no answer` means the server closed the connection without a reply. |
| `(Arco Server <status>: <message>)` | The server answered and refused. The message is the server's own; the status says what kind of refusal it was. |
| `(Arco Server sent an answer this add-in could not read.)` | The reply was not the JSON the add-in expects, which usually means something other than the Arco Server answered on that address. |
| `(Arco Server answered without the dataset's figures.)` | The server accepted the request and reported success but sent no figures. |
| `Arco error <number>: <description>` | The add-in itself failed inside Excel, before or after the server was involved. |

A failure the server itself reports includes its reason, such as a missing
publication or a class currently being refreshed by the frontend.

### In the Select Datasets window

| Message | Cause and what to do |
| :--- | :--- |
| `This PC is not set up to read Arco data. Ask the Arco team to give you access, then restart Excel.` | The same missing credential, said without brackets because it is shown in a box rather than a cell. |
| `Unable to load dataset list:` followed by a reason | The list could not be fetched. The reason beneath it is one of the cell messages above, or one of the two below. |
| `Arco Server answered without the project's dataset types.` | The server answered but not with the table the picker lists. |
| `This project defines no dataset types.` | The project was read and has no dataset types configured. |
| `Please connect and log in, then select a default project before using Select Datasets.` | Nothing is wrong with the server; the workbook has no default project selected yet. |

## What still comes from the share

Moving project data to the server did not remove the drive mapping. These are
still opened directly, so a PC that cannot reach the share loses them:

- the add-in itself, `Excel Add-ins\ArcRho.xlam` and the beta beside it;
- `apps\Arco Credential\Arco Credential.exe`, the first-run helper;
- `library\INDEX_RSV_CLS_INPUT.csv`, the reserving-class list the Load Reserving
  Classes window offers;
- `library\Version Track.docx`, opened by the About window;
- `Team Profile\Actuarial_NJ.xlsm`, the default team profile in Settings.

## The recorded checks

Snapshot behavior is checked in isolated Excel sessions. The checks below
describe the expected results and retain earlier transport measurements:

Run `py -3.10 -B excel-addin/tools/verify_workbook_snapshots.py` on a Windows
PC with Excel, pywin32, and trusted VBA project access. The harness uses
synthetic Gateway responses and disposable workbooks under repository `test/`.
After building, `py -3.10 -B excel-addin/tools/verify_built_addin.py
excel-addin/beta/ARCRHO_BETA.xlam` checks the compiled add-in against its source.

| Check | What it proves |
| :--- | :--- |
| [check_dataset_cache.md](tools/check_dataset_cache.md) | Saved snapshots reopen without server access, entered formulas load missing requests, and explicit refresh fetches each distinct request once. |
| [check_gateway_signing.md](tools/check_gateway_signing.md) | The add-in signs a request the way the server verifies it, and this PC can reach the server. |
| [check_gateway_transport.md](tools/check_gateway_transport.md) | Every worksheet function returns the same figures from the server as it did from the share, and how long each takes. |
| [check_first_run_credential.md](tools/check_first_run_credential.md) | A PC with no credential gives itself one when a new formula or refresh needs data, an opt-out is left alone, and a dead share fails quickly. |

## Building and releasing

[`agent-instructions/excel-addin-build-and-release.md`](../agent-instructions/excel-addin-build-and-release.md)
owns the procedure. `tools/build_xlam.ps1` builds the beta add-in;
`tools/release_xlam.ps1` publishes `ArcRho.xlam` to the share, where every user
picks it up on the next Excel launch. The scripts require the existing beta
workbook and signature files. When invoking the required server-clone scripts
from another working clone, pass that clone's current `SourceDir` and
`CustomUIPath` explicitly so the build includes the changes being released.
