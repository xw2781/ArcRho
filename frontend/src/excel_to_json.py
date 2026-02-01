"""
Convert Excel workbook to JSON.
Usage: python excel_to_json.py
"""

import json
from pathlib import Path

try:
    import pandas as pd
except ImportError:
    print("pandas not installed. Run: pip install pandas openpyxl")
    exit(1)

# Source Excel file
excel_path = Path(r"E:\ADAS\Team Profile\Actuarial_NJ.xlsm")

if not excel_path.exists():
    print(f"File not found: {excel_path}")
    exit(1)

# Output JSON path (same directory as Excel file)
json_path = excel_path.with_suffix(".json")

# Read all sheets from the workbook
xlsx = pd.ExcelFile(excel_path, engine="openpyxl")
result = {}

for sheet_name in xlsx.sheet_names:
    df = pd.read_excel(xlsx, sheet_name=sheet_name)
    # Replace NaN with None for JSON compatibility
    df = df.where(pd.notnull(df), None)
    # Compact structure: headers once, then rows as arrays
    result[sheet_name] = {
        "headers": df.columns.tolist(),
        "rows": df.values.tolist()
    }

# Write JSON file
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2, default=str, ensure_ascii=False)

print(f"Created: {json_path}")
print(f"Sheets: {list(result.keys())}")
for name, data in result.items():
    print(f"  - {name}: {len(data['headers'])} columns, {len(data['rows'])} rows")
