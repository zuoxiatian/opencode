"""
Excel 解析模块 — excel-to-pptx skill

设计原则：
  1. 表格忠实优先：表格列只来自单元格内容，图片所在的空列不得混入表格。
  2. 预处理优先：先展开合并单元格，再删除纯空行、纯空列。
  3. 图片单独处理：图片锚点保留为元数据，并按锚定行关联到最近的数据行。
  4. 汇总行上浮：汇总表数据行作为 detail sheet 的 summary_context 进入后续布局。

Usage:
  python read_excel.py <input.xlsx> [--sheet <name>] [--output <path>]

Output: JSON to stdout (or --output file)
"""

import argparse
import json
import sys
import os
import tempfile
import re
from pathlib import Path

import openpyxl
from openpyxl.utils import get_column_letter
from PIL import Image

openpyxl.styles.fills.Fill.__init__ = lambda self, *args, **kwargs: None


def is_blank(value):
    """Return True for None or whitespace-only cell values."""
    if value is None:
        return True
    if isinstance(value, str) and value.strip() == "":
        return True
    return False


LINK_RE = re.compile(r"(https?://[^\s,，;；|｜、]+|www\.[^\s,，;；|｜、]+)", re.IGNORECASE)


def keep_first_link_when_multiple(text):
    """If a cell contains multiple explicit links, keep only the first link."""
    if not isinstance(text, str):
        return text
    matches = LINK_RE.findall(text)
    if len(matches) >= 2:
        return matches[0]
    return text


def clean_text(value):
    """Normalize cell text without changing business meaning."""
    if value is None:
        return None
    if isinstance(value, str):
        text = keep_first_link_when_multiple(value.strip())
        text = text.replace("\r", "")
        text = text.replace("\n\n", "<<NEWLINE>>")
        text = text.replace("\n", "")
        text = text.replace("<<NEWLINE>>", "\n")
        return text if text else None
    return value


def clean_header(value):
    text = clean_text(value)
    if text is None:
        return None
    return str(text).strip()


def expand_merged_cells(ws):
    """Return a mapping so every coordinate in a merged range receives the top-left value."""
    merged_map = {}
    for merged_range in ws.merged_cells.ranges:
        top_left_value = ws.cell(merged_range.min_row, merged_range.min_col).value
        for row in range(merged_range.min_row, merged_range.max_row + 1):
            for col in range(merged_range.min_col, merged_range.max_col + 1):
                merged_map[(row, col)] = top_left_value
    return merged_map


def extract_images(ws, output_dir):
    """Extract embedded images and preserve their original anchor positions."""
    images = []
    if not hasattr(ws, "_images") or not ws._images:
        return images

    safe_sheet_name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in ws.title)
    for i, img in enumerate(ws._images):
        anchor = img.anchor
        row_idx = None
        col_idx = None
        if hasattr(anchor, "_from"):
            if hasattr(anchor._from, "row"):
                row_idx = anchor._from.row + 1
            if hasattr(anchor._from, "col"):
                col_idx = anchor._from.col + 1

        img_path = os.path.join(output_dir, f"{safe_sheet_name}_img_{i + 1}.png")
        item = {
            "index": i,
            "file": img_path,
            "anchor_row_original": row_idx,
            "anchor_col_original": get_column_letter(col_idx) if col_idx else None,
            "anchor_col_index_original": col_idx,
            "anchor_row": row_idx,
            "anchor_col": get_column_letter(col_idx) if col_idx else None,
            "anchor_col_index": col_idx,
        }
        try:
            with open(img_path, "wb") as f:
                f.write(img._data())
            with Image.open(img_path) as pil_img:
                item.update({
                    "width_px": pil_img.size[0],
                    "height_px": pil_img.size[1],
                    "format": pil_img.format or "png",
                })
        except Exception as exc:
            item["file"] = None
            item["error"] = str(exc)
        images.append(item)
    return images


