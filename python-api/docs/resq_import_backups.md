# The backup taken before a ResQ import

`Import ResQ Reserving Class` and `Import ResQ Reserving Classes` rewrite the
reserving class they import. Both policies do: `overwrite` lets the fresh ResQ
copy win every conflict, and `merge` still rewrites everything ResQ supplies a
newer copy of. Before either macro publishes its Bridge request, it copies the
class aside, so a class can be put back the way it was after an import that
turned out wrong.

The Bridge takes its own copy during the commit
(`resq_import_runner._commit_staged_rc`), but that one exists only to undo a
commit that fails part way and is deleted as soon as the commit succeeds. The
macro's copy is the one a later recovery reads.

## Where the copies live

```text
<ArcRho Server>\backups\pre-import\<project>\<reserving-class folder>\<YYYYMMDD-HHMMSS>\
    backup.json
    index.json
    methods\
    sidecars\
    datasets\
```

The copy keeps the class's own folder layout, so restoring it is a plain folder
copy rather than a sorting exercise.

The backup folder sits beside the `projects` tree rather than inside it, for two
reasons: duplicating a project never drags its backups along, and nothing that
walks a project's `data` folder can mistake a backup for a reserving class.

`<reserving-class folder>` is the same encoded folder name the class uses under
`projects\<project>\data`, so a backup is easy to match to its class by eye.
The macro finds that folder by the encoded name first, then by decoding each
folder's own name, and only then by the class path a folder reports in its
`index.json` — the last step reads every index in the project, which is why it
comes last.

`backup.json` names the project, the reserving class, the source folder, the
person, the import policy, every file copied, and how many engine-generated
datasets were left out.

## What is copied

- **Every method file** — every file in the class's `methods` folder, whatever
  the method type.
- **Every dataset except an engine-generated one** — the sidecar and the data
  file it names, for input, calculated and method-output datasets alike. A
  restored class therefore reads as it did without waiting for a refresh.
- **A data file no sidecar claims** — an unidentifiable file is exactly the one
  worth keeping.
- **The class index**, so the restored folder is immediately consistent.

## What is left out

Engine-generated datasets, meaning those whose sidecar records
`source_kind: "engine"`. ArcRho rebuilds these from the source warehouse
whenever the class is refreshed, and they are the bulk of a class: for a typical
reserving class they are around 67 of 126 datasets, so leaving them out roughly
halves the file count for nothing recoverable.

The sidecar is the authority here. It records the kind ArcRho settled on for
that dataset when it was written, so the backup reads the decision off the class
rather than working it out again from `dataset_types.json`.

## Cost

A whole class measured 155 files and 0.34 MB, copied in 0.42 seconds across the
share. Nothing to copy — a class the project has no folder for yet, or a folder
holding only engine-generated datasets — is reported as no backup rather than an
empty one.

## Retention

The twenty most recent backups of one reserving class are kept
(`IMPORT_BACKUP_KEEP_PER_CLASS`); older ones are deleted as each new backup is
taken.

## When a backup cannot be written

A backup that fails does not stop the import. Refusing to import would leave
the person worse off than they were before there were backups at all, so the
run continues and the completion box says, as a warning that does not close on
its own, that there is no restore point. The batch macro names each class whose
copy failed.

## Restoring

Copy `methods`, `sidecars`, `datasets` and `index.json` from one timestamped
folder back over `projects\<project>\data\<reserving-class folder>`, leaving
`backup.json` behind, then reload the dataset table in the Project Instance
page. The engine-generated datasets already in place are untouched by the
restore, which is what makes it safe to leave them out of the copy.
