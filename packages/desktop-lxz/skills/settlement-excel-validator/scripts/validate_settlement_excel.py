#!/usr/bin/env python3
"""Validate whether an Excel workbook matches the settlement original-input standard.

The validator mirrors the first step of the excel-to-pptx workflow: normalize Excel,
expand merged cells, compact blank rows/columns, detect headers, identify a summary
sheet, extract image metadata, then apply schema checks.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import openpyxl
from openpyxl.utils import get_column_letter

SKILL_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SCHEMA = SKILL_DIR / "references" / "standard_schema.json"
EXCEL_TO_PPTX_READER = Path("/home/ubuntu/skills/excel-to-pptx/scripts/read_excel.py")


def clean_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).replace("\r", "").replace("\n", "").strip()
    return text or None


def clean_header(value: Any) -> str:
    return clean_text(value) or ""


def normalize_header(value: Any) -> str:
    text = clean_header(value)
    for token in [" ", "\t", "\u3000"]:
        text = text.replace(token, "")
    return text


def is_blank(value: Any) -> bool:
    return clean_text(value) is None


def try_external_parse(input_path: Path, out_dir: Path) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Use excel-to-pptx read_excel.py when available so validation follows the production parser."""
    if not EXCEL_TO_PPTX_READER.exists():
        return None, f"未找到 excel-to-pptx 解析脚本：{EXCEL_TO_PPTX_READER}，已改用内置轻量解析。"
    parsed_path = out_dir / "parsed_by_excel_to_pptx.json"
    cmd = [sys.executable, str(EXCEL_TO_PPTX_READER), str(input_path), "-o", str(parsed_path)]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "unknown error").strip()
            return None, f"调用 excel-to-pptx 解析脚本失败，已改用内置轻量解析：{detail}"
        return json.loads(parsed_path.read_text(encoding="utf-8")), None
    except Exception as exc:  # pragma: no cover - defensive fallback
        return None, f"调用 excel-to-pptx 解析脚本异常，已改用内置轻量解析：{exc}"


def expand_merged_cells(ws) -> Dict[Tuple[int, int], Any]:
    merged_map: Dict[Tuple[int, int], Any] = {}
    for merged_range in ws.merged_cells.ranges:
        value = ws.cell(merged_range.min_row, merged_range.min_col).value
        for row in range(merged_range.min_row, merged_range.max_row + 1):
            for col in range(merged_range.min_col, merged_range.max_col + 1):
                merged_map[(row, col)] = value
    return merged_map


def build_compact_matrix(ws, merged_map: Dict[Tuple[int, int], Any]) -> Dict[str, Any]:
    raw: List[List[Any]] = []
    row_has_value = set()
    col_has_value = set()
    for r in range(1, ws.max_row + 1):
        row_values = []
        for c in range(1, ws.max_column + 1):
            value = merged_map.get((r, c), ws.cell(r, c).value)
            value = clean_text(value)
            row_values.append(value)
            if value is not None:
                row_has_value.add(r)
                col_has_value.add(c)
        raw.append(row_values)
    keep_rows = [r for r in range(1, ws.max_row + 1) if r in row_has_value]
    keep_cols = [c for c in range(1, ws.max_column + 1) if c in col_has_value]
    old_to_new_row = {old: new for new, old in enumerate(keep_rows, start=1)}
    old_to_new_col = {old: new for new, old in enumerate(keep_cols, start=1)}
    new_to_old_row = {new: old for old, new in old_to_new_row.items()}
    matrix = [[raw[r - 1][c - 1] for c in keep_cols] for r in keep_rows]
    return {
        "matrix": matrix,
        "old_to_new_row": old_to_new_row,
        "old_to_new_col": old_to_new_col,
        "new_to_old_row": new_to_old_row,
        "removed_blank_rows": [r for r in range(1, ws.max_row + 1) if r not in old_to_new_row],
        "removed_blank_cols": [get_column_letter(c) for c in range(1, ws.max_column + 1) if c not in old_to_new_col],
    }


def detect_header_row(matrix: List[List[Any]]) -> int:
    for idx, row in enumerate(matrix[: min(12, len(matrix))], start=1):
        if sum(1 for value in row if not is_blank(value)) >= 2:
            return idx
    for idx, row in enumerate(matrix[: min(12, len(matrix))], start=1):
        if any(not is_blank(value) for value in row):
            return idx
    return 1