def build_value_matrix(ws, merged_map):
    """Build a compacted matrix using cell values only, not image anchors.

    This is the most important fidelity rule. Image-only columns/rows are deliberately excluded
    from the table matrix so that PPTX does not render fake blank table columns.
    """
    raw = []
    row_has_value = set()
    col_has_value = set()

    for r in range(1, ws.max_row + 1):
        row_values = []
        for c in range(1, ws.max_column + 1):
            value = merged_map.get((r, c), ws.cell(r, c).value)
            row_values.append(clean_text(value))
            if not is_blank(value):
                row_has_value.add(r)
                col_has_value.add(c)
        raw.append(row_values)

    keep_rows = [r for r in range(1, ws.max_row + 1) if r in row_has_value]
    keep_cols = [c for c in range(1, ws.max_column + 1) if c in col_has_value]

    old_to_new_row = {old: new for new, old in enumerate(keep_rows, start=1)}
    old_to_new_col = {old: new for new, old in enumerate(keep_cols, start=1)}
    new_to_old_row = {new: old for old, new in old_to_new_row.items()}
    new_to_old_col = {new: old for old, new in old_to_new_col.items()}

    matrix = []
    for old_r in keep_rows:
        matrix.append([raw[old_r - 1][old_c - 1] for old_c in keep_cols])

    return {
        "matrix": matrix,
        "keep_rows_original": keep_rows,
        "keep_cols_original": keep_cols,
        "old_to_new_row": old_to_new_row,
        "old_to_new_col": old_to_new_col,
        "new_to_old_row": new_to_old_row,
        "new_to_old_col": new_to_old_col,
        "removed_blank_rows": [r for r in range(1, ws.max_row + 1) if r not in old_to_new_row],
        "removed_blank_cols": [get_column_letter(c) for c in range(1, ws.max_column + 1) if c not in old_to_new_col],
    }


def detect_header_row(matrix):
    """Find the most likely header row after blank row/column compaction."""
    if not matrix:
        return 1

    search_rows = matrix[: min(12, len(matrix))]
    # Prefer the first row with at least two non-empty cells. This avoids using a title row.
    for idx, row in enumerate(search_rows, start=1):
        if sum(1 for v in row if not is_blank(v)) >= 2:
            return idx

    # Fallback: first non-empty row.
    for idx, row in enumerate(search_rows, start=1):
        if any(not is_blank(v) for v in row):
            return idx
    return 1


def detect_header_span(ws, header_row, compact_info):
    """Conservatively detect multi-row headers only when a merged range proves it."""
    matrix = compact_info["matrix"]
    if not matrix or header_row >= len(matrix):
        return header_row

    header_old = compact_info["new_to_old_row"].get(header_row)
    next_old = compact_info["new_to_old_row"].get(header_row + 1)
    if not header_old or not next_old:
        return header_row

    for merged_range in ws.merged_cells.ranges:
        spans_header_and_next = (
            merged_range.min_row <= header_old <= merged_range.max_row
            and merged_range.min_row <= next_old <= merged_range.max_row
        )
        if spans_header_and_next:
            return header_row + 1
    return header_row


def build_headers(matrix, header_row, header_end):
    if not matrix:
        return []
    width = len(matrix[0])
    headers = []
    for col_idx in range(width):
        parts = []
        for r_idx in range(header_row, min(header_end, len(matrix)) + 1):
            h = clean_header(matrix[r_idx - 1][col_idx])
            if h and h not in parts:
                parts.append(h)
        headers.append("-".join(parts) if parts else f"列{col_idx + 1}")
    return headers


def nearest_data_row(anchor_row_original, data_original_rows):
    """Map an image anchor to the closest data row. Prefer exact/preceding rows."""
    if not anchor_row_original or not data_original_rows:
        return None
    if anchor_row_original in data_original_rows:
        return data_original_rows.index(anchor_row_original)

    preceding = [r for r in data_original_rows if r <= anchor_row_original]
    if preceding:
        return data_original_rows.index(preceding[-1])

    following = [r for r in data_original_rows if r > anchor_row_original]
    if following:
        return data_original_rows.index(following[0])
    return None


