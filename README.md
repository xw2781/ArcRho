# ArcRho

ArcRho is an actuarial data automation platform focused on loss reserving analytics, with an emphasis on streamlining the end-to-end data preparation pipeline.
It provides a structured framework for transforming raw insurance loss data into reproducible reserving workflows — eliminating manual data handling, accelerating turnaround, and giving actuaries full transparency and control over their assumptions.

## Background & Motivation

Reserving teams face shifting claims patterns, extraordinary loss events, and rapid operational changes, but their tools often lag behind. Workflows still rely on rigid vendor platforms, Excel worksheets, and manual handoffs.

The core problem is structural: traditional project hierarchies require pre-computing datasets, store thousands of rarely used outputs, and need manual updates when coverage or company structures change.

ArcRho replaces that model with on-demand queries against analytics-ready source data, exposed through familiar Excel formulas. It reduces manual transfer, removes vendor dependency, and helps reserving teams respond faster.

## Modernized Web UI for a Seamless User Experience
The images below are illustrative UI demos with sample data.

![ArcRho development curves demo](./assets/images/UI_Plots.png)

ArcRho's web UI gives actuaries a flexible workspace for customizing, retrieving, and reviewing triangle datasets without rebuilding a project structure. Users can pull any configured dataset at the level or segment they need, switch assumptions quickly, and use multiple built-in visualization presets to inspect trends, compare patterns, and validate selections before moving deeper into the analysis.

## A New Way to Work with Reserving Methods
![Development factor method demo](./assets/images/UI_ChainLadder.png)

ArcRho keeps familiar actuarial methods at the center, then equips them with modern, user-friendly tools that make method review faster and more transparent. The goal is not only to provide accurate data, but to help actuaries reach more accurate insights through clearer assumptions, easier interaction, and more productive review workflows.

## Versioned Reserving Methods with Built-in Controls
![DFM version comparison](./assets/images/version_control.png)

Method Version Compare helps teams review any two historical versions of a chain-ladder method before adopting changes. The comparison view highlights which version is newer, shows side-by-side snapshots of ratio selections, formulas, and notes, and lets users choose which version to keep. This gives actuaries a clear review step before overwriting assumptions, reducing accidental drift while keeping collaboration fast.

## Trace Dependencies in Project Instance

![Project Instance dependency graph demo](./assets/images/UI_PI_DependencyGraph.png)

The Project Instance (PI) dependency graph shows how datasets feed calculations, reserving methods, and result selections within a reserving class. Select a node to highlight its upstream inputs in blue and downstream dependents in green. Search for a dataset, pan and zoom through the graph, or double-click a node to open its dataset or method. Review indicators help identify objects that need attention.

---

## Data Processing Engine

ArcRho replaces the traditional vendor-based reserving database with a lightweight, local computation engine that queries flat CSV source tables on demand, builds loss triangles in memory, and returns results directly to Excel — with no pre-computation, no rigid project hierarchy, and no lengthy load times.

### Architecture Overview

```mermaid
flowchart LR
    subgraph Excel["Excel · VBA"]
        A[UDF Call\nArcRhoTri · ArcRhoVec]
    end

    subgraph Engine["ArcRho Engine · Python"]
        B[Watchdog\nFile Listener] --> C[Parse Request\nProject · Path · Dataset] --> D[(In-Memory Cache\nData + Config)] --> E[Build Triangle\nFilter · Pivot] --> F[Formula Engine]
        subgraph Store["Local Storage"]
            K[(CSV\nSource Data)] ~~~ L[(JSON\nConfig)]
        end
        D -.->|cache miss| Store
    end

    A -->|"① request"| B
    F -->|"② result"| A
```

### How It Works

**1. Send a request from the frontend**
Users call ArcRho functions directly in Excel or the ArcRho desktop app, such as `=ArcRhoTri(...)`, to get a loss triangle dataset. Each request tells ArcRho which project, reserving class, and dataset to retrieve.

**2. Find the right data**
ArcRho reads the project setup, filters the source data to the requested segment, and uses the configured dataset definitions to determine what should be returned.

**3. Build the result on demand**
Instead of pre-building thousands of triangles, ArcRho constructs only the triangle or vector needed for the current request. Frequently used data stays warm in memory so repeated requests are fast.

---

### Advantages Over Traditional Reserving Databases