def parse_sheet_light(ws) -> Dict[str, Any]:
    merged_map = expand_merged_cells(ws)
    compact = build_compact_matrix(ws, merged_map)
    matrix = compact["matrix"]
    images = []
    for idx, img in enumerate(getattr(ws, "_images", []) or []):
        anchor = getattr(img, "anchor", None)
        row_idx = col_idx = None
        if hasattr(anchor, "_from"):
            row_idx = getattr(anchor._from, "row", None)
            col_idx = getattr(anchor._from, "col", None)
            row_idx = row_idx + 1 if row_idx is not None else None
            col_idx = col_idx + 1 if col_idx is not None else None
        images.append({
            "index": idx,
            "anchor_row_original": row_idx,
            "anchor_col_index_original": col_idx,
            "anchor_col_original": get_column_letter(col_idx) if col_idx else None,
        })
    if not matrix:
        return {
            "name": ws.title,
            "rows": 0,
            "cols": 0,
            "headers": [],
            "required_col_indices": [],
            "data": [],
            "images": images,
            "image_column_count": 0,
            "max_images_per_data_row": 0,
            "merged_ranges": [str(r) for r in ws.merged_cells.ranges],
            "normalization": {
                "removed_blank_rows": compact["removed_blank_rows"],
                "removed_blank_cols": compact["removed_blank_cols"],
                "table_matrix_excludes_image_only_rows_cols": True,
                "merged_cells_expanded": len(ws.merged_cells.ranges),
            },
            "header_row": 1,
            "header_end_row": 1,
            "data_start_row": 1,
        }
    header_row = detect_header_row(matrix)
    headers = [clean_header(value) or f"列{i + 1}" for i, value in enumerate(matrix[header_row - 1])]
    data_start = header_row + 1
    rows = []
    for row in matrix[data_start - 1 :]:
        padded = list(row[: len(headers)])
        if len(padded) < len(headers):
            padded += [None] * (len(headers) - len(padded))
        if any(not is_blank(value) for value in padded):
            rows.append(padded)
    image_cols = {img.get("anchor_col_index_original") for img in images if img.get("anchor_col_index_original")}
    return {
        "name": ws.title,
        "rows": len(rows),
        "cols": len(headers),
        "headers": headers,
        "required_col_indices": [idx for idx, h in enumerate(headers) if "必填" in h],
        "data": rows,
        "images": images,
        "image_column_count": len(image_cols),
        "max_images_per_data_row": 0,
        "merged_ranges": [str(r) for r in ws.merged_cells.ranges],
        "normalization": {
            "removed_blank_rows": compact["removed_blank_rows"],
            "removed_blank_cols": compact["removed_blank_cols"],
            "table_matrix_excludes_image_only_rows_cols": True,
            "merged_cells_expanded": len(ws.merged_cells.ranges),
        },
        "header_row": header_row,
        "header_end_row": header_row,
        "data_start_row": data_start,
    }


def parse_light(input_path: Path) -> Dict[str, Any]:
    wb = openpyxl.load_workbook(input_path, data_only=False)
    sheets = [parse_sheet_light(ws) for ws in wb.worksheets]
    summary_idx = -1
    for i, sheet in enumerate(sheets):
        name = sheet.get("name", "")
        if "汇总" in name or "summary" in name.lower():
            summary_idx = i
            break
    if summary_idx >= 0:
        summary = sheets[summary_idx]
        detail_indices = [i for i in range(len(sheets)) if i != summary_idx]
        summary_rows = summary.get("data", [])
        for seq, detail_idx in enumerate(detail_indices):
            if not summary_rows:
                break
            row_idx = 0 if len(summary_rows) == 1 else seq
            if row_idx >= len(summary_rows):
                break
            sheets[detail_idx]["summary_context"] = {
                "summary_sheet_name": summary.get("name"),
                "summary_row_index": row_idx,
                "summary_row_number": row_idx + 1,
                "detail_sheet_name": sheets[detail_idx].get("name"),
                "display_mode": "first_page_only" if len(summary_rows) == 1 else "every_page",
            }
    return {
        "file": input_path.name,
        "file_path": str(input_path),
        "all_sheet_names": [ws.title for ws in wb.worksheets],
        "summary_sheet_index": summary_idx,
        "sheets": sheets,
    }


