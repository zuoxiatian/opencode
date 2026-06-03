"""
列过滤模块 — excel-to-pptx skill

根据用户指定的列规则过滤 Excel JSON 数据，只设置 selected_col_indices，
不修改原始 headers 和 data，保持与 layout_engine.py 的兼容性。

Usage:
  python filter_columns.py <input.json> --exclude "对接,审核人" -o filtered.json
  python filter_columns.py <input.json> --include-required -o filtered.json
  python filter_columns.py <input.json> --include "序号,媒体名称,播放量" -o filtered.json
"""

import argparse
import json
import sys
import os


def clean_header(h):
    """清理表头：去括号注析、空白、换行"""
    if h is None:
        return ""
    h = str(h).strip()
    h = h.split('（')[0].split('(')[0].strip()
    return h


def match_header(header, keyword):
    """判断表头是否匹配关键词（支持模糊匹配）"""
    cleaned = clean_header(header)
    return keyword in cleaned or keyword in header


def is_non_required_header(header):
    """True when header explicitly marks the column as non-required for PPT."""
    if header is None:
        return False
    normalized = str(header).replace(" ", "").replace("\n", "").lower()
    markers = ["非必填", "(非必填)", "（非必填）", "ppt非必填", "非必填列"]
    return any(marker in normalized for marker in markers)


def filter_sheet(sheet, options):
    """对单个 sheet 设置 selected_col_indices，不修改 headers 和 data"""
    headers = sheet.get("headers", [])
    required_indices = set(sheet.get("required_col_indices", []))
    non_required_indices = {idx for idx, h in enumerate(headers) if is_non_required_header(h)}

    selected = set()

    if options.get("include_required"):
        if required_indices:
            selected.update(required_indices)
        else:
            selected.update(set(range(len(headers))) - non_required_indices)

    exclude_keywords = [k.strip() for k in options.get("exclude", "").split(",") if k.strip()]
    for idx, h in enumerate(headers):
        for kw in exclude_keywords:
            if match_header(h, kw):
                selected.discard(idx)
                break

    include_keywords = [k.strip() for k in options.get("include", "").split(",") if k.strip()]
    if include_keywords:
        selected.clear()
        if options.get("include_required"):
            if required_indices:
                selected.update(required_indices)
            else:
                selected.update(set(range(len(headers))) - non_required_indices)
        for idx, h in enumerate(headers):
            for kw in include_keywords:
                if match_header(h, kw):
                    selected.add(idx)
                    break

    # Hard rule: never keep columns explicitly marked as non-required.
    selected = {idx for idx in selected if idx not in non_required_indices}

    if not selected:
        selected = set(range(len(headers))) - non_required_indices

    # Hard rule is applied again after fallback, so fallback can never reintroduce 非必填 columns.
    selected = {idx for idx in selected if idx not in non_required_indices}

    sheet["selected_col_indices"] = sorted(selected)

    excluded = [h for i, h in enumerate(headers) if i not in selected]
    included = [h for i, h in enumerate(headers) if i in selected]
    print(f"  Sheet '{sheet['name']}': {len(headers)} cols → {len(selected)} selected", file=sys.stderr)
    if excluded:
        print(f"    Excluded: {[h for h in excluded if h]}", file=sys.stderr)

    return sheet


def main():
    parser = argparse.ArgumentParser(description="Filter columns in Excel JSON data")
    parser.add_argument("input", help="Input JSON file (parsed by read_excel.py)")
    parser.add_argument("--output", "-o", help="Output JSON file path")
    parser.add_argument("--exclude", help="Exclude columns containing these keywords (comma-separated)")
    parser.add_argument("--include", help="Include only columns containing these keywords (comma-separated)")
    parser.add_argument("--include-required", action="store_true", help="Always include required columns")
    parser.add_argument("--sheets", help="Comma-separated sheet names to process (default: all except summary)")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    with open(args.input, encoding="utf-8") as f:
        data = json.load(f)

    options = {
        "exclude": args.exclude or "",
        "include": args.include or "",
        "include_required": args.include_required,
        "include_summary": False,
    }

    summary_idx = data.get("summary_sheet_index", 0)
    target_names = None
    if args.sheets:
        target_names = set(args.sheets.split(","))

    for i, sheet in enumerate(data.get("sheets", [])):
        if i == summary_idx and not options.get("include_summary"):
            continue
        if target_names and sheet["name"] not in target_names:
            continue
        filter_sheet(sheet, options)

    json_str = json.dumps(data, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(json_str)
        print(f"Output written to {args.output}", file=sys.stderr)
    else:
        print(json_str)


if __name__ == "__main__":
    main()
