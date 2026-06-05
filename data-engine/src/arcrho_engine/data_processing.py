import os
import sys
import json
import numpy as np
import calendar
import threading
from pathlib import Path
from threading import Lock
from datetime import date, datetime

# Resolve packaged, deployed src layout, and repo src layout.
_MODULE_ROOT = Path(__file__).resolve().parent
_SOURCE_ROOT = _MODULE_ROOT.parent
_PRODUCT_ROOT = _SOURCE_ROOT.parent
_BUNDLE_ROOT = Path(getattr(sys, "_MEIPASS", _MODULE_ROOT)).resolve()
_EXE_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else None
_DEPLOY_ROOT = Path(os.environ.get("ARCRHO_DEPLOY_ROOT", r"E:\ArcRho Server"))

if "ARCRHO_ROOT" not in os.environ and "ADAS_ROOT" not in os.environ:
    if _EXE_DIR and _EXE_DIR.name.lower() == "apps":
        os.environ["ARCRHO_ROOT"] = str(_EXE_DIR.parent)
    elif _EXE_DIR and _EXE_DIR.parent.name.lower() == "apps":
        os.environ["ARCRHO_ROOT"] = str(_EXE_DIR.parent.parent)
    elif not getattr(sys, "frozen", False):
        os.environ["ARCRHO_ROOT"] = str(_DEPLOY_ROOT)

for _path in (_PRODUCT_ROOT, _SOURCE_ROOT, _BUNDLE_ROOT):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

import pandas as pd
from utils import (
    function_brand,
    get_project_root,
    is_vector_function,
    resolve_app_path,
)
from arcrho_engine.general_utils import (
    DLOOKUP,
    _generate_period_range,
    _parse_date_to_yyyymm,
    get_current_time,
    split_formula,
    split_formula_opts,
    write_lists_to_csv,
)

debug_mode = 0
device_name = os.environ.get("COMPUTERNAME")
project_map_path = str(get_project_root() / "projects" / "map.json")
ts = datetime.now().strftime("%y%m%d-%H%M%S-%f")[:-3]
robot_id =  f'{device_name}@' + os.getlogin() + "@" + ts
id_folder = str(resolve_app_path("engine", "instances"))
id_path = str(Path(id_folder) / f"{robot_id}.json")


BASE_DICT = {}  # Base Settings Table
PROJECT_CONFIG = {}   # Project configuration (Source Table, Dataset Types, Reserving Class Types)
DATA_DICT = {}  # CSV Data Table Files
DATA_DICT_LOCK = Lock() # for atomic swap
PROJECT_CONFIG_LOCK = Lock()
BASE_DICT_LOCK = Lock()
DATA_DICT_LOAD_ORDER = []  # Track load order for oldest removal

# Cache for project-specific settings to avoid repeated file reads
PROJECT_SETTINGS_CACHE = {}


class ProjectSettingsError(RuntimeError):
    """Raised when required project settings are missing or invalid."""


def remove_old_instances():
    folder = Path(id_folder)
    if not folder.exists():
        return
    for f in folder.iterdir():
        if f.is_file():
            is_instance_file = f.suffix.lower() in {".json", ".txt"}
            modified_date = datetime.fromtimestamp(f.stat().st_mtime).date()
            if is_instance_file and modified_date < date.today():
                f.unlink()