def parse_workbook(input_path: Path, out_dir: Path) -> Tuple[Dict[str, Any], List[str]]:
    warnings: List[str] = []
    parsed, warning = try_external_parse(input_path, out_dir)
    if warning:
        warnings.append(warning)
    if parsed is None:
        parsed = parse_light(input_path)
    return parsed, warnings


def headers_present(actual: List[str], expected: List[str]) -> Tuple[List[str], float]:
    actual_norm = {normalize_header(h) for h in actual}
    missing = [h for h in expected if normalize_header(h) not in actual_norm]
    ratio = 1.0 if not expected else (len(expected) - len(missing)) / len(expected)
    return missing, ratio


def repeated_header_ratio(headers: List[str]) -> Tuple[float, Optional[str]]:
    cleaned = [normalize_header(h) for h in headers if normalize_header(h)]
    if not cleaned:
        return 0.0, None
    value, count = Counter(cleaned).most_common(1)[0]
    return count / len(cleaned), value


def add_issue(issues: List[Dict[str, str]], severity: str, code: str, message: str) -> None:
    issues.append({"severity": severity, "code": code, "message": message})


def validate(parsed: Dict[str, Any], schema: Dict[str, Any], mode: str, parser_warnings: List[str]) -> Dict[str, Any]:
    issues: List[Dict[str, str]] = []
    for idx, warning in enumerate(parser_warnings, start=1):
        add_issue(issues, "warning", f"parser_warning_{idx}", warning)

    sheets = parsed.get("sheets", [])
    sheet_names = parsed.get("all_sheet_names") or [s.get("name") for s in sheets]
    sheet_by_name = {s.get("name"): s for s in sheets}
    expected_names = schema["strict_sheet_names"]
    detail_schema = schema["detail_sheets"]
    thresholds = schema.get("thresholds", {})

    if not sheets:
        add_issue(issues, "blocking", "no_sheets", "这个 Excel 中没有找到可检查的工作表，请确认文件是否为空或格式是否正确。")

    summary_idx = parsed.get("summary_sheet_index", -1)
    if summary_idx is None or summary_idx < 0:
        add_issue(issues, "blocking", "missing_summary_sheet", "缺少“汇总”工作表。没有汇总页，就无法判断每个明细页对应哪一条结算信息。")
        summary_sheet = None
    else:
        summary_sheet = sheets[summary_idx]
        if summary_idx != 0:
            add_issue(issues, "warning", "summary_not_first", f"“汇总”工作表现在排在第 {summary_idx + 1} 个，标准模板中它通常放在第 1 个。建议确认是否需要调整顺序。")

    if mode == "strict":
        missing_sheets = [name for name in expected_names if name not in sheet_by_name]
        extra_sheets = [name for name in sheet_names if name not in expected_names]
        if missing_sheets:
            add_issue(issues, "blocking", "missing_standard_sheets", "缺少标准工作表：" + "、".join(missing_sheets))
        if extra_sheets:
            add_issue(issues, "warning", "extra_sheets", "发现标准模板之外的工作表：" + "、".join(extra_sheets))
    else:
        if summary_idx is not None and summary_idx >= 0 and len(sheets) < 2:
            add_issue(issues, "blocking", "no_detail_sheets", "除了“汇总”工作表外，没有找到明细工作表。")

    if summary_sheet:
        summary_headers = [clean_header(h) for h in summary_sheet.get("headers", [])]
        missing, ratio = headers_present(summary_headers, schema["summary_required_headers"])
        if missing:
            add_issue(issues, "blocking", "summary_headers_missing", "“汇总”工作表缺少这些必填字段：" + "、".join(missing))
        required_count = len(summary_sheet.get("required_col_indices", []))
        min_required = thresholds.get("summary_min_required_marker_count", 8)
        if required_count < min_required:
            add_issue(issues, "blocking" if mode == "strict" else "warning", "summary_required_markers_insufficient", f"“汇总”工作表中标为“必填”的字段只有 {required_count} 个，少于标准模板要求的 {min_required} 个。")
        summary_rows = int(summary_sheet.get("rows", 0) or 0)
        detail_count = len([name for name in expected_names if name != summary_sheet.get("name") and name in sheet_by_name]) if mode == "strict" else max(len(sheets) - 1, 0)
        if summary_rows == 0:
            add_issue(issues, "blocking", "summary_no_data", "“汇总”工作表里没有填写结算数据。")
        elif summary_rows != 1 and summary_rows < detail_count:
            add_issue(issues, "blocking", "summary_rows_less_than_details", f"“汇总”工作表中的结算记录有 {summary_rows} 行，但明细工作表有 {detail_count} 个，数量对不上，后续无法一一对应。")

    # Detect display-style sheets whose first row is a repeated title, because header detection will become unreliable.
    for sheet in sheets:
        headers = [clean_header(h) for h in sheet.get("headers", [])]
        ratio, repeated_value = repeated_header_ratio(headers)
        if len(headers) >= 10 and ratio > thresholds.get("max_repeated_header_ratio", 0.6):
            add_issue(issues, "blocking", "repeated_title_as_header", f"工作表“{sheet.get('name')}”看起来更像已经排版好的结算单或交付表，不像可直接用于生成 PPT 的原始输入表。")

    detail_names_to_check = list(detail_schema.keys()) if mode == "strict" else [s.get("name") for i, s in enumerate(sheets) if i != summary_idx]
    for name in detail_names_to_check:
        sheet = sheet_by_name.get(name)
        if not sheet:
            continue
        headers = [clean_header(h) for h in sheet.get("headers", [])]
        rows = int(sheet.get("rows", 0) or 0)
        if rows <= 0:
            add_issue(issues, "blocking", "detail_no_data", f"明细工作表“{name}”里没有填写数据。")
        if mode == "strict" and name in detail_schema:
            expected_headers = detail_schema[name].get("critical_headers", [])
            missing, ratio = headers_present(headers, expected_headers)
            min_ratio = thresholds.get("detail_min_header_match_ratio", 0.8)
            if ratio < min_ratio:
                add_issue(issues, "blocking", "detail_header_match_low", f"明细工作表“{name}”缺少较多标准字段，包括：" + "、".join(missing))
            elif missing:
                add_issue(issues, "warning", "detail_headers_partially_missing", f"明细工作表“{name}”缺少部分建议字段：" + "、".join(missing))
            min_marker = detail_schema[name].get("min_required_marker_count", 0)
            marker_count = len(sheet.get("required_col_indices", []))
            if marker_count < min_marker:
                add_issue(issues, "blocking", "detail_required_markers_insufficient", f"明细工作表“{name}”中标为“必填”的字段只有 {marker_count} 个，少于标准模板要求的 {min_marker} 个。")
        if summary_sheet and not sheet.get("summary_context"):
            add_issue(issues, "blocking", "missing_summary_context", f"明细工作表“{name}”没有找到对应的汇总记录，后续生成 PPT 时无法在该页展示正确的结算说明。")

    blocking_count = sum(1 for issue in issues if issue["severity"] == "blocking")
    warning_count = sum(1 for issue in issues if issue["severity"] == "warning")
    conformant = blocking_count == 0

    sheet_metrics = []
    for i, sheet in enumerate(sheets):
        headers = [clean_header(h) for h in sheet.get("headers", [])]
        req_headers = [headers[j] for j in sheet.get("required_col_indices", []) if j < len(headers)]
        sheet_metrics.append({
            "index": i,
            "name": sheet.get("name"),
            "rows": sheet.get("rows"),
            "cols": sheet.get("cols"),
            "required_marker_count": len(req_headers),
            "image_count": len(sheet.get("images", [])),
            "image_column_count": sheet.get("image_column_count", 0),
            "max_images_per_data_row": sheet.get("max_images_per_data_row", 0),
            "has_summary_context": bool(sheet.get("summary_context")),
            "headers": headers,
        })

    return {
        "schema_name": schema.get("schema_name"),
        "mode": mode,
        "file": parsed.get("file"),
        "file_path": parsed.get("file_path"),
        "checked_at": datetime.now().isoformat(timespec="seconds"),
        "conformant": conformant,
        "verdict": "符合标准" if conformant else "不符合标准",
        "blocking_count": blocking_count,
        "warning_count": warning_count,
        "summary_sheet_index": summary_idx,
        "sheet_names": sheet_names,
        "sheet_metrics": sheet_metrics,
        "issues": issues,
    }