def infer_image_column_name(img, headers, compact_info):
    """Derive a human-readable image caption source without expanding image-only columns."""
    old_col = img.get("anchor_col_index_original")
    if old_col in compact_info["old_to_new_col"]:
        zero = compact_info["old_to_new_col"][old_col] - 1
        if 0 <= zero < len(headers):
            return headers[zero], zero
    if old_col:
        return f"图片列{get_column_letter(old_col)}", None
    return "图片", None


def caption_safe(value, fallback):
    text = clean_text(value)
    if text is None or str(text).strip() == "":
        text = fallback
    text = str(text).strip()
    text = re.sub(r"[\r\n\t]+", "", text)
    text = re.sub(r'[\\\\/:*?"<>|]+', "-", text)
    text = re.sub(r"\s+", "", text)
    return text[:36] if len(text) > 36 else text


def find_row_value_by_headers(headers, row_values, keywords):
    """Find the first non-empty row value whose header contains any keyword."""
    for idx, header in enumerate(headers or []):
        h = normalize_match_text(header)
        if not h:
            continue
        if any(normalize_match_text(k) in h for k in keywords):
            if idx < len(row_values) and row_values[idx] is not None and str(row_values[idx]).strip() != "":
                return row_values[idx]
    return None


def infer_voucher_label(column_name):
    text = normalize_match_text(column_name)
    if "发票" in text:
        return "发票凭证"
    if "付款" in text or "支付" in text or "打款" in text or "转账" in text:
        return "付款凭证"
    if "数据截图" in text or ("数据" in text and "截图" in text):
        return "数据截图"
    if "截图" in text:
        return "数据截图"
    if "合同" in text:
        return "合同凭证"
    if "凭证" in text:
        return column_name
    return column_name or "图片凭证"


def build_image_caption(headers, row_values, column_name, data_row_idx):
    """Build image caption as {发布平台}-{媒体名称}-{数据截图/发票凭证/付款凭证/等}."""
    platform = find_row_value_by_headers(headers, row_values, ["发布平台", "平台"])
    media = find_row_value_by_headers(headers, row_values, ["媒体名称", "媒体名", "达人", "账号名称", "账号", "名称", "kol", "koc"])
    voucher = infer_voucher_label(column_name)
    return "-".join([
        caption_safe(platform, "未知平台"),
        caption_safe(media, f"第{data_row_idx + 1}行"),
        caption_safe(voucher, "图片凭证"),
    ])


