# ArcRho Excel Add-in

`ArcRho.xlam` is loaded from the ArcRho Server share, so every user runs the
version that is on the share. Since add-in 2.6.0 it reads no project data from
that share at all: every worksheet function asks the ArcRho Server over HTTP,
and the server works out where a dataset lives, who is asking, and how a coarser
shape is built. What a PC needs in order for that to work, and what each failure
message means, is below.

The VBA source of record is [`src_vba/`](src_vba); the `.xlam` is built from it.

## What this PC needs

- **The workspace share.** The add-in itself is loaded from it, and the shared
  library files listed at the end still come from it. Project data does not.
- **A credential for the ArcRho Server**, at
  `%APPDATA%\ArcRho\arcrho_gateway.json`. The add-in installs one for itself the
  first time it opens, so nobody sets a PC up by hand.

## The credential

The file holds this Windows user's name, the address of the ArcRho Server's
Gateway, and a secret. The matching entry lives in the shared registry at
`<workspace>\config\arcrho_gateway.json`. Only a person who can write to that
file under their own Windows account can add an entry to it, and that is how the
server knows who is asking: the share is the authentication, and the Gateway
itself hands nothing out to a caller that can only reach its port.

**It installs itself the first time Excel opens.** When the add-in loads and
finds no credential file, it runs `apps\ArcRho Credential\ArcRho Credential.exe`
from the share, hidden, and waits for it, with
`Setting this PC up to read ArcRho data ...` in the loading window. The whole
enrollment takes eleven to fourteen seconds and is paid once on a PC that has
never had a credential; afterwards the first formula of that same session
already has it.

Three things about that first run are deliberate:

- It is tried **once per Excel session**. A PC away from the office pays one
  short failure at startup rather than one per launch, and never one per formula.
- It is skipped without a word when **the share cannot be reached**.
- A credential file that says `"enabled": false` is a **deliberate opt-out** and
  is left exactly as it is. Formulas then show the "not set up" line below, which
  is the intended outcome, not a fault.

**On the rare PC where the first run does not work**, run the helper by hand from
a command prompt, handing it the workspace folder:

```
"\\Ne7saswpn02\e\ArcRho Server\apps\ArcRho Credential\ArcRho Credential.exe" "\\Ne7saswpn02\e\ArcRho Server"
```

It prints one line and exits non-zero when it installed nothing:

| Line | What it means |
| :--- | :--- |
| `ArcRho credential installed: <path>` | Done. Restart Excel and formulas will work. |
| `ArcRho credential already present: <path>` | A credential file is already here and was left alone, whatever it says. |
| `ArcRho Server has no Gateway address for clients to use.` | The server is not yet configured to be reached by clients. Ask the ArcRho team. |
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

### In a cell, in place of the figures

| Message | Cause and what to do |
| :--- | :--- |
| `(this PC is not set up to read ArcRho data. Ask the ArcRho team to give you access, then restart Excel.)` | No usable credential on this PC: the first-run install did not happen, or the file says `"enabled": false`. Run the helper by hand as above, then restart Excel. |
| `(ArcRho is not ready to answer this yet. Ask the ArcRho team to update the ArcRho Server.)` | The server this PC reaches is older than the add-in and does not serve dataset figures over HTTP. The server has to be updated. |
| `(ArcRho Server not reached: <reason>)` | The request never arrived. The reason is Windows' own — a timeout, a refused connection, no network. `no answer` means the server closed the connection without a reply. |
| `(ArcRho Server <status>: <message>)` | The server answered and refused. The message is the server's own; the status says what kind of refusal it was. |
| `(ArcRho Server sent an answer this add-in could not read.)` | The reply was not the JSON the add-in expects, which usually means something other than the ArcRho Server answered on that address. |
| `(ArcRho Server answered without the dataset's figures.)` | The server accepted the request and reported success but sent no figures. |
| `ArcRho error <number>: <description>` | The add-in itself failed inside Excel, before or after the server was involved. |

A failure the server itself reports — a dataset that does not exist, a reserving
class that cannot be read, a calculation that failed — arrives as the server's
own sentence in brackets, with no wording added by the add-in.

`This PC has no ArcRho Gateway credential.` is the reason text the add-in's own
client returns when there is nothing to sign with; it reaches a cell only as the
tail of the "not reached" line above, because the "not set up to read ArcRho
data" line is shown first.

### In the Select Datasets window

| Message | Cause and what to do |
| :--- | :--- |
| `This PC is not set up to read ArcRho data. Ask the ArcRho team to give you access, then restart Excel.` | The same missing credential, said without brackets because it is shown in a box rather than a cell. |
| `Unable to load dataset list:` followed by a reason | The list could not be fetched. The reason beneath it is one of the cell messages above, or one of the two below. |
| `ArcRho Server answered without the project's dataset types.` | The server answered but not with the table the picker lists. |
| `This project defines no dataset types.` | The project was read and has no dataset types configured. |
| `Please connect and log in, then select a default project before using Select Datasets.` | Nothing is wrong with the server; the workbook has no default project selected yet. |

## What still comes from the share

Moving project data to the server did not remove the drive mapping. These are
still opened directly, so a PC that cannot reach the share loses them:

- the add-in itself, `Excel Add-ins\ArcRho.xlam` and the beta beside it;
- `apps\ArcRho Credential\ArcRho Credential.exe`, the first-run helper;
- `library\INDEX_RSV_CLS_INPUT.csv`, the reserving-class list the Load Reserving
  Classes window offers;
- `library\Version Track.docx`, opened by the About window;
- `Team Profile\Actuarial_NJ.xlsm`, the default team profile in Settings.

## The recorded checks

There is no automated harness for the add-in's VBA, so each behaviour that
cannot be tested in Python has a manual check kept beside the code, with the run
that was recorded against it:

| Check | What it proves |
| :--- | :--- |
| [check_dataset_cache.md](tools/check_dataset_cache.md) | A dataset several formulas ask for is fetched once per recalculation. |
| [check_gateway_signing.md](tools/check_gateway_signing.md) | The add-in signs a request the way the server verifies it, and this PC can reach the server. |
| [check_gateway_transport.md](tools/check_gateway_transport.md) | Every worksheet function returns the same figures from the server as it did from the share, and how long each takes. |
| [check_first_run_credential.md](tools/check_first_run_credential.md) | A PC with no credential gives itself one when Excel opens, an opt-out is left alone, and a dead share fails quickly. |

## Building and releasing

[`agent-instructions/excel-addin-build-and-release.md`](../agent-instructions/excel-addin-build-and-release.md)
owns the procedure. `tools/build_xlam.ps1` builds the beta add-in;
`tools/release_xlam.ps1` publishes `ArcRho.xlam` to the share, where every user
picks it up on the next Excel launch. The release can only be run from the clone
on the ArcRho Server, because the beta workbook and the VBA signature files exist
only there.
