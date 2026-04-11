#!/usr/bin/env python3
"""
Build lab_inventory.json from transactions_all.csv and payroll_all.csv.

Rules:
- Skip budget adjustments (0930, 0932, 0939, 1000)
- Skip payroll obj_codes (1190, 1212, 1213, 1340, 2117, 2119, 2120, 2121) from transactions
- Skip LLPE (payroll encumbrances)
- Skip encumbrance-only entries (actuals_amount == 0)
- Skip YEGE negatives (those are source-side reclassifications); include positive YEGEs
- Skip GEC negatives in 2176300 (source-side corrections); include GEC positives in destination
- Track negative non-YEGE/non-GEC amounts as refund entries
- For PO flows: include PREQ/PRNC (actual payments), skip PO/POA (encumbrance creation)
"""

import csv
import json
from collections import defaultdict

# ── Category mapping by obj_code ──────────────────────────────────────────────
CATEGORY_MAP = {
    "7690": "scientific_equipment",
    "5760": "noncapitalized_equipment_edp",
    "5770": "noncapitalized_equipment_other",
    "5775": "noncapitalized_furnishings",
    "5290": "research_supplies",
    "5230": "office_supplies",
    "5490": "operating_supplies",
    "5260": "shop_supplies",
    "5180": "educational_supplies",
    "5220": "housekeeping_supplies",
    "5150": "data_processing_supplies",
    "4620": "software",
    "5610": "subscriptions",
    "5520": "conference_fees",
    "5540": "dues_memberships",
    "6240": "travel",
    "6241": "travel",
    "6242": "travel",
    "5560": "shipping",
    "3870": "shipping",
    "3880": "shipping",
    "4840": "printing",
    "3510": "repairs_maintenance",
    "3590": "repairs_maintenance",
    "3780": "repairs_maintenance",
    "5780": "miscellaneous",
    "5535": "purchasing_fees",
    "4210": "core_facility_services",
    "4690": "rentals",
    # Additional codes found in data
    "5270": "operating_supplies",  # R/M Supplies - Other → operating supplies
    "0360": "miscellaneous",       # Gifts/Foundation (only if positive actual)
}

BUDGET_CODES = {"0930", "0932", "0939", "1000"}
PAYROLL_CODES = {"1190", "1212", "1213", "1340", "2117", "2119", "2120", "2121"}
SALARY_CODES = {"1190", "1212", "1213", "1340"}
ERE_CODES = {"2117", "2119", "2120", "2121"}
ROLE_MAP = {
    "1212": "Faculty Supplement",
    "1213": "Grad Supplement",
    "1340": "Student Worker",
    "1190": "Graduate Assistant",
}

ALL_CATEGORIES = [
    "scientific_equipment", "noncapitalized_equipment_edp",
    "noncapitalized_equipment_other", "noncapitalized_furnishings",
    "research_supplies", "office_supplies", "operating_supplies",
    "shop_supplies", "educational_supplies", "housekeeping_supplies",
    "data_processing_supplies", "software", "subscriptions",
    "conference_fees", "dues_memberships", "travel", "shipping",
    "printing", "repairs_maintenance", "miscellaneous",
    "purchasing_fees", "core_facility_services", "rentals",
]


def extract_vendor_from_doc_desc(doc_desc):
    """Try to extract vendor name from doc_description field."""
    if not doc_desc:
        return ""
    # Procurement card format: "Procurement Card - ... / VENDOR NAME / $amount"
    if "Procurement Card" in doc_desc:
        parts = doc_desc.split("/")
        if len(parts) >= 3:
            # Vendor is typically the second-to-last segment before the amount
            for i in range(len(parts) - 1, 0, -1):
                part = parts[i].strip()
                if part.startswith("$"):
                    if i - 1 > 0:
                        return parts[i - 1].strip()
    # PO format: "PO: XXXXX Vendor: VENDOR NAME ..."
    if "Vendor:" in doc_desc:
        start = doc_desc.index("Vendor:") + 7
        rest = doc_desc[start:].strip()
        # Find next keyword
        for kw in ["Account:", "Amount:", "Pay Date:", "Contract"]:
            if kw in rest:
                return rest[:rest.index(kw)].strip()
        return rest.strip()
    # Disbursement voucher
    if "Disbursement Voucher" in doc_desc:
        return doc_desc.split("-")[-1].strip().split("[")[0].strip() if "-" in doc_desc else ""
    return ""


def parse_date(date_str):
    """Return ISO date or empty string."""
    if date_str and len(date_str) >= 10:
        return date_str[:10]
    return ""


def extract_account(sheet):
    """Extract base account number from sheet name like '1101935 FY25'."""
    return sheet.split()[0] if sheet else ""


def extract_fy(sheet):
    """Extract fiscal year label from sheet name."""
    parts = sheet.split()
    for p in parts:
        if p.startswith("FY"):
            return p
    return ""