def parse_sheet(ws, output_dir):
    """Parse a worksheet into faithful table data plus independent image metadata."""
    merged_map = expand_merged_cells(ws)
    images = extract_images(ws, output_dir)
    compact_info = build_value_matrix(ws, merged_map)
    matrix = compact_info["matrix"]

    if not matrix:
        return {
            "name": ws.title,
            "rows": 0,
            "cols": 0,
            "headers": [],
            "required_col_indices": [],
            "data": [],
            "images": images,
            "image_row_map": {},
            "image_col_map": {},
            "image_column_count": 0,
            "max_images_per_data_row": 0,
            "merged_ranges": [str(m) for m in ws.merged_cells.ranges],
            "normalization": {
                "removed_blank_rows": compact_info["removed_blank_rows"],
                "removed_blank_cols": compact_info["removed_blank_cols"],
                "table_matrix_excludes_image_only_rows_cols": True,
                "merged_cells_expanded": len(ws.merged_cells.ranges),
            },
        }

    header_row = detect_header_row(matrix)
    header_end = detect_header_span(ws, header_row, compact_info)
    headers = build_headers(matrix, header_row, header_end)
    width = len(headers)

    required_cols = [i for i, h in enumerate(headers) if h and "必填" in h]

    data_start = header_end + 1
    rows = []
    data_original_rows = []
    compact_row_to_data_index = {}
    for compact_r in range(data_start, len(matrix) + 1):
        row_values = matrix[compact_r - 1][:width]
        if len(row_values) < width:
            row_values.extend([None] * (width - len(row_values)))
        if any(not is_blank(v) for v in row_values):
            compact_row_to_data_index[compact_r] = len(rows)
            rows.append(row_values)
            data_original_rows.append(compact_info["new_to_old_row"].get(compact_r))

    image_row_map = {}
    image_col_map = {}
    row_image_counts = {}
    image_cols_original = set()

    for img in images:
        if not img.get("file"):
            continue
        data_row_idx = nearest_data_row(img.get("anchor_row_original"), data_original_rows)
        if data_row_idx is None:
            continue

        col_name, data_col_index = infer_image_column_name(img, headers, compact_info)
        row_values_for_caption = rows[data_row_idx] if 0 <= data_row_idx < len(rows) else []
        img["data_row_index"] = data_row_idx
        img["data_row_number"] = data_row_idx + 1
        img["data_col_index"] = data_col_index
        img["column_name"] = col_name
        img["caption"] = build_image_caption(headers, row_values_for_caption, col_name, data_row_idx)
        img["caption_rule"] = "发布平台-媒体名称-凭证类型"
        img["belongs_to_table_column"] = data_col_index is not None
        img["anchor_row"] = compact_info["old_to_new_row"].get(img.get("anchor_row_original"))
        img["anchor_col_index"] = compact_info["old_to_new_col"].get(img.get("anchor_col_index_original"))
        img["anchor_col"] = get_column_letter(img["anchor_col_index"]) if img.get("anchor_col_index") else None

        rkey = str(data_row_idx)
        image_row_map.setdefault(rkey, []).append(img)
        row_image_counts[data_row_idx] = row_image_counts.get(data_row_idx, 0) + 1
        old_col = img.get("anchor_col_index_original")
        if old_col:
            image_cols_original.add(old_col)
            image_col_map.setdefault(str(old_col), []).append(img)

    return {
        "name": ws.title,
        "rows": len(rows),
        "cols": len(headers),
        "headers": headers,
        "required_col_indices": required_cols,
        "data": rows,
        "images": images,
        "image_row_map": image_row_map,
        "image_col_map": image_col_map,
        "image_column_count": len(image_cols_original),
        "max_images_per_data_row": max(row_image_counts.values()) if row_image_counts else 0,
        "merged_ranges": [str(m) for m in ws.merged_cells.ranges],
        "normalization": {
            "removed_blank_rows": compact_info["removed_blank_rows"],
            "removed_blank_cols": compact_info["removed_blank_cols"],
            "kept_rows_original": compact_info["keep_rows_original"],
            "kept_cols_original": [get_column_letter(c) for c in compact_info["keep_cols_original"]],
            "table_matrix_excludes_image_only_rows_cols": True,
            "merged_cells_expanded": len(ws.merged_cells.ranges),
        },
        "header_row": header_row,
        "header_end_row": header_end,
        "data_start_row": data_start,
        "data_original_rows": data_original_rows,
    }


def detect_summary_sheet(sheets):
    """Prefer a sheet named 汇总; otherwise do not guess too aggressively."""
    for i, sheet in enumerate(sheets):
        if "汇总" in sheet.get("name", "") or "summary" in sheet.get("name", "").lower():
            return i
    return -1


def row_to_dict(headers, row):
    result = {}
    for i, value in enumerate(row):
        key = headers[i] if i < len(headers) and headers[i] else f"列{i + 1}"
        result[key] = value
    return result


def normalize_match_text(value):
    """Normalize headers / business keys for deterministic matching only."""
    if value is None:
        return ""
    text = str(value).strip().lower()
    for token in ["（必填）", "(必填)", "必填"]:
        text = text.replace(token, "")
    text = re.sub(r"\s+", "", text)
    return text


def extract_leading_number(value):
    match = re.match(r"^\s*(\d+)", str(value or ""))
    return match.group(1) if match else None


def header_contains(header, keywords):
    h = normalize_match_text(header)
    return any(normalize_match_text(k) in h for k in keywords)


def find_header_indices(headers, keywords):
    return [i for i, h in enumerate(headers or []) if header_contains(h, keywords)]


def nonblank_row_value(row, indices):
    for idx in indices:
        if idx < len(row) and row[idx] is not None and str(row[idx]).strip() != "":
            return row[idx]
    return None