def write_markdown_report(result: Dict[str, Any], out_path: Path) -> None:
    lines: List[str] = []
    mode_label = "严格检查" if result.get("mode") == "strict" else "基础检查"
    lines.append("# 结算原始输入文件检查报告\n\n")
    lines.append(f"**文件**：`{result.get('file')}`  \n")
    lines.append(f"**结论**：**{result.get('verdict')}**  \n")
    lines.append(f"**检查方式**：{mode_label}  \n")
    lines.append(f"**检查时间**：{result.get('checked_at')}\n\n")
    lines.append("> 这份报告用于在生成 PPT 之前，先判断 Excel 是否是合格的“结算原始输入文件”。如果结论为“不符合标准”，建议先调整 Excel，再继续制作 PPT。\n\n")
    lines.append("## 工作表概况\n\n")
    lines.append("|序号|工作表名称|数据行数|字段数|必填字段数|图片数量|图片所在字段数|是否能对应汇总页|\n")
    lines.append("|---:|---|---:|---:|---:|---:|---:|---|\n")
    for s in result.get("sheet_metrics", []):
        relation = "是" if s["has_summary_context"] else "否"
        if s["index"] == result.get("summary_sheet_index"):
            relation = "汇总页"
        lines.append(f"|{s['index']}|{s['name']}|{s['rows']}|{s['cols']}|{s['required_marker_count']}|{s['image_count']}|{s['image_column_count']}|{relation}|\n")
    lines.append("\n## 需要关注的问题\n\n")
    if result.get("issues"):
        lines.append("|处理优先级|问题说明|\n|---|---|\n")
        for issue in result["issues"]:
            severity = "必须修正" if issue["severity"] == "blocking" else "建议确认"
            lines.append(f"|{severity}|{issue['message']}|\n")
    else:
        lines.append("未发现必须修正或建议确认的问题。\n")
    lines.append("\n## 下一步建议\n\n")
    if result.get("conformant"):
        lines.append("这个文件符合结算原始输入文件标准，可以继续用于生成 PPT。正式制作前，建议再让用户确认工作表内容、图片数量和需要展示的字段是否完整。\n")
    else:
        lines.append("这个文件暂不建议直接用于生成 PPT。请先按标准模板补齐“汇总”工作表、对应的明细工作表和必填字段，并确认每个明细页都能对应到一条汇总记录。\n")
    out_path.write_text("".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate settlement original-input Excel files before excel-to-pptx conversion.")
    parser.add_argument("input", help="Path to .xlsx file")
    parser.add_argument("--schema", default=str(DEFAULT_SCHEMA), help="Path to standard_schema.json")
    parser.add_argument("--out-dir", default=None, help="Directory for validation outputs")
    parser.add_argument("--mode", choices=["strict", "relaxed"], default="strict", help="strict checks the sample-derived schema; relaxed checks only structural prerequisites")
    parser.add_argument("--fail-on-invalid", action="store_true", help="Return exit code 2 when the workbook is not conformant")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists():
        print(json.dumps({"conformant": False, "verdict": "不符合标准", "issues": [{"severity": "blocking", "code": "file_not_found", "message": f"文件不存在：{input_path}"}]}, ensure_ascii=False, indent=2))
        return 2 if args.fail_on_invalid else 0

    schema = json.loads(Path(args.schema).read_text(encoding="utf-8"))
    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else Path(tempfile.mkdtemp(prefix="settlement_excel_validation_"))
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        parsed, parser_warnings = parse_workbook(input_path, out_dir)
    except Exception as exc:
        result = {
            "schema_name": schema.get("schema_name"),
            "mode": args.mode,
            "file": input_path.name,
            "file_path": str(input_path),
            "checked_at": datetime.now().isoformat(timespec="seconds"),
            "conformant": False,
            "verdict": "不符合标准",
            "blocking_count": 1,
            "warning_count": 0,
            "summary_sheet_index": -1,
            "sheet_names": [],
            "sheet_metrics": [],
            "issues": [{"severity": "blocking", "code": "parse_failed", "message": f"无法打开或读取这个 Excel 文件：{exc}"}],
        }
    else:
        result = validate(parsed, schema, args.mode, parser_warnings)

    result_path = out_dir / "validation_result.json"
    report_path = out_dir / "validation_report.md"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown_report(result, report_path)
    print(json.dumps({
        "file": result.get("file"),
        "verdict": result.get("verdict"),
        "conformant": result.get("conformant"),
        "blocking_count": result.get("blocking_count"),
        "warning_count": result.get("warning_count"),
        "result_json": str(result_path),
        "report_md": str(report_path),
    }, ensure_ascii=False, indent=2))
    if args.fail_on_invalid and not result.get("conformant"):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
