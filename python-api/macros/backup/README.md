# ArcRho Macro Backups

This directory stores immutable prior versions of source-controlled ArcRho macros under `python-api/macros`.

Archive each superseded macro at:

```text
backup/<macro-file-stem>/<version>/<macro-file-name>
```

Copy the complete prior file before editing the active macro. Keep its original
`Version` and `Release Note` metadata unchanged. Backup files are historical records,
not active macros, and must not be copied to the user macro directory.