def make_summary_context(summary, summary_headers, summary_row, summary_row_index, detail_idx, detail_name, display_mode):
    summary_values = row_to_dict(summary_headers, summary_row)
    return {
        "summary_sheet_name": summary.get("name"),
        "summary_row_index": summary_row_index,
        "summary_row_number": summary_row_index + 1,
        "detail_sheet_index": detail_idx,
        "detail_sheet_name": detail_name,
        "display_mode": display_mode,
        "values": summary_values,
        "headers": summary_headers,
        "row": summary_row,
    }


def detail_sheet_summary_rows(summary_headers, summary_rows, detail_name, detail_order):
    """Return summary row indexes that belong to a detail sheet.

    Prefer explicit block/module columns and leading numeric prefixes such as
    `4-媒体合作-平台下单` ↔ `4-媒体合作-平台单链接`. This handles expanded merged
    cells where many summary rows belong to one detail sheet.
    """
    if not summary_rows:
        return []
    if len(summary_rows) == 1:
        return [0]

    detail_num = extract_leading_number(detail_name)
    group_cols = find_header_indices(summary_headers, ["板块", "版块", "模块", "项目", "分类", "描述方向", "合作类型"])
    if not group_cols:
        group_cols = list(range(min(3, len(summary_headers))))

    matched = []
    if detail_num:
        prefix = f"{detail_num}-"
        for ridx, row in enumerate(summary_rows):
            values = [str(row[i]).strip() for i in group_cols if i < len(row) and row[i] is not None]
            if any(v.startswith(prefix) for v in values):
                matched.append(ridx)
        if matched:
            return matched

    detail_norm = normalize_match_text(re.sub(r"^\s*\d+[-_、.．]?", "", str(detail_name or "")))
    token_parts = [p for p in re.split(r"[-_、/\s]+", detail_norm) if p]
    for ridx, row in enumerate(summary_rows):
        values = [normalize_match_text(row[i]) for i in group_cols if i < len(row) and row[i] is not None]
        if any(detail_norm and detail_norm in v for v in values):
            matched.append(ridx)
        elif token_parts and any(any(p and p in v for p in token_parts) for v in values):
            matched.append(ridx)
    if matched:
        return matched

    # Backward-compatible fallback: one summary row per detail sheet by order.
    fallback_idx = detail_order if detail_order < len(summary_rows) else len(summary_rows) - 1
    return [fallback_idx]


def build_summary_row_map(detail, summary_contexts):
    """Map detail data row indexes to matched summary row contexts.

    The main use case is settlement files where detail rows have `达人` while
    summary rows have `媒体名称（必填）`. Header aliases are intentionally broad,
    but values must match exactly after whitespace / required-marker cleanup.
    """
    if not summary_contexts:
        return {}, {}

    detail_headers = detail.get("headers", [])
    detail_rows = detail.get("data", [])
    summary_headers = summary_contexts[0].get("headers", [])

    detail_key_cols = find_header_indices(detail_headers, ["达人", "媒体名称", "媒体名", "账号名称", "账号", "名称", "kol", "koc"])
    summary_key_cols = find_header_indices(summary_headers, ["媒体名称", "媒体名", "达人", "账号名称", "账号", "名称", "kol", "koc"])
    if not detail_key_cols or not summary_key_cols:
        return {}, {"detail_key_columns": detail_key_cols, "summary_key_columns": summary_key_cols}

    summary_by_key = {}
    for ctx in summary_contexts:
        row = ctx.get("row", [])
        for ci in summary_key_cols:
            if ci < len(row):
                key = normalize_match_text(row[ci])
                if key:
                    summary_by_key.setdefault(key, []).append(ctx)

    row_map = {}
    for ridx, row in enumerate(detail_rows):
        for ci in detail_key_cols:
            if ci >= len(row):
                continue
            key = normalize_match_text(row[ci])
            if key and key in summary_by_key:
                row_map[str(ridx)] = summary_by_key[key]
                break

    return row_map, {
        "detail_key_columns": detail_key_cols,
        "summary_key_columns": summary_key_cols,
        "matched_detail_rows": len(row_map),
    }