| | ArcRho | Traditional Vendor Platform |
|---|---|---|
| **Data structure** | Normalized grain-level fact table | Fixed hierarchical project tree |
| **Project setup** | Edit JSON config files | Rebuild project hierarchy in GUI |
| **Computation model** | On-demand, per request | Pre-compute all datasets before access |
| **Storage footprint** | Only source data stored | 10,000+ pre-computed datasets per project |
| **New class / coverage** | Update JSON, request resolves immediately | Manual intervention to fix aggregation dependencies |
| **Custom aggregations** | Define in `reserving_class_types.json` at any time | Requires project rebuild |
| **Excel integration** | Drop-in VBA functions matching existing syntax | Vendor-bundled Excel Add-In |
| **Infrastructure** | Runs locally on any machine | Depends on remote server / vendor application |

---

## Excel Add-in

The ArcRho Excel Add-in exposes the data processing engine directly inside Excel through a set of worksheet functions (UDFs) and a custom **ArcRho** ribbon tab. Actuaries work entirely within familiar Excel workflows — no scripting, no vendor GUI — while the Python data engine handles all data retrieval and triangle construction transparently.

### Ribbon

<img src="./assets/images/addin_ribbon_v2.png" alt="ArcRho Excel ribbon demo" width="1000"/>

The **ArcRho** ribbon tab provides quick-access shortcuts for the two most common setup actions before calling any formula:

| Button | Purpose |
|---|---|
| **Load Reserving Classes** | Opens a dialog to select and confirm a reserving class path (e.g. `PRNJ-PA\PA\All States\All Channels\PD+UMPD`) |
| **Select Datasets** | Opens a searchable list of all available datasets for the active project |
| **Insert Function** | Inserts a UDF template into the active cell |
| **Clear Formulas** | Removes all ArcRho formulas from the active sheet |
| **Calculate Workbook** | Forces a full recalculation |
| **Refresh Database** | Reloads the source data cache on the data engine |

### Step 1 — Select a Reserving Class Path

<img src="./assets/images/addin_load_classes.png" alt="Reserving class selection demo" width="800"/>

Click **Load Reserving Classes** in the ribbon. The dialog presents a cascading set of dropdowns corresponding to the reserving class hierarchy (Company → Product → State → Channel → IBNR Category). Each selection narrows the next level. The resulting path string (shown at the bottom of the dialog) is what you pass as the `Path` argument to any UDF.

### Step 2 — Select a Dataset

<img src="./assets/images/addin_ribbon_datasets.png" alt="Select Datasets ribbon command demo" width="480"/>
<img src="./assets/images/addin_load_datasets.png" alt="Dataset selection demo" width="560"/>

Click **Select Datasets** to browse all datasets defined for the active project. Results can be filtered by name, category, or data format. The selected dataset name maps directly to the `TriangleName` / `VectorName` argument in the formulas below.

---

### UDF Reference

All functions use the `ArcRho` prefix.

| Function | Category | Description | Arguments |
|---|---|---|---|
| `ArcRhoTri` | Triangle | Returns a full loss triangle as a spilled array | `Path`, `TriangleName`, `[Cumulative]`, `[Transposed]`, `[Calendar]`, `[ProjectName]`, `[OriginLength]`, `[DevelopmentLength]` |
| `ArcRhoTriDiag` | Triangle | Extracts a single diagonal. `DiagonalIndex = 0` = latest; negative values step back | `Path`, `TriangleName`, `[DiagonalIndex]`, `[Cumulative]`, `[Transposed]`, `[ProjectName]`, `[OriginLength]`, `[DevelopmentLength]` |
| `ArcRhoTriOrigin` | Triangle | Returns one origin-period row across all development ages | `Path`, `TriangleName`, `OriginPeriod`, `[Cumulative]`, `[Transposed]`, `[ProjectName]`, `[OriginLength]`, `[DevelopmentLength]` |
| `ArcRhoTriCell` | Triangle | Returns a single scalar cell at a specified origin and development position | `Path`, `TriangleName`, `OriginPeriod`, `DevelopmentPeriod`, `[Cumulative]`, `[ProjectName]`, `[OriginLength]`, `[DevelopmentLength]` |
| `ArcRhoVec` | Vector | Returns a one-dimensional origin-period vector (e.g. earned exposure, premium) | `Path`, `VectorName`, `[Transposed]`, `[ProjectName]`, `[PeriodLength]` |
| `ArcRhoVecCell` | Vector | Returns a single element from a vector by 1-based index | `Path`, `VectorName`, `Index`, `[ProjectName]`, `[PeriodLength]` |
| `ArcRhoHeaders` | Utility | Returns axis labels for triangle headers. `periodType = 0` = origin labels; `1` = development age labels | `periodType`, `Transposed`, `[PeriodLength]`, `[ProjectName]` |
| `ArcRhoProjectSettings` | Utility | Returns project metadata: name, origin type, start/end dates, development end date, period lengths | `[ProjectName]` |
