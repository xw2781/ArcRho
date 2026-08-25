import csv
import json
import os
import re
import time
import uuid
from datetime import datetime


def _parse_date_to_yyyymm(date_str):
    """
    Parse various date formats and convert to YYYYMM integer.

    Supported formats:
    - "yyyymm" (e.g., "202601")
    - "mmm yyyy" (e.g., "Jan 2026")
    - "yyyymmm" (e.g., "2026Jan")
    - "yyyy-mm" (e.g., "2026-01")
    - "mm/yyyy" (e.g., "01/2026")
    """
    date_str = str(date_str).strip()

    if date_str.isdigit() and len(date_str) == 6:
        return int(date_str)

    month_names = {
        'jan': 1, 'january': 1,
        'feb': 2, 'february': 2,
        'mar': 3, 'march': 3,
        'apr': 4, 'april': 4,
        'may': 5,
        'jun': 6, 'june': 6,
        'jul': 7, 'july': 7,
        'aug': 8, 'august': 8,
        'sep': 9, 'september': 9,
        'oct': 10, 'october': 10,
        'nov': 11, 'november': 11,
        'dec': 12, 'december': 12
    }

    parts = date_str.split()
    if len(parts) == 2:
        month_str, year_str = parts
        if month_str.lower() in month_names and year_str.isdigit():
            return int(year_str) * 100 + month_names[month_str.lower()]

    if len(date_str) >= 7:
        year_part = date_str[:4]
        month_part = date_str[4:]
        if year_part.isdigit() and month_part.lower() in month_names:
            return int(year_part) * 100 + month_names[month_part.lower()]

    if '-' in date_str or '/' in date_str:
        separator = '-' if '-' in date_str else '/'
        parts = date_str.split(separator)
        if len(parts) == 2:
            part1, part2 = parts
            if part1.isdigit() and part2.isdigit():
                if len(part1) == 4:
                    return int(part1) * 100 + int(part2)
                if len(part2) == 4:
                    return int(part2) * 100 + int(part1)
                if int(part1) > 12:
                    return int(part1) * 100 + int(part2)
                return int(part1) * 100 + int(part2)

    try:
        return int(date_str)
    except ValueError:
        raise ValueError(f"Unable to parse date format: {date_str}")


def _generate_full_month_range(start_yrmo, end_yrmo):
    """
    Generate a complete list of YYYYMM values from start to end.
    Handles missing months in data by creating the full expected range.
    """
    result = []
    current_year = start_yrmo // 100
    current_month = start_yrmo % 100
    end_year = end_yrmo // 100
    end_month = end_yrmo % 100

    while (current_year < end_year) or (current_year == end_year and current_month <= end_month):
        result.append(current_year * 100 + current_month)
        current_month += 1
        if current_month > 12:
            current_month = 1
            current_year += 1

    return result


def _generate_period_range(start_yrmo, end_yrmo, date_granularity='monthly'):
    """
    Generate a date range matching data granularity.
    For annual data, returns YYYY integers; for monthly, returns YYYYMM integers.
    """
    if date_granularity == 'annual':
        return list(range(start_yrmo // 100, end_yrmo // 100 + 1))
    return _generate_full_month_range(start_yrmo, end_yrmo)


def DLOOKUP(df, lookup_value, lookup_col, return_col):
    """
    Lookup a value in DataFrame. Returns empty string if not found.
    """
    result = df[df[lookup_col] == lookup_value][return_col]
    if result.empty:
        return ''
    return result.iloc[0]


def to_upper_case(df):
    return df.apply(lambda col: col.str.upper() if col.dtype == "object" else col)


def get_current_time():
    now = datetime.now()
    milliseconds = now.microsecond // 1000
    formatted_date_time = now.strftime(f"%m/%d %H:%M:%S ({milliseconds})")
    return formatted_date_time


def strip_outer_quotes(s: str):
    return re.sub(r'^\s*"|"(\s*)$', '', s).strip()


def split_formula_with_ops(s: str):
    """
    Return:
      - items: dataset names
      - ops:   operator BEFORE each item ('+' or '-')
    """
    token_pattern = re.compile(
        r'''
        (?P<op>[+-]?)\s*                  # optional leading operator
        (?:
            "(?P<quoted>[^"]*)"           # quoted token
            |
            (?P<unquoted>[^"+*/()\-\s]+   # unquoted token
                (?:\s+[^"+*/()\-\s]+)*)
        )
        ''',
        re.VERBOSE
    )

    items = []
    ops = []

    for m in token_pattern.finditer(s):
        op = m.group('op') or '+'
        token = m.group('quoted') or m.group('unquoted')

        token = token.strip()
        if not token:
            continue

        items.append(token)
        ops.append(op)

    return items, ops


def split_formula(s: str):
    return split_formula_with_ops(s)[0]


def split_formula_opts(s: str):
    return split_formula_with_ops(s)[1]


def read_json(json_file, retries=50, delay=0.02):
    for _ in range(retries):
        try:
            with open(json_file, mode='r', encoding='utf-8-sig') as f:
                return json.load(f)
        except (PermissionError, json.JSONDecodeError):
            time.sleep(delay)
    raise PermissionError(f"Cannot open {json_file}")


def write_json(json_file, arg, retries=5, delay=0.1):
    for _ in range(retries):
        tmp_file = f"{json_file}.{uuid.uuid4()}.tmp"
        try:
            os.makedirs(os.path.dirname(json_file), exist_ok=True)
            with open(tmp_file, mode="w", encoding="utf-8") as file:
                json.dump(arg, file, indent=2)
                file.write("\n")
            os.replace(tmp_file, json_file)
            return True
        except PermissionError:
            try:
                if os.path.exists(tmp_file):
                    os.remove(tmp_file)
            except PermissionError:
                pass
            time.sleep(delay)

    return False


def time_diff(time_str_1, time_str_2='Current Time'):
    time_1 = datetime.strptime(time_str_1, "%Y-%m-%d %H:%M:%S")
    if time_str_2 == 'Current Time':
        time_difference = (datetime.now() - time_1).total_seconds()
    else:
        time_difference = (datetime.strptime(time_str_2, "%Y-%m-%d %H:%M:%S") - time_1).total_seconds()
    return time_difference


def safe_remove(file_path, attempts=5, delay=0.1):
    """Attempt to remove a file with retries on permission error."""
    for _ in range(attempts):
        try:
            tmp = f"{file_path}.{uuid.uuid4()}.deleting"
            os.replace(file_path, tmp)
            os.remove(tmp)
            return True
        except PermissionError:
            time.sleep(delay)

    return False


def write_lists_to_csv(csv_path, lists, overwrite=True):
    folder_path = os.path.dirname(csv_path)
    tmp_folder = folder_path + '\\tmp'
    tmp_csv_path = tmp_folder + '\\' + os.path.basename(csv_path)

    if not os.path.exists(folder_path):
        os.makedirs(folder_path)
    if not os.path.exists(tmp_folder):
        os.makedirs(tmp_folder)

    if os.path.exists(tmp_csv_path):
        safe_remove(tmp_csv_path)

    with open(tmp_csv_path, mode='w', newline='', encoding='utf-8') as file:
        writer = csv.writer(file)
        for lst in lists:
            writer.writerow(lst)

    if os.path.exists(csv_path):
        safe_remove(csv_path)

    time.sleep(0.05)
    os.rename(tmp_csv_path, csv_path)