def _load_project_settings(project_name, df=None, date_cols=None):
    """
    Load required project-specific settings from general_settings.json.
    Uses cache to avoid repeated file reads.

    Args:
        project_name: Name of the project
        df: Optional DataFrame used only to detect date granularity
        date_cols: Optional list of [origin_date_col, dev_date_col] names

    Returns:
        Dictionary with keys: origin_start, origin_end, dev_end (all in YYYYMM format)

    Raises:
        ProjectSettingsError: If general_settings.json is missing, invalid, or missing
            origin_start_date, origin_end_date, or development_end_date.
    """
    # Build path to project settings file
    settings_path = get_project_root() / "projects" / project_name / "general_settings.json"

    # Check cache: reuse if file hasn't been modified since last load
    if project_name in PROJECT_SETTINGS_CACHE:
        cached = PROJECT_SETTINGS_CACHE[project_name]
        if settings_path.exists():
            current_mtime = os.path.getmtime(settings_path)
            if cached.get('_mtime') == current_mtime:
                return cached
        else:
            PROJECT_SETTINGS_CACHE.pop(project_name, None)

    if not settings_path.exists():
        raise ProjectSettingsError(f"Project settings not defined for [{project_name}]")

    required_fields = {
        'origin_start_date': 'origin_start',
        'origin_end_date': 'origin_end',
        'development_end_date': 'dev_end',
    }

    try:
        with open(settings_path, mode="r", encoding="utf-8") as f:
            json_data = json.load(f)

        missing_fields = [
            field for field in required_fields
            if field not in json_data or str(json_data[field]).strip() == ''
        ]
        if missing_fields:
            raise ProjectSettingsError(
                f"Project settings not defined for [{project_name}]: missing {', '.join(missing_fields)}"
            )

        settings = {
            setting_key: _parse_date_to_yyyymm(json_data[field])
            for field, setting_key in required_fields.items()
        }

        print(f"Loaded settings from JSON for [{project_name}]: origin {settings['origin_start']}-{settings['origin_end']}, dev_end {settings['dev_end']}")
    except ProjectSettingsError:
        raise
    except Exception as e:
        raise ProjectSettingsError(f"Project settings not defined for [{project_name}]: {e}") from e

    # Detect date granularity from actual data column
    if df is not None and date_cols is not None:
        try:
            sample_val = int(df[date_cols[0]].dropna().iloc[0])
            settings['date_granularity'] = 'annual' if len(str(sample_val)) == 4 else 'monthly'
        except Exception:
            settings['date_granularity'] = 'monthly'
    else:
        settings['date_granularity'] = 'monthly'

    # Cache the settings along with file mtime for staleness detection
    if settings_path.exists():
        settings['_mtime'] = os.path.getmtime(settings_path)
    PROJECT_SETTINGS_CACHE[project_name] = settings

    return settings


def _enforce_data_dict_limit(max_tables=10):
    """
    Enforce the max table limit in DATA_DICT.
    Remove the oldest table if count >= max_tables before adding a new one.
    Should be called BEFORE adding a new table while holding DATA_DICT_LOCK.
    """
    # Count actual dataframes (exclude " - Version" entries)
    table_count = sum(1 for key in DATA_DICT.keys() if not key.endswith(" - Version"))

    if table_count >= max_tables:
        # Find oldest table from load order
        if DATA_DICT_LOAD_ORDER:
            oldest_table = DATA_DICT_LOAD_ORDER.pop(0)
            if oldest_table in DATA_DICT:
                del DATA_DICT[oldest_table]
            if oldest_table + " - Version" in DATA_DICT:
                del DATA_DICT[oldest_table + " - Version"]
            print(f"Removed oldest table from cache: {oldest_table}")


def load_BASE_DICT():
    with open(project_map_path, mode="r", encoding="utf-8") as f:
        project_mapping = json.load(f)

    virtual_projects = project_mapping.get("Virtual Projects")
    if virtual_projects is None:
        raise KeyError("Missing 'Virtual Projects' in project mapping JSON.")

    if isinstance(virtual_projects, dict) and "headers" in virtual_projects and "rows" in virtual_projects:
        headers = virtual_projects.get("headers", [])
        rows = virtual_projects.get("rows", [])
        team_profile_df = pd.DataFrame(rows, columns=headers)
    else:
        # Fallback for list/dict-of-records JSON shapes.
        team_profile_df = pd.DataFrame(virtual_projects)

    BASE_DICT['Project Map'] = team_profile_df.fillna('')
    BASE_DICT['Project Map - Version'] = datetime.now()


def _project_json_paths(project_name):
    project_dir = get_project_root() / "projects" / project_name
    return {
        "source_table": project_dir / "field_mapping.json",
        "dataset_types": project_dir / "dataset_types.json",
        "reserving_class_types": project_dir / "reserving_class_types.json",
    }


def _read_json(json_path):
    with open(json_path, mode="r", encoding="utf-8") as f:
        return json.load(f)


def _json_table_to_df(json_obj):
    if isinstance(json_obj, dict) and "columns" in json_obj and "rows" in json_obj:
        return pd.DataFrame(json_obj.get("rows", []), columns=json_obj.get("columns", [])).fillna('')
    return pd.DataFrame(json_obj).fillna('')


def _source_table_df_from_json(json_obj):
    rows = json_obj.get("rows", []) if isinstance(json_obj, dict) else json_obj
    normalized_rows = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        normalized_rows.append({
            "Column Name": row.get("field_name", ""),
            "Significances": row.get("significance", ""),
            "Level": row.get("level", ""),
        })
    return pd.DataFrame(normalized_rows, columns=["Column Name", "Significances", "Level"]).fillna('')


