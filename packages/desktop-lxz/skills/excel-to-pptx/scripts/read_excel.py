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
    return str(value)


def clean_header(value):
    text = clean_text(value)
    if text is None:
        return None
    return str(text).strip()


def is_date_format(number_format):
    """Check if number_format indicates a date type."""
    if not number_format or number_format == 'General':
        return False
    date_chars = {'y', 'm', 'd', 'h', 's'}
    fmt_lower = number_format.lower()
    return any(c in fmt_lower for c in date_chars)


def is_time_format(number_format):
    """Check if number_format indicates a time type."""
    if not number_format or number_format == 'General':
        return False
    fmt_lower = number_format.lower()
    return 'h' in fmt_lower or 's' in fmt_lower


def round_to_decimal_places(value, decimal_places):
    """Round a float to specified decimal places."""
    if decimal_places == 0:
        return round(value)
    multiplier = 10 ** decimal_places
    return round(value * multiplier) / multiplier


def format_numeric(value, number_format):
    """Format numeric value according to Excel number_format."""
    if not isinstance(value, (int, float)):
        return None

    fmt = (number_format or 'General').strip()

    # Handle General format - just return the number as string
    if fmt == 'General':
        return str(value)

    # Determine decimal places from format
    decimal_places = 0
    has_decimal = '.' in fmt
    if has_decimal:
        # Count digits after decimal point in format string (before any trailing zeros removed)
        parts = fmt.split('.')
        if len(parts) > 1:
            # Get the decimal part, stop at first non-digit character (like space, _, etc.)
            decimal_part = ''
            for ch in parts[1]:
                if ch.isdigit():
                    decimal_part += ch
                else:
                    break
            decimal_places = len(decimal_part) if decimal_part else 0

    # Format with proper decimal places
    formatted = round_to_decimal_places(value, decimal_places)

    # Add thousand separator if format has it
    if '#,##0' in fmt or (',' in fmt and decimal_places > 0):
        return f"{formatted:,}"
    return str(formatted)


def format_date(value, number_format):
    """Format Excel date serial number or datetime object to date string."""
    import datetime as dt_module

    if isinstance(value, dt_module.datetime):
        dt = value
    elif isinstance(value, dt_module.date):
        dt = dt_module.datetime.combine(value, dt_module.time())
    elif isinstance(value, (int, float)):
        from openpyxl.utils.datetime import from_excel
        try:
            dt = from_excel(value)
        except Exception:
            return str(value)
    else:
        return None

    fmt = (number_format or 'yyyy/m/d').strip()
    if fmt.lower() == 'general':
        return dt.strftime('%m月%d日')
    # Remove Excel section separator and everything after it (e.g., ";@" or ";@")
    if ';' in fmt:
        fmt = fmt.split(';')[0]

    # Handle Chinese date format: m"月"d"日" or mm"月"dd"日"
    # Also handle yyyy"年"m"月"d"日" etc.
    chinese_date_pattern = re.compile(r'(yyyy|yy|m+|d+|h+|s+)(["""\'\']([^"""\']+)["""\'\'])?', re.IGNORECASE)

    def replace_token(match):
        token = match.group(1).lower()
        literal = match.group(3) or ''

        # Map Excel format tokens to Python strftime
        token_map = {
            'yyyy': '%Y',   # 4-digit year
            'yy': '%y',     # 2-digit year
            'mmmm': '%B',   # Full month name (locale)
            'mmm': '%b',    # Abbreviated month (locale)
            'mm': '%m',     # Zero-padded month
            'm': '%m',      # Month without zero-padding
            'dd': '%d',     # Zero-padded day
            'd': '%d',      # Day without zero-padding
            'hh': '%H',     # 24-hour
            'h': '%H',      # 24-hour without zero-padding
            'ss': '%S',     # Second
            's': '%S',      # Second without zero-padding
        }

        if token in token_map:
            fmt_token = token_map[token]
            try:
                formatted = dt.strftime(fmt_token)
                # Remove leading zero for non-zero-padded formats
                if token == 'm' and literal != '月':
                    formatted = str(int(formatted))
                elif token == 'd' and literal != '日':
                    formatted = str(int(formatted))
                return formatted + literal
            except Exception:
                return match.group(0)
        return match.group(0)

    # Replace tokens while preserving literals
    result = chinese_date_pattern.sub(replace_token, fmt)

    # Handle any remaining tokens that weren't in the pattern
    # e.g., simple formats like "yyyy/m/d"
    simple_tokens = {
        'yyyy': '%Y', 'yy': '%y',
        'mm': '%m', 'm': '%m',
        'dd': '%d', 'd': '%d',
    }
    for token, strftime_token in simple_tokens.items():
        if token in result.lower():
            try:
                result = dt.strftime(result)
                break
            except Exception:
                pass

    try:
        return dt.strftime(result)
    except Exception:
        return str(value)


def format_cell_value(value, number_format):
    """Format cell value according to its number_format."""
    if value is None:
        return None

    import datetime as dt_module

    # If it's a string, use original clean_text behavior
    if isinstance(value, str):
        return clean_text(value)

    # Handle datetime objects (already converted by openpyxl)
    if isinstance(value, (dt_module.datetime, dt_module.date)):
        formatted = format_date(value, number_format)
        if formatted:
            return formatted
        return clean_text(value)

    # If it's a number (int or float)
    if isinstance(value, (int, float)):
        # Skip boolean
        if isinstance(value, bool):
            return clean_text(value)

        # Check for date format
        if is_date_format(number_format):
            formatted = format_date(value, number_format)
            if formatted:
                return formatted

        # Otherwise format as numeric
        formatted = format_numeric(value, number_format)
        if formatted:
            return formatted

    return clean_text(value)


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
            cell = ws.cell(r, c)
            # For merged cells, use top-left value from merged_map
            value = merged_map.get((r, c), cell.value)
            # Get number_format for formatting
            number_format = cell.number_format
            row_values.append(format_cell_value(value, number_format))
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
    """Build image caption as {发布平台列的内容}-{媒体名称列的内容}-{图片所在列的名字}.

    Uses exact column name matching to find 发布平台 and 媒体名称 values,
    then uses the actual cell values from those columns for the current row.
    The column_name (voucher type) is used as-is without inference.
    """
    platform_col_idx = None
    media_col_idx = None

    for idx, header in enumerate(headers or []):
        if idx >= len(row_values):
            break
        h = normalize_match_text(header)
        if not h:
            continue
        if platform_col_idx is None and "发布平台" in h:
            if row_values[idx] is not None and str(row_values[idx]).strip() != "":
                platform_col_idx = idx
        if media_col_idx is None:
            media_keywords = ["媒体名称", "媒体名", "达人", "账号名称", "账号", "名称", "kol", "koc"]
            if any(normalize_match_text(k) in h for k in media_keywords):
                if row_values[idx] is not None and str(row_values[idx]).strip() != "":
                    media_col_idx = idx

    platform = row_values[platform_col_idx] if platform_col_idx is not None and platform_col_idx < len(row_values) else None
    media = row_values[media_col_idx] if media_col_idx is not None and media_col_idx < len(row_values) else None

    return "-".join([
        caption_safe(platform, "未知平台"),
        caption_safe(media, f"第{data_row_idx + 1}行"),
        caption_safe(column_name, "图片凭证"),
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
