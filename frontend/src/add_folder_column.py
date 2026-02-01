"""
Add Folder column to Actuarial_NJ.json based on project name patterns.
"""

import json
import re
from pathlib import Path

json_path = Path(r"E:\ADAS\Team Profile\Actuarial_NJ.json")

# Month to quarter mapping
MONTH_TO_QUARTER = {
    "jan": "Q1", "feb": "Q1", "mar": "Q1",
    "apr": "Q2", "may": "Q2", "jun": "Q2",
    "jul": "Q3", "aug": "Q3", "sep": "Q3",
    "oct": "Q4", "nov": "Q4", "dec": "Q4"
}

def extract_folder(project_name):
    """
    Extract folder name from project name.
    Examples:
      'NJ_Annual_Prod_2025 Q2-May' -> '2025Q2'
      'NJ_Annual_Prod_2025 Jan' -> '2025Q1'
      'NJ_Annual_Prod_2025 Oct RNWL' -> '2025Q4'
    """
    # Try to find year
    year_match = re.search(r"(\d{4})", project_name)
    if not year_match:
        return None
    year = year_match.group(1)

    # Try explicit Q# pattern first (e.g., "Q2-May", "Q4-Nov")
    q_match = re.search(r"Q([1-4])", project_name)
    if q_match:
        return f"New Jersey\\{year} Q{q_match.group(1)}"

    # Otherwise, look for month name
    for month, quarter in MONTH_TO_QUARTER.items():
        if re.search(rf"\b{month}\b", project_name, re.IGNORECASE):
            return f"New Jersey\\{year} {quarter}"

    return None

# Read JSON
with open(json_path, "r", encoding="utf-8") as f:
    data = json.load(f)

# Process each sheet
for sheet_name, sheet_data in data.items():
    headers = sheet_data["headers"]
    rows = sheet_data["rows"]

    # Find Project Name column index
    try:
        name_idx = headers.index("Project Name")
    except ValueError:
        print(f"Skipping {sheet_name}: no 'Project Name' column")
        continue

    # Check if Folder column already exists
    if "Folder" in headers:
        folder_idx = headers.index("Folder")
        # Update existing values
        for row in rows:
            project_name = row[name_idx] if name_idx < len(row) else ""
            row[folder_idx] = extract_folder(project_name or "")
    else:
        # Add Folder header
        headers.append("Folder")
        # Add Folder value to each row
        for row in rows:
            project_name = row[name_idx] if name_idx < len(row) else ""
            folder = extract_folder(project_name or "")
            row.append(folder)

    print(f"Sheet '{sheet_name}': added Folder column")
    for row in rows:
        print(f"  {row[name_idx][:40]:40} -> {row[-1]}")

# Write updated JSON
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print(f"\nUpdated: {json_path}")