def _get_vps_last_modified_time(project_name):
    json_paths = _project_json_paths(project_name)
    missing = [str(path) for path in json_paths.values() if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing project JSON file(s): {', '.join(missing)}")
    return max(datetime.fromtimestamp(path.stat().st_mtime) for path in json_paths.values())


def load_to_PROJECT_CONFIG(project_name, settings_file=None):
    json_paths = _project_json_paths(project_name)
    print(f"Loading JSON settings for [{project_name}] @ {get_current_time()}")

    source_table_json = _read_json(json_paths["source_table"])
    dataset_types_json = _read_json(json_paths["dataset_types"])
    reserving_class_types_json = _read_json(json_paths["reserving_class_types"])

    PROJECT_CONFIG[project_name] = {}
    PROJECT_CONFIG[project_name]["Source Table"] = _source_table_df_from_json(source_table_json)
    PROJECT_CONFIG[project_name]["Dataset Types"] = _json_table_to_df(dataset_types_json)
    PROJECT_CONFIG[project_name]["Reserving Class Types"] = _json_table_to_df(reserving_class_types_json)
    PROJECT_CONFIG[project_name + " - Version"] = _get_vps_last_modified_time(project_name)


def load_to_DATA_DICT(csv_path):
    print(f"Loading Data Table {csv_path} @ {get_current_time()}")
    key = os.path.basename(csv_path)
    _enforce_data_dict_limit(max_tables=10)
    DATA_DICT[key] = pd.read_csv(csv_path)
    DATA_DICT[key + " - Version"] = datetime.now()
    if key not in DATA_DICT_LOAD_ORDER:
        DATA_DICT_LOAD_ORDER.append(key)
    print(f"Data Table Loaded @ {get_current_time()}")


def load_dataframe(data_csv_path):
    '''
    Add a new table to DATA_DICT
    '''
    print(get_current_time())
    print(f'Loading Data Table -- [{os.path.basename(data_csv_path)}]')
    df = pd.read_csv(data_csv_path) # build off-thread
    with DATA_DICT_LOCK:
        key = os.path.basename(data_csv_path).replace('.csv', '')
        _enforce_data_dict_limit(max_tables=10)
        DATA_DICT[key] = df
        if key not in DATA_DICT_LOAD_ORDER:
            DATA_DICT_LOAD_ORDER.append(key)

    print(get_current_time())
    print(f'Data Table Loaded -- [{os.path.basename(data_csv_path)}]')


def load_dataframe_in_thread(data_csv_path):
    t = threading.Thread(target=load_dataframe, args=(data_csv_path,), daemon=True)
    t.start()


def _calc_age(acc_yrmo, sys_yrmo):
    # Detect format by digit count: 4 digits = YYYY (annual), 6 digits = YYYYMM (monthly)
    if len(str(int(acc_yrmo))) == 4:  # YYYY annual format
        return (int(sys_yrmo) - int(acc_yrmo)) * 12 + 1
    # YYYYMM monthly format (original logic)
    acc_yr = acc_yrmo//100
    sys_yr = sys_yrmo//100
    acc_mo = acc_yrmo % 100
    sys_mo = sys_yrmo % 100

    return 12*(sys_yr-acc_yr) + sys_mo-acc_mo + 1


def _get_org_label(date_val, org_len):
    # Detect format by digit count: 4 digits = YYYY (annual), 6 digits = YYYYMM (monthly)
    if len(str(int(date_val))) == 4:  # YYYY annual format
        return int(date_val)  # org_len==12 is always the case for annual data

    # YYYYMM monthly format (original logic)
    yyyymm = date_val
    year = int(yyyymm // 100)
    month = int(yyyymm % 100)

    if org_len == 1:
        return yyyymm
        # return "'" + datetime.strptime(str(yyyymm), "%Y%m").strftime("%b %Y")

    elif org_len == 3:
        return f"{year} Q{(month+2)//3}"
    elif org_len == 6:
        return f"{year} H{(month+5)//6}"
    elif org_len == 12:
        return year


def _request_bool(value, default=False):
    if isinstance(value, bool):
        return value
    text = str(value if value is not None else "").strip().lower()
    if text in {"true", "yes", "1"}:
        return True
    if text in {"false", "no", "0"}:
        return False
    return default


def _as_month_period(value):
    n = int(value)
    if len(str(n)) == 4:
        return n * 100 + 1
    return n


def _add_months(yyyymm, months):
    year = int(yyyymm) // 100
    month = int(yyyymm) % 100
    total = year * 12 + (month - 1) + int(months)
    return (total // 12) * 100 + (total % 12) + 1


def _month_period_label(start_yyyymm, end_yyyymm):
    start = int(start_yyyymm)
    end = int(end_yyyymm)
    return f"{start % 100:02d}/{start // 100 % 100:02d} - {end % 100:02d}/{end // 100 % 100:02d}"


def _development_age_labels(project_settings, dev_len):
    acc_yrmo_all = _generate_period_range(
        project_settings['origin_start'], project_settings['origin_end'],
        project_settings.get('date_granularity', 'monthly'))
    is_annual = project_settings.get('date_granularity') == 'annual'
    dev_cnt = len(acc_yrmo_all) if is_annual else round(len(acc_yrmo_all)/dev_len)
    first_mon = int(project_settings['dev_end'] % 100)

    dev_label = list(range(first_mon, dev_cnt*dev_len+1, dev_len))
    for i in range(1, 999):
        prior_mon = first_mon - dev_len*i
        if prior_mon > 0:
            dev_label = [prior_mon] + dev_label
        else:
            break
    return dev_label


def _calendar_periods_from_dev_labels(project_settings, dev_label):
    origin_start = _as_month_period(project_settings['origin_start'])
    periods = []
    prior_end = None
    for age in dev_label:
        end_period = _add_months(origin_start, int(age) - 1)
        start_period = origin_start if prior_end is None else _add_months(prior_end, 1)
        periods.append({
            "start": start_period,
            "end": end_period,
            "label": _month_period_label(start_period, end_period),
        })
        prior_end = end_period
    return periods


def _reshape_triangle_to_calendar(df, org_index_grp, dev_label, project_settings):
    calendar_periods = _calendar_periods_from_dev_labels(project_settings, dev_label)
    calendar_labels = [period["label"] for period in calendar_periods]
    end_to_col = {period["end"]: idx for idx, period in enumerate(calendar_periods)}
    out = pd.DataFrame(np.nan, index=df.index, columns=calendar_labels)

    for row_idx, group in enumerate(org_index_grp):
        if row_idx >= len(df.index) or not group:
            continue
        origin_start = _as_month_period(group[0])
        for dev_age in dev_label:
            if dev_age not in df.columns:
                continue
            value = df.iat[row_idx, df.columns.get_loc(dev_age)]
            if pd.isna(value):
                continue
            dev_end = _add_months(origin_start, int(dev_age) - 1)
            col_idx = end_to_col.get(dev_end)
            if col_idx is None:
                continue
            out.iat[row_idx, col_idx] = value
    return out


def vector_to_triangle(df: pd.Series | pd.DataFrame, colnames=None) -> pd.DataFrame:
    """
    Convert a vector (Series or 1-col DataFrame) to a triangle DataFrame.
    If the input is already square (n×n), return it unchanged.
    
    colnames: optional list/Index to use as column names.
              If None, defaults to using the row index.
    """
    # Case 1: Already a square DataFrame → do nothing
    if isinstance(df, pd.DataFrame) and df.shape[0] == df.shape[1]:
        return df

    # Convert to Series for uniform processing
    if isinstance(df, pd.DataFrame):
        if df.shape[1] != 1:
            raise ValueError("DataFrame must have exactly one column or be square.")
        s = df.iloc[:, 0]
    elif isinstance(df, pd.Series):
        s = df
    else:
        raise TypeError("Input must be a pandas Series or 1-column DataFrame.")

    # Default column names = index
    if colnames is None:
        colnames = s.index
    else:
        # if len(colnames) != len(s): raise ValueError("Length of colnames must match length of vector.")
        pass

    # Expand vector → row-constant matrix
    idx = s.index
    arr = np.repeat(s.values.reshape(-1, 1), len(colnames), axis=1)

    return pd.DataFrame(arr, index=idx, columns=colnames, dtype=float)


def eval_triangle_formula(triangles: dict[str, pd.DataFrame],
                          formula: str,
                          div0_to_zero: bool = True) -> pd.DataFrame:
    """
    triangles: dict like {'A': tri_A, 'B': tri_B, ...} where each value is a pivoted DF
    formula:   e.g. 'D = A/B*1000' or 'A/B*1000' or 'A + B*C'
    div0_to_zero: if True, convert inf/NaN from division-by-zero to 0
    """
    # allow 'D = A/B*1000' or just 'A/B*1000'
    rhs = formula.split('=', 1)[-1].strip()

    # safety: no builtins; variables come from triangles dict
    env = {"__builtins__": {}}

    # element-wise eval; pandas aligns on index & columns automatically
    result = eval(rhs, env, triangles)

    if div0_to_zero:
        result = result.replace([np.inf, -np.inf], np.nan).fillna(0)

    # ensure numeric dtype (optional)
    return result.astype(float)


def _get_df(project_name):
    table_path = DLOOKUP(BASE_DICT['Project Map'], project_name, 'Project Name', 'Table Path')
    table_name = os.path.basename(table_path)

    # DATA table cache (guarded)
    with DATA_DICT_LOCK:
        need_load = (table_name not in DATA_DICT) or (DATA_DICT.get(table_name + " - Version") is None) \
                    or (DATA_DICT[table_name + " - Version"] < datetime.fromtimestamp(os.path.getmtime(table_path)))

    if need_load:
        # build outside lock if you want, but simplest is just load here
        with DATA_DICT_LOCK:
            load_to_DATA_DICT(table_path)

    # VPS cache (guarded)
    with PROJECT_CONFIG_LOCK:
        if project_name not in PROJECT_CONFIG:
            load_to_PROJECT_CONFIG(project_name)

    return DATA_DICT[table_name]


def _get_dataset_info(arg):
    # This apply to both vector and triangle
    project_name = arg['ProjectName']
    path = arg['Path']
    dataset_name = arg['DatasetName']

    df = _get_df(project_name)

    # Set user defined name (ResQ) to actual SQL table col names
    df_info = PROJECT_CONFIG[project_name]['Dataset Types']
    
    if dataset_name in df_info['Name'].values:
        source = df_info.loc[df_info['Name'] == dataset_name, 'Source'].iloc[0]
    else:
        write_lists_to_csv(arg['DataPath'], [[f'(dataset name not defined: {dataset_name})']])
        return
    
    output_data_format = df_info.loc[df_info['Name'] == dataset_name, 'Data Format'].iloc[0]

    # find all required table and column names
    df_info = PROJECT_CONFIG[project_name]['Source Table']
    required_datasets = split_formula(source)
    rsv_cls_col_names = df_info.loc[df_info['Significances'].isin(['Reserving Class']), 'Column Name'].unique().tolist()

    date_cols = []
    date_cols.append(DLOOKUP(df_info, 'Origin Date', 'Significances', 'Column Name'))
    date_cols.append(DLOOKUP(df_info, 'Development Date', 'Significances', 'Column Name'))

    # Load project-specific date settings (with fallback to data-derived values)
    project_settings = _load_project_settings(project_name, df, date_cols)
    max_sys_yrmo = project_settings['dev_end']

    required_datasets = [c for c in required_datasets if c in df.columns]  # remove invalid dataset names
    required_datasets = list(set(required_datasets))                       # remove duplicates

    # determine the categorical values need to be included/adjusted in the calculation
    df_info = PROJECT_CONFIG[project_name]['Reserving Class Types']
    name_lookup = {str(v).lower(): v for v in df_info['Name'].dropna()}
    splited_path = path.split('\\')
    included_rsv_cls_types = []  # use original value
    excluded_rsv_cls_types = []  # use negative value
    adjusted_rsv_cls_types = []  # change values to zero for EEX calculations

    level = 1
    for rsv_cls_type in splited_path:  # loop through N levels of reserving class
        if level > len(rsv_cls_col_names):
            break
        rsv_cls_type = name_lookup[rsv_cls_type.lower()]
        # print(f"Processing RSV CLS Type [{rsv_cls_type}] at Level {level} for dataset [{dataset_name}]")
        included_rsv_cls_types.append([])
        excluded_rsv_cls_types.append([])
        adjusted_rsv_cls_types.append([])

        if rsv_cls_type in df_info['Name'].values:
            included_rsv_cls_types[level-1].append(rsv_cls_type) # always include the input value itself
            # Also include Source-derived values for data matching (handles name aliases like "New" -> "N")
            type_source = df_info.loc[df_info['Name'] == rsv_cls_type, 'Source'].iloc[0]
            if type_source != '':
                src_names = split_formula(type_source)
                # print(f"  Source for [{rsv_cls_type}]: {src_names}")
                src_opts = split_formula_opts(type_source)
                for si in range(len(src_names)):
                    if src_opts[si] == '-' and src_names[si] not in excluded_rsv_cls_types[level-1]:
                        excluded_rsv_cls_types[level-1].append(src_names[si])
                    if src_names[si] not in included_rsv_cls_types[level-1]:
                        included_rsv_cls_types[level-1].append(src_names[si])

            formula     = df_info.loc[df_info['Name'] == rsv_cls_type, 'Formula'].iloc[0]
            # Safely access EEX Formula column — handle missing column or empty result
            eex_formula = ''
            if 'EEX Formula' in df_info.columns:
                result = df_info.loc[df_info['Name'] == rsv_cls_type, 'EEX Formula']
                if not result.empty:
                    eex_formula = result.iloc[0]

            if formula == '':
                pass
            else:
                if eex_formula != '':
                    # Adjusted = all members at this level NOT in eex_formula (not dependent on formula)
                    all_members = df_info[df_info['Level'] == str(level)]['Name'].tolist()
                    adjusted_rsv_cls_types_level_x = list(set(all_members) - set(split_formula(eex_formula)))
                    adjusted_rsv_cls_types[level-1] = adjusted_rsv_cls_types_level_x

                name_list = split_formula(formula)
                opts_list = split_formula_opts(formula)

                for i in range(len(name_list)):
                    name = name_list[i]
                    opt = opts_list[i]
                    if opt == '-':
                        excluded_rsv_cls_types[level-1].append(name)
                    included_rsv_cls_types[level-1].append(name)
        elif rsv_cls_type == '':
            pass
        else: 
            write_lists_to_csv(arg['DataPath'], [[f'(reserving class type not defined: {rsv_cls_type})']])
            # print(f"(reserving class type not defined: {rsv_cls_type})")
            return

        level += 1

    included_rsv_cls_types = [list(set(sublist)) for sublist in included_rsv_cls_types]
    excluded_rsv_cls_types = [list(set(sublist)) for sublist in excluded_rsv_cls_types]
    adjusted_rsv_cls_types = [list(set(sublist)) for sublist in adjusted_rsv_cls_types]

    return df, date_cols, required_datasets, rsv_cls_col_names, \
           included_rsv_cls_types, excluded_rsv_cls_types, adjusted_rsv_cls_types, \
           source, output_data_format, max_sys_yrmo


def UDF_ADASProjectSettings(arg):
    project_name = arg['ProjectName']
    df = _get_df(project_name)

    df_info = PROJECT_CONFIG[project_name]['Source Table']
    date_cols = []
    date_cols.append(DLOOKUP(df_info, 'Origin Date', 'Significances', 'Column Name'))
    date_cols.append(DLOOKUP(df_info, 'Development Date', 'Significances', 'Column Name'))

    # Load project-specific date settings (with fallback to data-derived values)
    project_settings = _load_project_settings(project_name, df, date_cols)
    origin_start = project_settings['origin_start']
    origin_end = project_settings['origin_end']
    dev_end = project_settings['dev_end']

    data_list = [
        ['Name', project_name], 
        ['Origin Type', 'Accident'], 
        ['Origin Start Date', date(origin_start // 100, origin_start % 100, 1)], 
        ['Origin End Date', date(origin_end // 100, origin_end % 100, calendar.monthrange(origin_end // 100, origin_end % 100)[1])], 
        ['Development End Date', date(dev_end // 100, dev_end % 100, calendar.monthrange(dev_end // 100, dev_end % 100)[1])], 
        ['Origin Length', 12], 
        ['Development Length', 12], 
        ['Folder', f'{function_brand(arg.get("Function"))} Virtual Project']
    ]
    write_lists_to_csv(arg['DataPath'], data_list)


def UDF_ADASHeaders(arg):
    # Calculate Age & Origin Labels
    project_name = arg['ProjectName']
    org_len = int(arg['PeriodLength'])
    dev_len = int(arg['PeriodLength'])
    period_type = int(arg['periodType'])
    calendar_mode = _request_bool(arg.get('Calendar'), False)

    df = _get_df(project_name)
    df_info = PROJECT_CONFIG[project_name]['Source Table']
    date_cols = []
    date_cols.append(DLOOKUP(df_info, 'Origin Date', 'Significances', 'Column Name'))
    date_cols.append(DLOOKUP(df_info, 'Development Date', 'Significances', 'Column Name'))

    # Load project-specific date settings (with fallback to data-derived values)
    project_settings = _load_project_settings(project_name, df, date_cols)

    if period_type == 0: # Origin Period

        # Generate period range from project configuration (handles both annual and monthly)
        acc_yrmo_all = _generate_period_range(
            project_settings['origin_start'], project_settings['origin_end'],
            project_settings.get('date_granularity', 'monthly'))
        # Compute slicing step: for annual, group by 1 year; for monthly, group by org_len months
        org_step = 1 if project_settings.get('date_granularity') == 'annual' else org_len
        org_index_grp = [tuple(acc_yrmo_all[i: i+org_step]) for i in range(0, len(acc_yrmo_all), org_step)]

        org_label = [_get_org_label(i[0], org_len) for i in org_index_grp]

        return write_lists_to_csv(arg['DataPath'], [org_label])
    
    elif period_type == 1: # Development Period

        if (dev_len == 'Default') or (org_len % dev_len != 0):
            dev_len = org_len

        dev_label = _development_age_labels(project_settings, dev_len)

        if calendar_mode:
            dev_label = [period["label"] for period in _calendar_periods_from_dev_labels(project_settings, dev_label)]
        else:
            dev_label = list(map(lambda x:f"{x}m", dev_label))
        return write_lists_to_csv(arg['DataPath'], [dev_label])
    
    else:
        return write_lists_to_csv(arg['DataPath'], [['(invalid input: periodType)']])


def _filter_main_table(df, date_cols, rsv_cls_col_names, included_rsv_cls_types, required_datasets):
    """
    df: original DataFrame
    rsv_cls_col_names: list of df column names, length N
    included_rsv_cls_types: list of lists (may include empty lists)
    required_datasets: list of other columns to keep

    If included_rsv_cls_types[i] is empty, no filtering is applied for that column.
    """

    # if len(rsv_cls_col_names) != len(included_rsv_cls_types):
    #     raise ValueError("Lengths of rsv_cls_col_names and included_rsv_cls_types must match.")

    fixed_levels = len(rsv_cls_col_names)
    input_levels = len(included_rsv_cls_types)

    if fixed_levels < input_levels:
        included_rsv_cls_types = included_rsv_cls_types[:len(rsv_cls_col_names)]
    elif fixed_levels > input_levels:
        included_rsv_cls_types = included_rsv_cls_types + [''] * (fixed_levels-input_levels)

    # Start with full mask
    mask = True

    # Add filters dynamically
    for col, allowed_values in zip(rsv_cls_col_names, included_rsv_cls_types):
        # If empty list → skip filter for this level
        if allowed_values:
            mask &= df[col].isin(allowed_values)

    # Build final column list (filter out empty date_cols when Development Date is not defined)
    cols = [c for c in date_cols if c != ''] + rsv_cls_col_names + required_datasets

    return df.loc[mask, cols]


def UDF_ADASTri(arg):
    org_len = arg['OriginLength']
    dev_len = arg['DevelopmentLength']
    cumulative = _request_bool(arg.get('Cumulative'), True)
    calendar_mode = _request_bool(arg.get('Calendar'), False)
    project_name = arg['ProjectName']

    # initialize
    if org_len == 'Default': org_len = 12

    # Get a subset dataframe based on a user's request
    df, date_cols, required_datasets, rsv_cls_col_names, \
    included_rsv_cls_types, excluded_rsv_cls_types, adjusted_rsv_cls_types, \
    source, output_data_format, max_sys_yrmo = _get_dataset_info(arg)

    # Load project-specific date settings (with fallback to data-derived values)
    # Note: _get_dataset_info already loads settings, but we reload here for local use
    project_settings = _load_project_settings(project_name, df, date_cols) 

    max_sys_month = max_sys_yrmo % 100

    df1 = _filter_main_table(df, date_cols, rsv_cls_col_names, included_rsv_cls_types, required_datasets)

    # Check if Development Date column is missing (optional when not in field_mapping)
    has_dev_date = date_cols[1] != '' and date_cols[1] in df1.columns
    if not has_dev_date:
        # Single-column triangle: set dev_len = 1 (unless explicitly set)
        if dev_len == 'Default' or dev_len == org_len:
            dev_len = 1

    # Row Adjustments (Excluded Values) -- multiply value by -1
    num_cols = df1.select_dtypes(include=[np.number]).columns
    dataset_cols = [col for col in num_cols if col not in date_cols]  # all numerical field need to be adjusted

    for i in range(len(excluded_rsv_cls_types)):
        excluded_rsv_cls_types_level_x = excluded_rsv_cls_types[i]
        if excluded_rsv_cls_types_level_x == []: 
            continue
        for value in excluded_rsv_cls_types_level_x:
            df1.loc[df1[rsv_cls_col_names[i]].isin([value]), dataset_cols] *= -1

    # Row Adjustments (EEX aggregation) -- set value to 0
    if 'Earned_Exposure' in required_datasets:
        adjusted_rsv_cls_types_level_x = adjusted_rsv_cls_types[4]  # level 5: IBNRCAT
        for value in adjusted_rsv_cls_types_level_x:
            df1.loc[df1[rsv_cls_col_names[4]].isin([value]), ['Earned_Exposure']] *= 0

    # Prepare for grouping by origin period and development age
    if (dev_len == 'Default') or (org_len % dev_len != 0):
        dev_len = org_len

    # Use project configuration to calculate development counts
    acc_yrmo_all = _generate_period_range(
        project_settings['origin_start'], project_settings['origin_end'],
        project_settings.get('date_granularity', 'monthly'))
    # Fix dev_cnt: for annual, number of periods = number of years; for monthly, divide by dev_len
    is_annual = project_settings.get('date_granularity') == 'annual'
    dev_cnt = len(acc_yrmo_all) if is_annual else round(len(acc_yrmo_all)/dev_len)
    first_mon = int(project_settings['dev_end'] % 100)

    # When Development Date is missing, use MMM YYYY format from dev_end config
    if not has_dev_date:
        dev_end = project_settings['dev_end']
        dev_year = dev_end // 100
        dev_month = dev_end % 100
        # Convert YYYYMM to MMM YYYY format (e.g., 202603 -> Mar 2026)
        import calendar
        month_abbr = calendar.month_abbr[dev_month]
        dev_label = [f"{month_abbr} {dev_year}"]
    else:
        dev_label = _development_age_labels(project_settings, dev_len)
    # Compute slicing step: for annual, group by 1 year; for monthly, group by org_len months
    org_step = 1 if is_annual else org_len
    org_index_grp = [tuple(acc_yrmo_all[i: i+org_step]) for i in range(0, len(acc_yrmo_all), org_step)]
    org_index_map = {val: group[0] for group in org_index_grp for val in group}
    org_label = [_get_org_label(i[0], org_len) for i in org_index_grp]
    
    df1['Org*Grp'] = df1[date_cols[0]].apply(lambda x: _get_org_label(x, org_len))

    df1['Org*Start'] = df1[date_cols[0]].map(org_index_map)
    # When Development Date is missing, use dev_end from config for Age* (single column triangle)
    if has_dev_date:
        df1['Age*'] = df1[['Org*Start', date_cols[1]]].apply(lambda row: _calc_age(row.iloc[0], row.iloc[1]), axis=1)
    else:
        df1['Age*'] = df1['Org*Start'].apply(lambda x: _calc_age(x, project_settings['dev_end']))

    # When Development Date is missing (single column), all rows map to the single dev_label value
    if not has_dev_date:
        df1['Age*Grp'] = dev_label[0]  # Single column: all rows get the same label
    else:
        df1['Age*Grp'] = df1['Age*'].apply(lambda x: min([i for i in dev_label if i >= x]))

    df1 = df1.groupby(['Org*Grp', 'Age*Grp'])[required_datasets].sum().reset_index()

    # Create individual non-calculated triangles
    triangles  = {}
    
    for name in required_datasets:
        df2 = df1.pivot_table(
            index = df1['Org*Grp'], 
            columns = df1['Age*Grp'], 
            values = name,
            aggfunc = 'sum', 
            fill_value = 0
        )
        df2 = df2.reindex(index=org_label, columns=dev_label).fillna(0)

        if cumulative == True: 
            df2 = df2.cumsum(axis=1)

        data_format = DLOOKUP(PROJECT_CONFIG[arg['ProjectName']]['Dataset Types'], name, 'Source', 'Data Format')
        if data_format == 'Vector':
            df2 = vector_to_triangle(df2.iloc[:, [0]], dev_label)

        triangles[name] = df2
    
    # Calculated Triangle
    df2 = eval_triangle_formula(triangles, source)  

    # Clean Format
    n_rows = df2.shape[0]

    for i, acc in enumerate(df2.index):
        max_dev_age = (n_rows - i) * int((org_len/dev_len))
        
        # if org_len == 3 and dev_len == 1:
        if dev_len == 1:
            max_dev_age = max_dev_age - (12 - max_sys_month)

        if dev_len == 3:
            if max_sys_month in [1, 2, 3]:
                max_dev_age = max_dev_age - 3
            elif max_sys_month in [4, 5, 6]:
                max_dev_age = max_dev_age - 2
            elif max_sys_month in [7, 8, 9]:
                max_dev_age = max_dev_age - 1

        if dev_len == 6 and max_sys_month <= 6:
            max_dev_age = max_dev_age - 1

        if max_dev_age < 0:
            max_dev_age = 0

        df2.loc[acc, dev_label[max_dev_age:]] = np.nan

    if output_data_format == 'Vector' or is_vector_function(arg['Function']):
        df2 = df2.iloc[:, [0]].fillna(0)
    elif calendar_mode:
        df2 = _reshape_triangle_to_calendar(df2, org_index_grp, dev_label, project_settings)

    # Output
    _export_dataframe(df2, arg)


def _export_dataframe(df, arg):
    data_path = arg['DataPath']
    file_name = os.path.basename(data_path)
    folder = os.path.dirname(data_path)
    tmp_folder = folder + '\\tmp'
    tmp_data_path = tmp_folder + '\\' + file_name
    
    try:
        if not os.path.exists(folder):
            os.makedirs(folder)
        if not os.path.exists(tmp_folder):
            os.makedirs(tmp_folder)
    except:
        pass

    df.to_csv(tmp_data_path, index=False, header=False)

    if os.path.exists(data_path):
        os.remove(data_path)

    os.rename(tmp_data_path, data_path)


