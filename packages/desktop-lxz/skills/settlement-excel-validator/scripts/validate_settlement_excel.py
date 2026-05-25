#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import posixpath
import re
import tempfile
import zipfile
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from xml.etree import ElementTree as ET

import openpyxl
from openpyxl.utils import get_column_letter

SKILL_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SCHEMA = SKILL_DIR / "references" / "standard_schema.json"
IMAGE_HEADER_KEYWORDS = ["截图", "图片", "凭证", "发票", "付款", "合同", "下单", "数据证明", "影像", "照片"]
OPTIONAL_HEADER_KEYWORDS = ["备注", "说明", "补充", "其他", "可选"]


def clean_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).replace("\r", "").replace("\n", "").strip()
    return text or None


def clean_header(value: Any) -> str:
    return clean_text(value) or ""


def normalize_header(value: Any) -> str:
    text = clean_header(value).lower()
    for old, new in {"（": "(", "）": ")", "／": "/", "：": ":", "－": "-", "—": "-", "、": "/"}.items():
        text = text.replace(old, new)
    for token in [" ", "\t", "\u3000", "\n", "\r"]:
        text = text.replace(token, "")
    text = re.sub(r"\((必填|required|选填|可选)\)", "", text, flags=re.I)
    text = text.replace("必填", "").replace("选填", "").replace("可选", "")
    return text


def normalize_match_text(value: Any) -> str:
    """Normalize sheet names and summary block values for fuzzy one-to-one matching."""
    text = normalize_header(value)
    text = re.sub(r"^[0-9０-９一二三四五六七八九十]+[-_.、．\s]*", "", text)
    text = text.replace("工作表", "").replace("sheet", "")
    return text


def fuzzy_text_match(left: Any, right: Any) -> bool:
    left_norm = normalize_match_text(left)
    right_norm = normalize_match_text(right)
    if not left_norm or not right_norm:
        return False
    return left_norm == right_norm or left_norm in right_norm or right_norm in left_norm


def is_blank(value: Any) -> bool:
    return clean_text(value) is None


def is_image_like_header(header: str) -> bool:
    norm = normalize_header(header)
    return any(normalize_header(keyword) in norm for keyword in IMAGE_HEADER_KEYWORDS)


def is_optional_header(header: str, config: Dict[str, Any]) -> bool:
    norm = normalize_header(header)
    optional_headers = config.get("optional_headers", [])
    optional_keywords = config.get("optional_header_keywords", OPTIONAL_HEADER_KEYWORDS)
    if any(normalize_header(item) == norm for item in optional_headers):
        return True
    return any(normalize_header(keyword) and normalize_header(keyword) in norm for keyword in optional_keywords)


def truncate_list(items: List[Any], limit: int = 50) -> str:
    values = [str(item) for item in items]
    return "、".join(values) if len(values) <= limit else "、".join(values[:limit]) + f" 等 {len(values)} 项"


def expand_merged_cells(ws) -> Dict[Tuple[int, int], Any]:
    merged_map: Dict[Tuple[int, int], Any] = {}
    for merged_range in ws.merged_cells.ranges:
        value = ws.cell(merged_range.min_row, merged_range.min_col).value
        for row in range(merged_range.min_row, merged_range.max_row + 1):
            for col in range(merged_range.min_col, merged_range.max_col + 1):
                merged_map[(row, col)] = value
    return merged_map


def local_xml_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def relationship_id(element) -> Optional[str]:
    for key, value in element.attrib.items():
        if key == "id" or key.endswith("}id"):
            return value
    return None


def parse_relationships(zf: zipfile.ZipFile, rels_path: str) -> Dict[str, str]:
    if rels_path not in zf.namelist():
        return {}
    root = ET.fromstring(zf.read(rels_path))
    rels: Dict[str, str] = {}
    for rel in root:
        if local_xml_name(rel.tag) == "Relationship":
            rid = rel.attrib.get("Id")
            target = rel.attrib.get("Target")
            if rid and target:
                rels[rid] = target
    return rels