def attach_summary_associations(sheets, summary_idx):
    """Attach expanded summary rows to detail sheets for page rendering.

    Rules:
      - One summary data row: attach the same row to all detail sheets, display on the first page only.
      - Multiple summary rows with block/module prefixes: attach all rows in the matching block to the detail sheet.
      - If multiple attached summary rows can be matched to detail row values (e.g. detail `达人` ↔ summary `媒体名称`),
        downstream layout should render only the summary rows corresponding to the current page's detail rows.
      - Fallback remains one summary row per detail sheet by order.
    """
    if summary_idx is None or summary_idx < 0 or summary_idx >= len(sheets):
        return

    summary = sheets[summary_idx]
    summary_rows = summary.get("data", [])
    summary_headers = summary.get("headers", [])
    detail_indices = [i for i in range(len(sheets)) if i != summary_idx]
    associations = []

    for detail_order, detail_idx in enumerate(detail_indices):
        if not summary_rows:
            break
        detail = sheets[detail_idx]
        detail_name = detail.get("name")
        row_indices = detail_sheet_summary_rows(summary_headers, summary_rows, detail_name, detail_order)
        if not row_indices:
            continue

        display_mode = "first_page_only" if len(summary_rows) == 1 else "every_page"
        if len(row_indices) > 1:
            display_mode = "match_detail_rows"

        contexts = [
            make_summary_context(summary, summary_headers, summary_rows[ridx], ridx, detail_idx, detail_name, display_mode)
            for ridx in row_indices
        ]

        if len(contexts) == 1:
            detail["summary_context"] = contexts[0]
            detail["summary_association"] = contexts[0]
        else:
            row_map, match_meta = build_summary_row_map(detail, contexts)
            group_context = {
                "summary_sheet_name": summary.get("name"),
                "detail_sheet_index": detail_idx,
                "detail_sheet_name": detail_name,
                "display_mode": "match_detail_rows" if row_map else "every_page",
                "headers": summary_headers,
                "rows": [ctx.get("row", []) for ctx in contexts],
                "values_list": [ctx.get("values", {}) for ctx in contexts],
                "summary_row_indices": [ctx.get("summary_row_index") for ctx in contexts],
                "summary_row_numbers": [ctx.get("summary_row_number") for ctx in contexts],
                "match_meta": match_meta,
            }
            detail["summary_context"] = group_context
            detail["summary_association"] = group_context
            detail["summary_context_rows"] = contexts
            if row_map:
                detail["summary_row_map"] = row_map

        associations.extend(contexts)

    summary["detail_sheet_associations"] = associations


def parse_excel(filepath, sheet_name=None):
    wb = openpyxl.load_workbook(filepath, data_only=True)
    img_dir = tempfile.mkdtemp(prefix="excel_to_pptx_")

    target_sheets = [sheet_name] if sheet_name else wb.sheetnames
    sheets = []
    for sn in target_sheets:
        if sn not in wb.sheetnames:
            continue
        sheets.append(parse_sheet(wb[sn], img_dir))

    summary_idx = detect_summary_sheet(sheets) if not sheet_name else -1
    attach_summary_associations(sheets, summary_idx)

    return {
        "file": os.path.basename(filepath),
        "file_path": filepath,
        "all_sheet_names": wb.sheetnames,
        "image_dir": img_dir,
        "summary_sheet_index": summary_idx,
        "sheets": sheets,
    }


def main():
    parser = argparse.ArgumentParser(description="Parse Excel for pptx conversion")
    parser.add_argument("input", help="Path to Excel file (.xlsx)")
    parser.add_argument("--sheet", help="Parse only this sheet name")
    parser.add_argument("--output", "-o", help="Output JSON file path (default: stdout)")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    result = parse_excel(args.input, args.sheet)
    json_str = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(json_str)
        print(f"Output written to {args.output}", file=sys.stderr)
    else:
        print(json_str)


if __name__ == "__main__":
    main()
