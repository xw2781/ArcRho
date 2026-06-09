# Project Registry And Source Table Lookup

## Canonical Files

Project discovery and source table lookup are intentionally split:

| File | Owner | Purpose |
| --- | --- | --- |
| `projects/index.json` | Frontend/project registry | Lists project names and their virtual UI folders. It does not store source CSV paths. |
| `projects/<ProjectName>/field_mapping.json` | Project settings and data-engine | Stores the project source CSV `table_path` plus field mapping rows. |

## `projects/index.json`

The project index is a UI/project-discovery registry:

```json
{
  "version": 1,
  "projects": [
    {
      "name": "NJ_Annual_Prod_202605_Fake",
      "folder": "Fake Project"
    }
  ],
  "folders": [
    {
      "name": "Fake Project",
      "path": "Fake Project",
      "parent": ""
    }
  ]
}
```

`folder` is a virtual folder path shown in the UI. It is not a Windows file-system path.

## Data-Engine Lookup

Data-engine does not read `projects/index.json` for source table paths. For a request with `ProjectName`, it resolves:

`projects/<ProjectName>/field_mapping.json`

and reads `table_path` from that file. If the project folder, `field_mapping.json`, or `table_path` is missing, the request is invalid.