def resolve_relationship_target(rels_path: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    base_dir = rels_path.split("/_rels/", 1)[0]
    return posixpath.normpath(posixpath.join(base_dir, target))


def first_descendant_text(element, name: str) -> Optional[str]:
    for child in element.iter():
        if local_xml_name(child.tag) == name:
            return child.text
    return None


def anchor_contains_picture(anchor) -> bool:
    return any(local_xml_name(child.tag) == "pic" for child in anchor.iter())


def extract_images_from_workbook_archive(input_path: Path) -> Dict[str, List[Dict[str, Any]]]:
    """Read picture anchors directly from XLSX drawing XML as a fallback."""
    images_by_sheet: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    try:
        with zipfile.ZipFile(input_path) as zf:
            names = set(zf.namelist())
            if "xl/workbook.xml" not in names or "xl/_rels/workbook.xml.rels" not in names:
                return {}
            workbook_root = ET.fromstring(zf.read("xl/workbook.xml"))
            workbook_rels = parse_relationships(zf, "xl/_rels/workbook.xml.rels")
            sheet_parts: List[Tuple[str, str]] = []
            for element in workbook_root.iter():
                if local_xml_name(element.tag) != "sheet":
                    continue
                sheet_name = element.attrib.get("name")
                rid = relationship_id(element)
                target = workbook_rels.get(rid or "")
                if not sheet_name or not target:
                    continue
                sheet_parts.append((sheet_name, resolve_relationship_target("xl/_rels/workbook.xml.rels", target)))
            for sheet_name, sheet_part in sheet_parts:
                if sheet_part not in names:
                    continue
                sheet_rels_path = posixpath.join(posixpath.dirname(sheet_part), "_rels", posixpath.basename(sheet_part) + ".rels")
                sheet_rels = parse_relationships(zf, sheet_rels_path)
                sheet_root = ET.fromstring(zf.read(sheet_part))
                drawing_parts: List[str] = []
                for element in sheet_root.iter():
                    if local_xml_name(element.tag) != "drawing":
                        continue
                    rid = relationship_id(element)
                    target = sheet_rels.get(rid or "")
                    if target:
                        drawing_parts.append(resolve_relationship_target(sheet_rels_path, target))
                for drawing_part in drawing_parts:
                    if drawing_part not in names:
                        continue
                    drawing_root = ET.fromstring(zf.read(drawing_part))
                    for anchor in drawing_root:
                        if local_xml_name(anchor.tag) not in {"oneCellAnchor", "twoCellAnchor"}:
                            continue
                        if not anchor_contains_picture(anchor):
                            continue
                        row_text = first_descendant_text(anchor, "row")
                        col_text = first_descendant_text(anchor, "col")
                        try:
                            row_idx = int(row_text) + 1 if row_text is not None else None
                            col_idx = int(col_text) + 1 if col_text is not None else None
                        except ValueError:
                            row_idx = col_idx = None
                        images_by_sheet[sheet_name].append({
                            "index": len(images_by_sheet[sheet_name]),
                            "anchor_row_original": row_idx,
                            "anchor_col_index_original": col_idx,
                            "anchor_col_original": get_column_letter(col_idx) if col_idx else None,
                            "source": "xlsx_drawing_xml_fallback",
                        })
    except Exception:
        return {}
    return dict(images_by_sheet)


def extract_images(ws, fallback_images: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    images: List[Dict[str, Any]] = []
    for idx, img in enumerate(getattr(ws, "_images", []) or []):
        anchor = getattr(img, "anchor", None)
        row_idx = col_idx = None
        if hasattr(anchor, "_from"):
            row_idx = getattr(anchor._from, "row", None)
            col_idx = getattr(anchor._from, "col", None)
            row_idx = row_idx + 1 if row_idx is not None else None
            col_idx = col_idx + 1 if col_idx is not None else None
        images.append({"index": idx, "anchor_row_original": row_idx, "anchor_col_index_original": col_idx, "anchor_col_original": get_column_letter(col_idx) if col_idx else None, "source": "openpyxl"})
    if images:
        return images
    return [dict(img) for img in (fallback_images or [])]


def build_compact_matrix(ws, merged_map: Dict[Tuple[int, int], Any], images: List[Dict[str, Any]]) -> Dict[str, Any]:
    raw: List[List[Any]] = []
    row_has_value: Set[int] = set()
    col_has_value: Set[int] = set()
    max_row = max(ws.max_row or 1, max([img.get("anchor_row_original") or 0 for img in images] or [0]))
    max_col = max(ws.max_column or 1, max([img.get("anchor_col_index_original") or 0 for img in images] or [0]))
    for r in range(1, max_row + 1):
        row_values = []
        for c in range(1, max_col + 1):
            value = clean_text(merged_map.get((r, c), ws.cell(r, c).value))
            row_values.append(value)
            if value is not None:
                row_has_value.add(r)
                col_has_value.add(c)
        raw.append(row_values)
    for img in images:
        if img.get("anchor_row_original"):
            row_has_value.add(int(img["anchor_row_original"]))
        if img.get("anchor_col_index_original"):
            col_has_value.add(int(img["anchor_col_index_original"]))
    keep_rows = [r for r in range(1, max_row + 1) if r in row_has_value]
    keep_cols = [c for c in range(1, max_col + 1) if c in col_has_value]
    old_to_new_row = {old: new for new, old in enumerate(keep_rows, start=1)}
    old_to_new_col = {old: new for new, old in enumerate(keep_cols, start=1)}
    new_to_old_row = {new: old for old, new in old_to_new_row.items()}
    new_to_old_col = {new: old for old, new in old_to_new_col.items()}
    matrix = [[raw[r - 1][c - 1] for c in keep_cols] for r in keep_rows]
    return {"matrix": matrix, "old_to_new_row": old_to_new_row, "old_to_new_col": old_to_new_col, "new_to_old_row": new_to_old_row, "new_to_old_col": new_to_old_col, "removed_blank_rows": [r for r in range(1, max_row + 1) if r not in old_to_new_row], "removed_blank_cols": [get_column_letter(c) for c in range(1, max_col + 1) if c not in old_to_new_col]}


def header_score(row: List[Any], expected_headers: Optional[List[str]] = None) -> int:
    non_blank = sum(1 for value in row if not is_blank(value))
    required_markers = sum(1 for value in row if "必填" in clean_header(value))
    image_headers = sum(1 for value in row if is_image_like_header(clean_header(value)))
    expected_matches = 0
    if expected_headers:
        row_norm = {normalize_header(value) for value in row if clean_header(value)}
        expected_matches = sum(1 for item in expected_headers if normalize_header(item) in row_norm)
    return non_blank + required_markers * 3 + image_headers * 2 + expected_matches * 5


def detect_header_row(matrix: List[List[Any]], expected_headers: Optional[List[str]] = None) -> int:
    candidates = []
    for idx, row in enumerate(matrix[: min(15, len(matrix))], start=1):
        if any(not is_blank(value) for value in row):
            candidates.append((header_score(row, expected_headers), idx))
    if not candidates:
        return 1
    candidates.sort(key=lambda item: (item[0], -item[1]), reverse=True)
    return candidates[0][1]


def row_is_duplicate_header(row: List[Any], headers: List[str]) -> bool:
    """Detect repeated header rows caused by vertically merged cells or copied headers."""
    if not headers:
        return False
    row_values = [normalize_header(value) for value in row[: len(headers)]]
    header_values = [normalize_header(header) for header in headers]
    comparable = [(rv, hv) for rv, hv in zip(row_values, header_values) if hv]
    if not comparable:
        return False
    matches = sum(1 for rv, hv in comparable if rv == hv)
    non_blank = sum(1 for rv, _hv in comparable if rv)
    return non_blank >= 3 and matches / max(non_blank, 1) >= 0.8


def map_images_to_compact(images: List[Dict[str, Any]], compact: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[Tuple[int, int], int]]:
    image_cells: Dict[Tuple[int, int], int] = defaultdict(int)
    mapped: List[Dict[str, Any]] = []
    for img in images:
        r = img.get("anchor_row_original")
        c = img.get("anchor_col_index_original")
        new_row = compact["old_to_new_row"].get(r) if r else None
        new_col = compact["old_to_new_col"].get(c) if c else None
        new_img = dict(img)
        new_img["anchor_row_compact"] = new_row
        new_img["anchor_col_index_compact"] = new_col
        new_img["anchor_col_compact"] = get_column_letter(new_col) if new_col else None
        mapped.append(new_img)
        if new_row and new_col:
            image_cells[(new_row, new_col)] += 1
    return mapped, image_cells


def parse_sheet_light(ws, expected_headers: Optional[List[str]] = None, fallback_images: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    images_raw = extract_images(ws, fallback_images)
    compact = build_compact_matrix(ws, expand_merged_cells(ws), images_raw)
    matrix = compact["matrix"]
    images, image_cells = map_images_to_compact(images_raw, compact)
    image_cols = {col for (_, col), count in image_cells.items() if count > 0}
    if not matrix:
        return {"name": ws.title, "rows": 0, "cols": 0, "headers": [], "header_original_cols": [], "required_col_indices": [], "data": [], "data_compact_rows": [], "data_original_rows": [], "images": images, "image_cells": {}, "image_column_indices": [], "image_column_count": 0, "max_images_per_data_row": 0, "blank_original_rows_in_data_area": [], "merged_ranges": [str(r) for r in ws.merged_cells.ranges], "normalization": {"removed_blank_rows": compact["removed_blank_rows"], "removed_blank_cols": compact["removed_blank_cols"], "table_matrix_includes_image_only_rows_cols": True, "merged_cells_expanded": len(ws.merged_cells.ranges)}, "header_row": 1, "header_end_row": 1, "data_start_row": 1}
    header_row = detect_header_row(matrix, expected_headers)
    headers = [clean_header(value) or f"列{i + 1}" for i, value in enumerate(matrix[header_row - 1])]
    data_start = header_row + 1
    rows: List[List[Any]] = []
    data_original_rows: List[int] = []
    data_compact_rows: List[int] = []
    images_per_data_row: List[int] = []
    for compact_row_index, row in enumerate(matrix[data_start - 1 :], start=data_start):
        padded = list(row[: len(headers)])
        if len(padded) < len(headers):
            padded += [None] * (len(headers) - len(padded))
        if row_is_duplicate_header(padded, headers):
            continue
        has_text = any(not is_blank(value) for value in padded)
        has_image = any((compact_row_index, col_idx) in image_cells for col_idx in range(1, len(headers) + 1))
        if has_text or has_image:
            rows.append(padded)
            data_compact_rows.append(compact_row_index)
            data_original_rows.append(compact["new_to_old_row"].get(compact_row_index))
            images_per_data_row.append(sum(image_cells.get((compact_row_index, col_idx), 0) for col_idx in range(1, len(headers) + 1)))
    blank_original_rows_in_data_area: List[int] = []
    if data_original_rows:
        present_rows = set(data_original_rows)
        for original_row in range(min(data_original_rows), max(data_original_rows) + 1):
            if original_row not in present_rows:
                blank_original_rows_in_data_area.append(original_row)
    return {"name": ws.title, "rows": len(rows), "cols": len(headers), "headers": headers, "header_original_cols": [compact["new_to_old_col"].get(i + 1) for i in range(len(headers))], "required_col_indices": [idx for idx, h in enumerate(headers) if "必填" in h], "data": rows, "data_compact_rows": data_compact_rows, "data_original_rows": data_original_rows, "images": images, "image_cells": {f"{r}:{c}": count for (r, c), count in image_cells.items()}, "image_column_indices": sorted([col - 1 for col in image_cols if 1 <= col <= len(headers)]), "image_column_count": len(image_cols), "max_images_per_data_row": max(images_per_data_row) if images_per_data_row else 0, "blank_original_rows_in_data_area": blank_original_rows_in_data_area, "merged_ranges": [str(r) for r in ws.merged_cells.ranges], "normalization": {"removed_blank_rows": compact["removed_blank_rows"], "removed_blank_cols": compact["removed_blank_cols"], "table_matrix_includes_image_only_rows_cols": True, "merged_cells_expanded": len(ws.merged_cells.ranges)}, "header_row": header_row, "header_end_row": header_row, "data_start_row": data_start}


def is_summary_sheet_name(name: str, schema: Dict[str, Any]) -> bool:
    normalized_name = normalize_header(name)
    return any(normalize_header(keyword) in normalized_name for keyword in schema.get("summary_sheet_keywords", ["汇总", "summary"]))


def parse_light(input_path: Path, schema: Dict[str, Any]) -> Dict[str, Any]:
    archive_images_by_sheet = extract_images_from_workbook_archive(input_path)
    wb = openpyxl.load_workbook(input_path, data_only=False)
    detail_schema = schema.get("detail_sheets", {})
    summary_headers = schema.get("summary_required_headers", [])
    sheets = []
    for idx, ws in enumerate(wb.worksheets):
        # Business rule: the first worksheet is always treated as the summary sheet,
        # regardless of whether it is literally named “汇总”.
        expected = summary_headers if idx == 0 else detail_schema.get(ws.title, {}).get("critical_headers", [])
        sheets.append(parse_sheet_light(ws, expected, archive_images_by_sheet.get(ws.title, [])))
    summary_idx = 0 if sheets else -1
    return {"file": input_path.name, "file_path": str(input_path), "all_sheet_names": [ws.title for ws in wb.worksheets], "summary_sheet_index": summary_idx, "sheets": sheets}


def parse_workbook(input_path: Path, schema: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    return parse_light(input_path, schema), []


def headers_present(actual: List[str], expected: List[str]) -> Tuple[List[str], float]:
    actual_norm = {normalize_header(h) for h in actual}
    missing = [h for h in expected if normalize_header(h) not in actual_norm]
    return missing, 1.0 if not expected else (len(expected) - len(missing)) / len(expected)


def repeated_header_ratio(headers: List[str]) -> Tuple[float, Optional[str]]:
    cleaned = [normalize_header(h) for h in headers if normalize_header(h)]
    if not cleaned:
        return 0.0, None
    value, count = Counter(cleaned).most_common(1)[0]
    return count / len(cleaned), value


def add_issue(issues: List[Dict[str, str]], severity: str, code: str, message: str) -> None:
    issues.append({"severity": severity, "code": code, "message": message})


def find_header_index_by_alias(headers: List[str], aliases: List[str]) -> Optional[int]:
    normalized_aliases = [normalize_header(alias) for alias in aliases if normalize_header(alias)]
    header_norms = [normalize_header(header) for header in headers]
    for idx, header_norm in enumerate(header_norms):
        if header_norm in normalized_aliases:
            return idx
    for idx, header_norm in enumerate(header_norms):
        if any(alias and alias in header_norm for alias in normalized_aliases):
            return idx
    for idx, header_norm in enumerate(header_norms):
        if any(header_norm and header_norm in alias for alias in normalized_aliases):
            return idx
    return None


def has_image_at(sheet: Dict[str, Any], compact_row: int, col_index_zero_based: int) -> bool:
    return int(sheet.get("image_cells", {}).get(f"{compact_row}:{col_index_zero_based + 1}", 0) or 0) > 0


def cell_has_content(sheet: Dict[str, Any], data_row_index: int, col_index: int) -> bool:
    data = sheet.get("data", [])
    compact_rows = sheet.get("data_compact_rows", [])
    if data_row_index >= len(data) or col_index >= len(data[data_row_index]):
        return False
    if not is_blank(data[data_row_index][col_index]):
        return True
    return data_row_index < len(compact_rows) and has_image_at(sheet, compact_rows[data_row_index], col_index)


def validate_image_naming_fields(sheet: Dict[str, Any], schema: Dict[str, Any], issues: List[Dict[str, str]]) -> None:
    image_config = schema.get("image_validation", {})
    if not image_config.get("check_image_naming_fields", False):
        return
    if not sheet.get("images"):
        return
    headers = [clean_header(h) for h in sheet.get("headers", [])]
    matched_fields: Dict[str, int] = {}
    missing_fields = []
    for field in schema.get("image_naming_required_fields", []):
        canonical = field.get("canonical") or field.get("name")
        aliases = list(field.get("aliases", [])) + ([canonical] if canonical else [])
        idx = find_header_index_by_alias(headers, aliases)
        if idx is None:
            missing_fields.append(canonical)
        else:
            matched_fields[str(canonical)] = idx
    if missing_fields:
        add_issue(issues, "blocking", "image_naming_headers_missing", f"工作表“{sheet.get('name')}”包含图片，但缺少后续图片命名所需字段：{truncate_list(missing_fields)}。这些字段可以使用同义列名，例如“媒体名称（必填）”也可匹配“媒体名称”。")
        return
    missing_by_row: Dict[str, List[int]] = defaultdict(list)
    for data_idx, original_row in enumerate(sheet.get("data_original_rows", [])):
        compact_row = sheet.get("data_compact_rows", [None] * len(sheet.get("data", [])))[data_idx]
        row_has_any_image = any(compact_row and has_image_at(sheet, compact_row, col_idx) for col_idx in range(len(headers)))
        if not row_has_any_image:
            continue
        for canonical, col_idx in matched_fields.items():
            if not cell_has_content(sheet, data_idx, col_idx):
                missing_by_row[canonical].append(original_row or data_idx + 1)
    for canonical, rows in missing_by_row.items():
        add_issue(issues, "blocking", "image_naming_value_missing", f"工作表“{sheet.get('name')}”中有图片的数据行缺少图片命名字段“{canonical}”的内容，涉及 Excel 原始行号：{truncate_list(rows)}。")


def header_has_required_marker(header: str) -> bool:
    normalized = normalize_header(header)
    raw = clean_header(header).lower()
    return "必填" in raw or "required" in raw or "required" in normalized


def is_formula_value(value: Any) -> bool:
    return isinstance(value, str) and value.strip().startswith("=")


def row_text_values(sheet: Dict[str, Any], data_row_index: int) -> List[str]:
    data = sheet.get("data", [])
    if data_row_index >= len(data):
        return []
    return [clean_text(value) or "" for value in data[data_row_index] if not is_blank(value)]


def row_has_text_content(sheet: Dict[str, Any], data_row_index: int) -> bool:
    data = sheet.get("data", [])
    if data_row_index >= len(data):
        return False
    # A trailing subtotal row often contains only formulas such as =SUM(...). Treat it as non-data.
    return any((not is_blank(value)) and (not is_formula_value(value)) for value in data[data_row_index])


def is_total_or_note_row(sheet: Dict[str, Any], data_row_index: int, config: Dict[str, Any]) -> bool:
    data = sheet.get("data", [])
    if data_row_index >= len(data):
        return True
    row = data[data_row_index]
    non_blank_values = [clean_text(value) for value in row if not is_blank(value)]
    if not non_blank_values:
        return True
    non_formula_values = [value for value in non_blank_values if not is_formula_value(value)]
    if not non_formula_values:
        return True
    joined = normalize_header("".join(non_formula_values))
    keywords = config.get("excluded_row_keywords", ["合计", "汇总", "小计", "总计", "说明", "备注", "注:", "注："] )
    if len(non_formula_values) <= int(config.get("excluded_row_max_non_formula_cells", 2)):
        if any(normalize_header(keyword) and normalize_header(keyword) in joined for keyword in keywords):
            return True
    # Rows with formulas plus only a short label such as “合计” should not be treated as detail rows.
    formula_count = sum(1 for value in non_blank_values if is_formula_value(value))
    if formula_count and any(normalize_header(keyword) and normalize_header(keyword) in joined for keyword in keywords):
        return True
    return False


def image_like_column_indices(sheet: Dict[str, Any], headers: List[str], config: Dict[str, Any]) -> Set[int]:
    image_cols: Set[int] = set(sheet.get("image_column_indices", []))
    if sheet.get("images") and config.get("check_image_like_headers", True):
        image_cols.update(idx for idx, header in enumerate(headers) if is_image_like_header(header))
    return {idx for idx in image_cols if 0 <= idx < len(headers)}


def required_image_column_indices(sheet: Dict[str, Any], headers: List[str], schema: Dict[str, Any], config: Optional[Dict[str, Any]] = None) -> Set[int]:
    """Return image columns that must contain a real anchored image on every active data row.

    Images are not mandatory at worksheet level. A sheet may contain no images at all. However,
    if a column is explicitly marked as required and is image-like, such as “见刊截图（必填）”,
    that column is still a row-level required image field. Text placeholders in such columns do
    not satisfy the rule; the row must contain a real embedded image anchored to that column.
    """
    config = config or {}
    sheet_name = sheet.get("name")
    detail_rule = schema.get("detail_sheets", {}).get(sheet_name, {}) if sheet_name else {}
    required_headers = list(detail_rule.get("required_image_headers", []))
    required_headers += list(schema.get("required_image_headers", []))
    indices: Set[int] = set()
    for required_header in required_headers:
        idx = find_header_index_by_alias(headers, [required_header])
        if idx is not None:
            indices.add(idx)
    if config.get("enforce_required_image_headers", True):
        for idx, header in enumerate(headers):
            if is_image_like_header(header) and header_has_required_marker(header):
                indices.add(idx)
    return {idx for idx in indices if 0 <= idx < len(headers)}


def detected_image_column_indices(sheet: Dict[str, Any], headers: List[str]) -> Set[int]:
    """Return zero-based column indices that actually contain at least one embedded image.

    This function is intentionally based on real image anchors, not on header names. A worksheet
    may have no images at all. But once a column has one or more real images anchored inside the
    parsed table area, that column is treated as an actual image column and can be checked row by
    row against the active data rows.
    """
    image_cols: Set[int] = set()
    for key, count in sheet.get("image_cells", {}).items():
        if not count:
            continue
        try:
            _row, col = key.split(":", 1)
            col_idx = int(col) - 1
        except Exception:
            continue
        if 0 <= col_idx < len(headers):
            image_cols.add(col_idx)
    # Keep the parser-level summary as a fallback, but never invent columns from header names here.
    for col_idx in sheet.get("image_column_indices", []):
        if 0 <= int(col_idx) < len(headers):
            image_cols.add(int(col_idx))
    return image_cols


def select_image_columns_to_enforce(sheet: Dict[str, Any], headers: List[str], schema: Dict[str, Any], config: Dict[str, Any]) -> Set[int]:
    """Return image columns that must be checked row by row.

    Business rule: images are optional at worksheet level, so a sheet with no images is valid.
    However, if a worksheet contains real embedded images in a column, that column is an actual
    image column. The validator must then check every active data row in that column and report
    the exact rows without real images. This is not limited to headers marked “必填”. By default,
    header names alone do not create an image requirement; only detected real images do.
    """
    image_cols: Set[int] = set()
    if config.get("enforce_detected_image_columns", True):
        image_cols.update(detected_image_column_indices(sheet, headers))
    if config.get("enforce_required_image_headers", False):
        image_cols.update(required_image_column_indices(sheet, headers, schema, config))
    return {idx for idx in image_cols if 0 <= idx < len(headers)}


def active_row_indices_for_completeness(sheet: Dict[str, Any], enforced_image_cols: Set[int], config: Dict[str, Any]) -> List[int]:
    active: List[int] = []
    compact_rows = sheet.get("data_compact_rows", [])
    for data_idx in range(len(sheet.get("data", []))):
        if is_total_or_note_row(sheet, data_idx, config):
            continue
        if row_has_text_content(sheet, data_idx):
            active.append(data_idx)
            continue
        compact_row = compact_rows[data_idx] if data_idx < len(compact_rows) else None
        if compact_row and any(has_image_at(sheet, compact_row, col_idx) for col_idx in enforced_image_cols):
            active.append(data_idx)
    return active


def validate_content_completeness(sheet: Dict[str, Any], schema: Dict[str, Any], issues: List[Dict[str, str]]) -> None:
    config = schema.get("content_completeness", {})
    if not config.get("enabled", True):
        return
    headers = [clean_header(h) for h in sheet.get("headers", [])]
    data = sheet.get("data", [])
    original_rows = sheet.get("data_original_rows", [])
    if not data:
        return

    enforced_image_cols = select_image_columns_to_enforce(sheet, headers, schema, config)
    active_indices = active_row_indices_for_completeness(sheet, enforced_image_cols, config)
    if not active_indices:
        return

    active_original_rows = sorted({original_rows[idx] for idx in active_indices if idx < len(original_rows) and original_rows[idx]})
    if active_original_rows:
        min_active_row, max_active_row = active_original_rows[0], active_original_rows[-1]
        blank_rows = [row for row in sheet.get("blank_original_rows_in_data_area", []) if min_active_row <= row <= max_active_row]
    else:
        blank_rows = []
    if blank_rows:
        add_issue(issues, "blocking" if config.get("blank_rows_blocking", True) else "warning", "blank_rows_inside_data_area", f"工作表“{sheet.get('name')}”的数据区域中存在空行，涉及 Excel 原始行号：{truncate_list(blank_rows)}。请删除空行或补齐该行内容。")

    cols_to_check: Set[int] = set()
    for idx, header in enumerate(headers):
        if not header or header.startswith("列") or is_optional_header(header, config):
            continue
        if is_image_like_header(header) and config.get("image_headers_optional", True):
            continue
        cols_to_check.add(idx)
    cols_to_check.update(enforced_image_cols)

    for col_idx in sorted(cols_to_check):
        if col_idx >= len(headers):
            continue
        header = headers[col_idx]
        present_rows = []
        missing_rows = []
        for data_idx in active_indices:
            original_row = original_rows[data_idx] if data_idx < len(original_rows) else data_idx + 1
            if col_idx in enforced_image_cols:
                compact_rows = sheet.get("data_compact_rows", [])
                compact_row = compact_rows[data_idx] if data_idx < len(compact_rows) else None
                has_content = bool(compact_row and has_image_at(sheet, compact_row, col_idx))
            else:
                has_content = cell_has_content(sheet, data_idx, col_idx)
            if has_content:
                present_rows.append(original_row)
            else:
                missing_rows.append(original_row)
        if missing_rows:
            issue_code = "image_column_content_missing" if col_idx in enforced_image_cols else "column_content_missing"
            if issue_code == "image_column_content_missing":
                add_issue(
                    issues,
                    "blocking" if config.get("partial_columns_blocking", True) else "warning",
                    issue_code,
                    f"工作表“{sheet.get('name')}”字段“{header}”被识别为实际有图列，已在该列识别到 {len(present_rows)} 个有真实图片的数据行，但仍有数据行缺少真实图片，涉及 Excel 原始行号：{truncate_list(missing_rows)}。请补齐这些行的图片，或确认该列不应作为逐行图片列后再调整规则。"
                )
            else:
                add_issue(issues, "blocking" if config.get("partial_columns_blocking", True) else "warning", issue_code, f"工作表“{sheet.get('name')}”字段“{header}”存在数据行缺少内容，涉及 Excel 原始行号：{truncate_list(missing_rows)}。该列按当前规则属于数据区必检字段，请补齐后再继续。")


def extract_summary_block_values(summary_sheet: Dict[str, Any], config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract values from the first summary-sheet column after merged-cell expansion."""
    values: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for data_idx, row in enumerate(summary_sheet.get("data", [])):
        if is_total_or_note_row(summary_sheet, data_idx, config):
            continue
        if not row:
            continue
        value = clean_text(row[0])
        if not value or is_formula_value(value):
            continue
        norm = normalize_match_text(value)
        if not norm or norm in seen:
            continue
        seen.add(norm)
        original_rows = summary_sheet.get("data_original_rows", [])
        original_row = original_rows[data_idx] if data_idx < len(original_rows) else data_idx + 1
        values.append({"value": value, "normalized": norm, "data_row_index": data_idx, "original_row": original_row})
    return values


def match_summary_blocks_to_detail_sheets(summary_sheet: Dict[str, Any], detail_sheets: List[Dict[str, Any]], schema: Dict[str, Any]) -> Dict[str, Any]:
    config = schema.get("content_completeness", {})
    blocks = extract_summary_block_values(summary_sheet, config)
    detail_matches: Dict[str, List[Dict[str, Any]]] = {}
    block_matches: Dict[str, List[str]] = {}
    for block in blocks:
        matches = [sheet.get("name") for sheet in detail_sheets if fuzzy_text_match(block.get("value"), sheet.get("name"))]
        block_matches[block.get("value", "")] = [name for name in matches if name]
    for sheet in detail_sheets:
        name = sheet.get("name")
        if not name:
            continue
        matches = [block for block in blocks if fuzzy_text_match(block.get("value"), name)]
        detail_matches[name] = matches
        if matches:
            first = matches[0]
            sheet["summary_context"] = {
                "summary_sheet_name": summary_sheet.get("name"),
                "summary_row_index": first.get("data_row_index"),
                "summary_row_number": first.get("original_row"),
                "summary_block_value": first.get("value"),
                "detail_sheet_name": name,
                "display_mode": "matched_by_summary_first_column",
            }
    return {"blocks": blocks, "block_matches": block_matches, "detail_matches": detail_matches}


def validate_summary_block_sheet_correspondence(summary_sheet: Dict[str, Any], detail_sheets: List[Dict[str, Any]], schema: Dict[str, Any], issues: List[Dict[str, str]]) -> None:
    matching = match_summary_blocks_to_detail_sheets(summary_sheet, detail_sheets, schema)
    blocks = matching.get("blocks", [])
    if not blocks and detail_sheets:
        add_issue(issues, "blocking", "summary_block_values_missing", f"汇总工作表“{summary_sheet.get('name')}”第一列未提取到可匹配明细工作表的板块值。第一列默认视为板块列，请填写与后续分表名称可对应的板块信息。")
        return
    unmatched_blocks = [f"{block.get('value')}（原始行 {block.get('original_row')}）" for block in blocks if not matching.get("block_matches", {}).get(block.get("value", ""))]
    if unmatched_blocks:
        add_issue(issues, "blocking", "summary_block_without_detail_sheet", "汇总表第一列存在找不到对应分表的板块值：" + truncate_list(unmatched_blocks) + "。请确认板块名称是否能与后续工作表名称匹配。")
    unmatched_details = [sheet.get("name") for sheet in detail_sheets if not matching.get("detail_matches", {}).get(sheet.get("name"), [])]
    if unmatched_details:
        add_issue(issues, "blocking", "detail_sheet_without_summary_block", "存在分表找不到汇总表第一列对应板块值：" + truncate_list(unmatched_details) + "。请在汇总表第一列补齐可匹配这些分表名称的板块信息。")


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
        add_issue(issues, "blocking", "missing_summary_sheet", "没有找到可作为汇总表的第一个工作表。第一个 sheet 默认应为汇总表，用来判断每个分表对应哪一条结算信息。")
        summary_sheet = None
    else:
        summary_sheet = sheets[summary_idx]
        if summary_idx != 0:
            add_issue(issues, "warning", "summary_not_first", f"当前汇总表排在第 {summary_idx + 1} 个。按新规则，第一个 sheet 默认应为汇总表，建议确认工作表顺序。")
    if mode == "strict":
        expected_detail_names = [name for name in expected_names if name not in schema.get("summary_sheet_keywords", []) and not is_summary_sheet_name(name, schema)]
        actual_detail_names = [s.get("name") for i, s in enumerate(sheets) if i != summary_idx]
        missing_sheets = [name for name in expected_detail_names if name not in sheet_by_name]
        extra_sheets = [name for name in actual_detail_names if name not in expected_detail_names]
        if missing_sheets:
            add_issue(issues, "blocking", "missing_standard_sheets", "缺少标准分表：" + "、".join(missing_sheets))
        if extra_sheets:
            add_issue(issues, "warning", "extra_sheets", "发现标准模板之外的分表：" + "、".join(extra_sheets))
    elif summary_idx is not None and summary_idx >= 0 and len(sheets) < 2:
        add_issue(issues, "blocking", "no_detail_sheets", "除了“汇总”工作表外，没有找到明细工作表。")
    if summary_sheet:
        detail_sheets_for_matching = [s for i, s in enumerate(sheets) if i != summary_idx]
        validate_summary_block_sheet_correspondence(summary_sheet, detail_sheets_for_matching, schema, issues)
        summary_headers = [clean_header(h) for h in summary_sheet.get("headers", [])]
        # The first summary column is positional and may not literally be named “板块”.
        summary_required_headers = [h for h in schema["summary_required_headers"] if "板块" not in clean_header(h)]
        missing, _ = headers_present(summary_headers, summary_required_headers)
        if missing:
            add_issue(issues, "blocking", "summary_headers_missing", f"汇总工作表“{summary_sheet.get('name')}”缺少这些必填字段：" + "、".join(missing))
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
    for sheet in sheets:
        headers = [clean_header(h) for h in sheet.get("headers", [])]
        ratio, _ = repeated_header_ratio(headers)
        if len(headers) >= 10 and ratio > thresholds.get("max_repeated_header_ratio", 0.6):
            add_issue(issues, "blocking", "repeated_title_as_header", f"工作表“{sheet.get('name')}”看起来更像已经排版好的结算单或交付表，不像可直接用于生成 PPT 的原始输入表。")
    detail_names_to_check = [s.get("name") for i, s in enumerate(sheets) if i != summary_idx]
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
            if schema.get("image_validation", {}).get("warn_when_expected_images_missing", False) and detail_schema[name].get("expect_images") and not sheet.get("images"):
                add_issue(issues, "warning", "expected_images_missing", f"明细工作表“{name}”按模板通常应包含截图或凭证图片，但当前没有识别到图片。请确认图片是否已放入表格。")
        if summary_sheet and not sheet.get("summary_context"):
            add_issue(issues, "blocking", "missing_summary_context", f"明细工作表“{name}”没有找到对应的汇总记录，后续生成 PPT 时无法在该页展示正确的结算说明。")
        validate_image_naming_fields(sheet, schema, issues)
        validate_content_completeness(sheet, schema, issues)
    if summary_sheet:
        validate_image_naming_fields(summary_sheet, schema, issues)
        validate_content_completeness(summary_sheet, schema, issues)
    blocking_count = sum(1 for issue in issues if issue["severity"] == "blocking")
    warning_count = sum(1 for issue in issues if issue["severity"] == "warning")
    conformant = blocking_count == 0
    sheet_metrics = []
    for i, sheet in enumerate(sheets):
        headers = [clean_header(h) for h in sheet.get("headers", [])]
        image_cols = [headers[idx] for idx in sheet.get("image_column_indices", []) if idx < len(headers)]
        sheet_metrics.append({"index": i, "display_index": i + 1, "name": sheet.get("name"), "rows": sheet.get("rows"), "cols": sheet.get("cols"), "required_marker_count": len(sheet.get("required_col_indices", [])), "image_count": len(sheet.get("images", [])), "image_column_count": sheet.get("image_column_count", 0), "image_columns": image_cols, "max_images_per_data_row": sheet.get("max_images_per_data_row", 0), "blank_original_rows_in_data_area": sheet.get("blank_original_rows_in_data_area", []), "has_summary_context": bool(sheet.get("summary_context")), "headers": headers})
    return {"schema_name": schema.get("schema_name"), "mode": mode, "file": parsed.get("file"), "file_path": parsed.get("file_path"), "checked_at": datetime.now().isoformat(timespec="seconds"), "conformant": conformant, "verdict": "符合标准" if conformant else "不符合标准", "blocking_count": blocking_count, "warning_count": warning_count, "summary_sheet_index": summary_idx, "sheet_names": sheet_names, "sheet_metrics": sheet_metrics, "issues": issues}


def escape_pipe(value: Any) -> str:
    return str(value).replace("|", "\\|")


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
    lines.append("|序号|工作表名称|数据行数|字段数|必填字段数|图片数量|图片所在字段数|图片字段|是否能对应汇总页|\n")
    lines.append("|---:|---|---:|---:|---:|---:|---:|---|---|\n")
    for s in result.get("sheet_metrics", []):
        relation = "是" if s["has_summary_context"] else "否"
        if s["index"] == result.get("summary_sheet_index"):
            relation = "汇总页"
        image_cols = "、".join(s.get("image_columns", [])) or "-"
        lines.append(f"|{s.get('display_index', s['index'] + 1)}|{escape_pipe(s['name'])}|{s['rows']}|{s['cols']}|{s['required_marker_count']}|{s['image_count']}|{s['image_column_count']}|{escape_pipe(image_cols)}|{relation}|\n")
    lines.append("\n## 需要关注的问题\n\n")
    if result.get("issues"):
        lines.append("|处理优先级|问题说明|\n|---|---|\n")
        for issue in result["issues"]:
            severity = "必须修正" if issue["severity"] == "blocking" else "建议确认"
            lines.append(f"|{severity}|{escape_pipe(issue['message'])}|\n")
    else:
        lines.append("未发现必须修正或建议确认的问题。\n")
    lines.append("\n## 新增检查说明\n\n")
    lines.append("第一个 sheet 默认作为汇总表，且第一列默认作为板块列；系统会检查这些板块值是否能与后续分表名称一一匹配。字段名不必一定叫“板块”。\n\n")
    lines.append("图片不是 sheet 级必要条件：每个工作表可以有图片，也可以没有图片；系统会识别并统计已插入图片，不会因为某个 sheet 无图而判定不合格。若表头同时属于图片类字段并明确标注为“必填”，例如“见刊截图（必填）”，则该列仍会逐行检查是否存在真实嵌入图片，文本占位不能替代图片。\n\n")
    lines.append("系统还会检查数据区域的文本字段完整性：除备注、说明、补充、其他、可选等可空列、图片/截图/凭证类字段的文本占位，以及合法合计行、汇总公式尾行、说明行外，数据区每个文本字段都应逐行有值；其中显式必填的图片类字段按真实图片另行检查。\n")
    lines.append("\n## 下一步建议\n\n")
    if result.get("conformant"):
        lines.append("这个文件符合结算原始输入文件标准，可以继续用于生成 PPT。正式制作前，建议再让用户确认工作表内容、图片数量和需要展示的字段是否完整。\n")
    else:
        lines.append("这个文件暂不建议直接用于生成 PPT。请先按标准模板补齐“汇总”工作表、对应的明细工作表、必填字段、图片命名字段，并确认每个数据行在文本列和图片列中都没有缺漏。\n")
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
    if input_path.suffix.lower() not in {".xlsx", ".xlsm"}:
        print(json.dumps({"conformant": False, "verdict": "不符合标准", "issues": [{"severity": "blocking", "code": "unsupported_file_type", "message": "当前检查脚本仅支持 .xlsx 或 .xlsm 文件。"}]}, ensure_ascii=False, indent=2))
        return 2 if args.fail_on_invalid else 0
    schema = json.loads(Path(args.schema).read_text(encoding="utf-8"))
    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else Path(tempfile.mkdtemp(prefix="settlement_excel_validation_"))
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        parsed, parser_warnings = parse_workbook(input_path, schema)
        result = validate(parsed, schema, args.mode, parser_warnings)
    except Exception as exc:
        result = {"schema_name": schema.get("schema_name"), "mode": args.mode, "file": input_path.name, "file_path": str(input_path), "checked_at": datetime.now().isoformat(timespec="seconds"), "conformant": False, "verdict": "不符合标准", "blocking_count": 1, "warning_count": 0, "summary_sheet_index": -1, "sheet_names": [], "sheet_metrics": [], "issues": [{"severity": "blocking", "code": "parse_failed", "message": f"无法打开或读取这个 Excel 文件：{exc}"}]}
    result_path = out_dir / "validation_result.json"
    report_path = out_dir / "validation_report.md"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown_report(result, report_path)
    print(json.dumps({"file": result.get("file"), "verdict": result.get("verdict"), "conformant": result.get("conformant"), "blocking_count": result.get("blocking_count"), "warning_count": result.get("warning_count"), "result_json": str(result_path), "report_md": str(report_path)}, ensure_ascii=False, indent=2))
    if args.fail_on_invalid and not result.get("conformant"):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
