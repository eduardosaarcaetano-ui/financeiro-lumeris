import json
import sys
from datetime import datetime
from pathlib import Path

import openpyxl


SOURCE_LABEL = "Controle Estoque Iluminar.xlsx"


def as_float(value):
    try:
        if value is None or value == "":
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def as_text(value):
    return str(value or "").strip()


def infer_unit(name):
    upper = name.upper()
    if "METRO" in upper or " METROS" in upper:
        return "metro"
    if "PCT" in upper or "PACOTE" in upper:
        return "pacote"
    if "LITRO" in upper or upper.endswith(" 5L") or " 5L " in upper:
        return "litro"
    return "unidade"


def build_items(workbook_path):
    wb = openpyxl.load_workbook(workbook_path, data_only=True, read_only=True)
    ws = wb["Base_Estoque"]
    items = []
    total_value = 0.0

    for row_index, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if not row or not row[2]:
            continue

        row_id = as_text(row[0]) or str(row_index - 1)
        code = as_text(row[1])
        name = as_text(row[2])
        category = as_text(row[3]).upper() or "SEM CADASTRO"
        quantity = as_float(row[10])
        min_quantity = as_float(row[4])
        max_quantity = as_float(row[5])
        initial_quantity = as_float(row[6])
        average_cost = as_float(row[11])
        initial_cost = as_float(row[7])
        stock_value = as_float(row[12])
        total_value += stock_value

        items.append(
            {
                "id": f"iluminar-item-base-{row_index}",
                "source": SOURCE_LABEL,
                "sourceRow": row_index,
                "sourceId": row_id,
                "internalCode": code,
                "barcode": "",
                "name": name,
                "description": name,
                "category": category,
                "subcategory": "",
                "brand": "",
                "model": "",
                "unit": infer_unit(name),
                "primarySupplierName": "",
                "locationName": "Estoque principal",
                "quantity": quantity,
                "minQuantity": min_quantity,
                "maxQuantity": max_quantity,
                "initialQuantity": initial_quantity,
                "initialCost": initial_cost,
                "entriesQuantity": as_float(row[8]),
                "exitsQuantity": as_float(row[9]),
                "averageCost": average_cost,
                "lastPurchaseCost": average_cost or initial_cost,
                "active": True,
                "status": as_text(row[13]),
                "notes": "Importado da planilha Controle Estoque Iluminar. Saldo atual/custo medio conforme Base_Estoque.",
            }
        )

    return items, total_value


def main():
    if len(sys.argv) != 3:
        raise SystemExit("uso: generate_stock_data.py <planilha.xlsx> <saida.js>")

    workbook_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    items, total_value = build_items(workbook_path)
    now = datetime.now().replace(microsecond=0).isoformat()
    baseline_version = f"base-estoque-2026-07-28-{len(items)}-{round(total_value, 2)}"

    payload = {
        "sourceFile": SOURCE_LABEL,
        "sourcePath": str(workbook_path),
        "generatedAt": now,
        "baselineVersion": baseline_version,
        "summary": {
            "items": len(items),
            "uncatalogedItems": 0,
            "movements": 0,
            "entries": 0,
            "exits": 0,
            "totalValue": round(total_value, 2),
        },
        "items": items,
        "uncatalogedItems": [],
        "movements": [],
    }

    output_path.write_text(
        "window.ILUMINAR_STOCK_IMPORT = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(json.dumps(payload["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