def fy_from_date(date_str):
    """Determine fiscal year from date string (UA FY starts July 1)."""
    if not date_str or len(date_str) < 7:
        return ""
    year = int(date_str[:4])
    month = int(date_str[5:7])
    if month >= 7:
        return f"FY{(year + 1) % 100:02d}"
    else:
        return f"FY{year % 100:02d}"


def main():
    # ── Read transactions ─────────────────────────────────────────────────────
    with open("Data/transactions_all.csv", newline="") as f:
        reader = csv.DictReader(f)
        txn_rows = list(reader)

    # ── Read payroll ──────────────────────────────────────────────────────────
    with open("Data/payroll_all.csv", newline="") as f:
        reader = csv.DictReader(f)
        pay_rows = list(reader)

    # ── Process transactions ──────────────────────────────────────────────────
    purchases = {cat: [] for cat in ALL_CATEGORIES}
    skipped_count = 0

    for row in txn_rows:
        obj_code = row["obj_code"].strip()
        doc_type = row["doc_type"].strip()
        sheet = row["sheet"].strip()
        try:
            actuals = float(row["actuals_amount"])
        except (ValueError, TypeError):
            actuals = 0.0
        try:
            encumbrance = float(row["encumbrance_amount"])
        except (ValueError, TypeError):
            encumbrance = 0.0

        # Skip budget adjustments
        if obj_code in BUDGET_CODES:
            skipped_count += 1
            continue

        # Skip payroll entries (handled by payroll CSV)
        if obj_code in PAYROLL_CODES:
            skipped_count += 1
            continue

        # Skip payroll encumbrances
        if doc_type == "LLPE":
            skipped_count += 1
            continue

        # Skip LLPR (payroll actuals) - already handled above by obj_code check
        if doc_type == "LLPR":
            skipped_count += 1
            continue

        # Skip encumbrance-only entries (PO creation, no actual spend)
        if actuals == 0.0:
            skipped_count += 1
            continue

        # Skip PO and POA doc types (encumbrance creation, not payment)
        if doc_type in ("PO", "POA"):
            skipped_count += 1
            continue

        # YEGE handling: only include positive (destination) entries
        if doc_type == "YEGE":
            if actuals < 0:
                skipped_count += 1
                continue
            # Positive YEGE = destination account, include it

        # YETF (year-end transfer of funds) - skip, it's a budget transfer
        if doc_type == "YETF":
            skipped_count += 1
            continue

        # GEC handling: negative GECs are source-side corrections (moved elsewhere)
        if doc_type == "GEC" and actuals < 0:
            skipped_count += 1
            continue

        # Skip negative entries in 2176300 with empty doc_type/doc_number.
        # These are continuation lines of YEGE/GEC correction batches that move
        # expenses OUT of 2176300 to 1101935. The positive side is already included.
        if "2176300" in sheet and doc_type == "" and actuals < 0:
            doc_num = row["doc_number"].strip()
            if doc_num == "" or doc_num == "31553281":
                skipped_count += 1
                continue

        # Foundation gift transfer (DI doc_type, 0360 code) - skip negative
        if obj_code == "0360" and actuals < 0:
            skipped_count += 1
            continue

        # BTR (budget transfer) - skip
        if doc_type == "BTR":
            skipped_count += 1
            continue

        # TF (transfer) with negative = transfer in (budget), skip
        if doc_type == "TF" and actuals < 0:
            skipped_count += 1
            continue

        # Determine category
        category = CATEGORY_MAP.get(obj_code)
        if category is None:
            print(f"WARNING: Unmapped obj_code {obj_code} ({row['obj_code_name']}), skipping")
            skipped_count += 1
            continue

        # Extract vendor
        vendor = row["vendor"].strip() if row["vendor"].strip() else extract_vendor_from_doc_desc(row.get("doc_description", ""))

        # Determine if this is a refund
        is_refund = actuals < 0

        entry = {
            "date": parse_date(row["txn_date"]) or parse_date(row["post_date"]),
            "description": row["entry_description"].strip(),
            "vendor": vendor,
            "amount": round(actuals, 2),
            "account": sheet,
            "obj_code": obj_code,
            "obj_code_name": row["obj_code_name"].strip(),
            "doc_number": row["doc_number"].strip(),
            "doc_type": doc_type,
            "po_number": row["ref_doc_number"].strip() if doc_type in ("PREQ", "PRNC") else "",
        }
        if is_refund:
            entry["type"] = "refund"

        purchases[category].append(entry)

    # Sort each category by date
    for cat in purchases:
        purchases[cat].sort(key=lambda x: x.get("date", "") or "9999")

    # ── Process payroll ───────────────────────────────────────────────────────
    # Group by employee name
    employees = {}
    for row in pay_rows:
        name = row["employee_name"].strip().strip('"')
        obj_code = row["obj_code"].strip()
        try:
            amount = float(row["expenditure_amount"])
        except (ValueError, TypeError):
            amount = 0.0
        try:
            hours = float(row["hours_worked"])
        except (ValueError, TypeError):
            hours = 0.0
        try:
            fte = float(row["job_fte"])
        except (ValueError, TypeError):
            fte = 0.0

        if name not in employees:
            employees[name] = {
                "name": name,
                "position_number": row["position_number"].strip(),
                "role_type": "",
                "fte": fte,
                "pay_periods": [],
                "total_hours": 0.0,
                "total_compensation": 0.0,
                "total_ere": 0.0,
                "total_cost": 0.0,
            }

        # Determine role from salary obj_codes
        if obj_code in SALARY_CODES:
            employees[name]["role_type"] = ROLE_MAP.get(obj_code, "Unknown")

        pay_entry = {
            "date": row["pay_period_date"].strip(),
            "account": row["sheet"].strip(),
            "obj_code": obj_code,
            "obj_code_name": row["obj_code_name"].strip(),
            "hours": round(hours, 2),
            "amount": round(amount, 2),
        }
        employees[name]["pay_periods"].append(pay_entry)

        if obj_code in SALARY_CODES:
            employees[name]["total_hours"] += hours
            employees[name]["total_compensation"] += amount
        elif obj_code in ERE_CODES:
            employees[name]["total_ere"] += amount

    # Round totals and compute total_cost
    for emp in employees.values():
        emp["total_hours"] = round(emp["total_hours"], 2)
        emp["total_compensation"] = round(emp["total_compensation"], 2)
        emp["total_ere"] = round(emp["total_ere"], 2)
        emp["total_cost"] = round(emp["total_compensation"] + emp["total_ere"], 2)
        # Sort pay periods by date
        emp["pay_periods"].sort(key=lambda x: x["date"])

    # ── Build summaries ───────────────────────────────────────────────────────
    by_category = {}
    by_vendor = defaultdict(float)
    by_account = defaultdict(float)
    by_fy = defaultdict(float)
    by_month = defaultdict(float)

    for cat in ALL_CATEGORIES:
        total = sum(e["amount"] for e in purchases[cat])
        by_category[cat] = round(total, 2)
        for e in purchases[cat]:
            if e["vendor"]:
                by_vendor[e["vendor"]] += e["amount"]
            by_account[extract_account(e["account"])] += e["amount"]
            date = e.get("date", "")
            if date:
                fy = fy_from_date(date)
                by_fy[fy] += e["amount"]
                by_month[date[:7]] += e["amount"]

    # Round summaries
    by_vendor = {k: round(v, 2) for k, v in sorted(by_vendor.items(), key=lambda x: -x[1])}
    by_account = {k: round(v, 2) for k, v in sorted(by_account.items())}
    by_fy = {k: round(v, 2) for k, v in sorted(by_fy.items())}
    by_month = {k: round(v, 2) for k, v in sorted(by_month.items())}

    personnel_by_employee = {name: emp["total_cost"] for name, emp in sorted(employees.items())}

    total_purchase_spend = round(sum(by_category.values()), 2)
    total_personnel_spend = round(sum(emp["total_cost"] for emp in employees.values()), 2)

    # ── Assemble final JSON ───────────────────────────────────────────────────
    result = {
        "metadata": {
            "source": "Alex_McGhee_StartUp.xlsx",
            "extractedDate": "2026-04-02",
            "description": "Complete lab inventory with cost tracking from startup accounts FY24-FY26",
            "totalPurchaseSpend": total_purchase_spend,
            "totalPersonnelSpend": total_personnel_spend,
            "accounts": sorted(set(extract_account(s) for s in
                                   set(r["sheet"].strip() for r in txn_rows))),
        },
        "purchases": purchases,
        "personnel": {name: employees[name] for name in sorted(employees.keys())},
        "summaries": {
            "by_category": by_category,
            "by_vendor": by_vendor,
            "by_account": by_account,
            "by_fiscal_year": by_fy,
            "by_month": by_month,
            "personnel_by_employee": personnel_by_employee,
        },
    }

    with open("Data/lab_inventory.json", "w") as f:
        json.dump(result, f, indent=2)

    # ── Summary stats ─────────────────────────────────────────────────────────
    total_entries = sum(len(v) for v in purchases.values())
    print(f"Processed {len(txn_rows)} transaction rows → {total_entries} purchase entries ({skipped_count} skipped)")
    print(f"Processed {len(pay_rows)} payroll rows → {len(employees)} employees")
    print(f"Total purchase spend: ${total_purchase_spend:,.2f}")
    print(f"Total personnel spend: ${total_personnel_spend:,.2f}")
    print(f"Grand total: ${total_purchase_spend + total_personnel_spend:,.2f}")
    print()
    print("Category breakdown:")
    for cat in ALL_CATEGORIES:
        if by_category[cat] != 0:
            count = len(purchases[cat])
            print(f"  {cat}: ${by_category[cat]:,.2f} ({count} entries)")
    print()
    print("Personnel:")
    for name, emp in sorted(employees.items()):
        print(f"  {name}: ${emp['total_cost']:,.2f} ({emp['role_type']}, {emp['total_hours']} hrs)")
    print(f"\nJSON written to Data/lab_inventory.json")


if __name__ == "__main__":
    main()
