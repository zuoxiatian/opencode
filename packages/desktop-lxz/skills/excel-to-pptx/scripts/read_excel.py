"""
Excel 瑙ｆ瀽妯″潡 鈥?excel-to-pptx skill

璁捐鍘熷垯锛?
  1. 琛ㄦ牸蹇犲疄浼樺厛锛氳〃鏍煎垪鍙潵鑷崟鍏冩牸鍐呭锛屽浘鐗囨墍鍦ㄧ殑绌哄垪涓嶅緱娣峰叆琛ㄦ牸銆?
  2. 棰勫鐞嗕紭鍏堬細鍏堝睍寮€鍚堝苟鍗曞厓鏍硷紝鍐嶅垹闄ょ函绌鸿銆佺函绌哄垪銆?
  3. 鍥剧墖鍗曠嫭澶勭悊锛氬浘鐗囬敋鐐逛繚鐣欎负鍏冩暟鎹紝骞舵寜閿氬畾琛屽叧鑱斿埌鏈€杩戠殑鏁版嵁琛屻€?
  4. 姹囨€昏涓婃诞锛氭眹鎬昏〃鏁版嵁琛屼綔涓?detail sheet 鐨?summary_context 杩涘叆鍚庣画甯冨眬銆?

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


LINK_RE = re.compile(r"(https?://[^\s,;，；|｜、]+|www\.[^\s,;，；|｜、]+)", re.IGNORECASE)


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


def is_non_required_header(header):
    if header is None:
        return False
    text = str(header)
    normalized = text.replace(" ", "").lower()
    markers = ["非必填", "(非必填)", "（非必填）", "ppt非必填", "非必填列"]
    return any(marker in normalized for marker in markers)


def _strip_quoted_literals(fmt):
    """Remove quoted/escaped literal text before inspecting Excel format tokens."""
    result = []
    i = 0
    in_quote = None
    while i < len(fmt):
        ch = fmt[i]
        if ch in ('"', "'"):
            if in_quote == ch:
                in_quote = None
            elif in_quote is None:
                in_quote = ch
            i += 1
            continue
        if in_quote:
            i += 1
            continue
        if ch == '\\' and i + 1 < len(fmt):
            i += 2
            continue
        result.append(ch)
        i += 1
    return ''.join(result)


def is_date_format(number_format):
    """Check if number_format indicates a date/time type without false positives.

    Excel number formats may contain strings such as [Red] or currency literals.
    A naive substring test for d/m/y misclassifies those as dates. Strip quoted
    literals, locale/color/condition brackets and numeric placeholders first.
    """
    if not number_format or str(number_format).lower() == 'general':
        return False
    fmt = str(number_format).split(';')[0]
    fmt = re.sub(r'\[\$-[^\]]+\]', '', fmt)
    fmt = re.sub(r'\[[^\]]+\]', '', fmt)
    fmt = _strip_quoted_literals(fmt).lower()
    if any(token in fmt for token in ('yy', 'yyyy', '年', '月', '日')):
        return True
    # Recognize simple formats such as m/d, d-m, h:mm while ignoring #,##0.
    token_text = re.sub(r'[#0?,._()\s%￥$€£¥-]+', '', fmt)
    return bool(re.search(r'[ymdhHsS]', token_text)) and not any(ch in fmt for ch in '#0')


def is_time_format(number_format):
    """Check if number_format indicates a time type."""
    if not number_format or str(number_format).lower() == 'general':
        return False
    fmt = str(number_format).split(';')[0]
    fmt = re.sub(r'\[[^\]]+\]', '', fmt)
    fmt = _strip_quoted_literals(fmt).lower()
    return ':' in fmt and ('h' in fmt or 's' in fmt)


def excel_general_number(value):
    """Return an Excel-like General display string for ordinary numbers.

    Excel stores numbers as binary floating point and displays up to about 15
    significant digits. Using Python's default str(float) can expose binary
    artifacts such as 107921.52000000002, so collapse floats to 15 significant
    digits before exporting JSON.
    """
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, int):
        return str(value)
    try:
        if float(value).is_integer():
            return str(int(value))
        text = format(float(value), ".15g")
        # Avoid scientific notation for normal business amounts when possible.
        if "e" in text.lower():
            from decimal import Decimal
            dec = Decimal(text)
            plain = format(dec, "f").rstrip("0").rstrip(".")
            return plain or "0"
        return text
    except Exception:
        return str(value)


def decimal_places_from_format(fmt):
    """Infer fixed decimal places from an Excel number format string."""
    fmt = (fmt or "General").split(';')[0]
    if '.' not in fmt:
        return 0, False
    decimal_part = fmt.split('.', 1)[1]
    places = 0
    for ch in decimal_part:
        if ch in '0#?':
            places += 1
        elif ch in ',%)] ':
            continue
        else:
            break
    return places, True


def format_numeric(value, number_format):
    """Format numeric value according to Excel number_format without exposing float noise."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None

    from decimal import Decimal, ROUND_HALF_UP, InvalidOperation

    fmt = (number_format or 'General').strip()
    fmt_main = fmt.split(';')[0].strip() if fmt else 'General'

    if fmt_main.lower() == 'general':
        return excel_general_number(value)

    is_percent = '%' in fmt_main
    has_comma = ',' in fmt_main
    decimal_places, has_decimal = decimal_places_from_format(fmt_main)

    try:
        dec = Decimal(str(value))
        if is_percent:
            dec *= Decimal('100')
        quant = Decimal('1') if decimal_places == 0 else Decimal('1').scaleb(-decimal_places)
        dec = dec.quantize(quant, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return excel_general_number(value)

    if has_decimal:
        num_text = f"{dec:,.{decimal_places}f}" if has_comma else f"{dec:.{decimal_places}f}"
    elif has_comma:
        num_text = f"{dec:,.0f}"
    elif is_percent:
        # Percent formats such as 0% are fixed-display formats. Do not strip
        # trailing zeros from 90 / 100, otherwise Excel values 0.9 / 1 become
        # 9% / 1%, which is incorrect.
        num_text = f"{dec:.0f}"
    else:
        num_text = format(dec, 'f').rstrip('0').rstrip('.')
        if num_text in ('', '-0'):
            num_text = '0'

    if is_percent:
        num_text += '%'
    return num_text


def strip_excel_locale_and_section(fmt):
    """Remove Excel locale/color/condition decorations that are not display text."""
    fmt = (fmt or '').split(';')[0]
    # Remove locale tags such as [$-zh-CN] and color/condition brackets.
    fmt = re.sub(r'\[\$-[^\]]+\]', '', fmt)
    fmt = re.sub(r'\[[^\]]+\]', '', fmt)
    return fmt.strip()


def format_date(value, number_format):
    """Format Excel date values while preserving month/day style from the cell format.

    In particular, m"月"d"日" / m月d日 must become 2月6日 rather than 02/06.
    """
    import datetime as dt_module

    if isinstance(value, dt_module.datetime):
        dt = value
    elif isinstance(value, dt_module.date):
        dt = dt_module.datetime.combine(value, dt_module.time())
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        from openpyxl.utils.datetime import from_excel
        try:
            dt = from_excel(value)
        except Exception:
            return excel_general_number(value)
    else:
        return None

    fmt = strip_excel_locale_and_section(number_format or 'yyyy/m/d')
    if not fmt or fmt.lower() == 'general':
        return f"{dt.month}/{dt.day}"

    # Normalize common escaped and quoted Chinese literals before token parsing.
    fmt = fmt.replace('\\-', '-').replace('\\/', '/').replace('\\.', '.')
    fmt = fmt.replace('"年"', '年').replace('"月"', '月').replace('"日"', '日')
    fmt = fmt.replace("'年'", '年').replace("'月'", '月').replace("'日'", '日')

    out = []
    i = 0
    in_quote = None
    while i < len(fmt):
        ch = fmt[i]
        if ch in ('"', "'"):
            if in_quote == ch:
                in_quote = None
            elif in_quote is None:
                in_quote = ch
            else:
                out.append(ch)
            i += 1
            continue
        if in_quote:
            out.append(ch)
            i += 1
            continue
        if ch == '\\' and i + 1 < len(fmt):
            out.append(fmt[i + 1])
            i += 2
            continue

        lower = ch.lower()
        if lower in ('y', 'm', 'd', 'h', 's'):
            j = i + 1
            while j < len(fmt) and fmt[j].lower() == lower:
                j += 1
            token = fmt[i:j].lower()
            if lower == 'y':
                out.append(f"{dt.year:04d}" if len(token) >= 4 else f"{dt.year % 100:02d}")
            elif lower == 'm':
                # In this skill's data, m/mm in date formats represent month.
                out.append(f"{dt.month:02d}" if len(token) >= 2 else str(dt.month))
            elif lower == 'd':
                out.append(f"{dt.day:02d}" if len(token) >= 2 else str(dt.day))
            elif lower == 'h':
                out.append(f"{dt.hour:02d}" if len(token) >= 2 else str(dt.hour))
            elif lower == 's':
                out.append(f"{dt.second:02d}" if len(token) >= 2 else str(dt.second))
            i = j
            continue

        # Ignore Excel-only fill/spacing markers; keep normal literals such as 月/日 and /.
        if ch in ('_', '*'):
            i += 2 if i + 1 < len(fmt) else 1
            continue
        if ch == '@':
            i += 1
            continue
        out.append(ch)
        i += 1

    result = ''.join(out).strip()
    return result if result else f"{dt.month}/{dt.day}"


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

def is_percent_number_format(number_format):
    """Return True when an Excel number format displays a value as a percentage."""
    if not number_format:
        return False
    fmt = str(number_format).split(';')[0]
    return '%' in fmt


def apply_percent_column_semantics(ws, headers, rows, compact_info, data_original_rows, merged_value_map, merged_format_map):
    """Backfill percentage display for inconsistent General cells in percent columns.

    Some customer workbooks mix correctly formatted percent cells (for example 0%)
    with plain General cells containing the same semantic value in a column whose
    header is explicitly a percent field, such as “平台下单服务费5%”. The Excel UI may
    make the column meaning obvious, but openpyxl would otherwise serialize the
    General cells as bare numbers like "0". If a header contains "%" and at least
    one data cell in that column uses a percent number format, normalize numeric
    General cells in the same column to percent text while preserving already
    formatted percent strings.
    """
    if not headers or not rows:
        return rows

    for col_idx, header in enumerate(headers):
        if '%' not in str(header or ''):
            continue
        old_col = compact_info.get("new_to_old_col", {}).get(col_idx + 1)
        if not old_col:
            continue

        percent_format_count = 0
        general_numeric_rows = []
        for row_idx, old_row in enumerate(data_original_rows):
            if not old_row:
                continue
            cell = ws.cell(old_row, old_col)
            raw_value = merged_value_map.get((old_row, old_col), cell.value)
            fmt = merged_format_map.get((old_row, old_col), cell.number_format)
            if is_percent_number_format(fmt):
                percent_format_count += 1
                continue
            if str(fmt or '').lower() == 'general' and isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
                general_numeric_rows.append((row_idx, raw_value))

        if percent_format_count <= 0:
            continue

        for row_idx, raw_value in general_numeric_rows:
            if row_idx >= len(rows) or col_idx >= len(rows[row_idx]):
                continue
            current = rows[row_idx][col_idx]
            if current is None or '%' in str(current):
                continue
            if abs(float(raw_value)) <= 1:
                rows[row_idx][col_idx] = format_numeric(raw_value, '0%')
            else:
                rows[row_idx][col_idx] = f"{excel_general_number(raw_value)}%"

    return rows


def expand_merged_cells(ws):
    """Return value/format mappings so merged ranges are faithfully split into cells.

    openpyxl exposes the top-left cell value for a merged range, while the other
    cells are MergedCell objects that usually have no useful value or display
    format. Downstream PPT rendering needs the merged area as repeated rows/cells,
    therefore both the value and the top-left number format must be propagated.
    This prevents cases such as a merged 0% cell becoming first row "0%" and
    second row "0".
    """
    merged_value_map = {}
    merged_format_map = {}
    for merged_range in ws.merged_cells.ranges:
        top_left_cell = ws.cell(merged_range.min_row, merged_range.min_col)
        top_left_value = top_left_cell.value
        top_left_format = top_left_cell.number_format
        for row in range(merged_range.min_row, merged_range.max_row + 1):
            for col in range(merged_range.min_col, merged_range.max_col + 1):
                merged_value_map[(row, col)] = top_left_value
                merged_format_map[(row, col)] = top_left_format
    return merged_value_map, merged_format_map


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


def build_value_matrix(ws, merged_value_map, merged_format_map=None):
    """Build a compacted matrix using cell values only, not image anchors.

    This is the most important fidelity rule. Image-only columns/rows are deliberately excluded
    from the table matrix so that PPTX does not render fake blank table columns.
    """
    merged_format_map = merged_format_map or {}
    raw = []
    row_has_value = set()
    col_has_value = set()

    for r in range(1, ws.max_row + 1):
        row_values = []
        for c in range(1, ws.max_column + 1):
            cell = ws.cell(r, c)
            # For merged cells, use the top-left value and top-left display format.
            value = merged_value_map.get((r, c), cell.value)
            number_format = merged_format_map.get((r, c), cell.number_format)
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
    """Find the most likely header row after blank row/column compaction.

    Merged title rows are expanded across many cells, so simply choosing the
    first row with two non-empty values can mistake a document title or section
    grouping row for the actual table header. Score early rows by header-like
    keywords and value diversity instead.
    """
    if not matrix:
        return 1

    header_keywords = [
        "序号", "项目名称", "内容方向", "媒体名称", "发布平台", "见刊日期", "见刊平台",
        "见刊标题", "见刊链接", "阅读量", "转发", "评论", "点赞", "截图", "备注",
        "对应rfq", "数量", "单位", "单价", "总价", "金额", "描述部分", "结算部分"
    ]
    search_rows = matrix[: min(12, len(matrix))]
    candidates = []
    for idx, row in enumerate(search_rows, start=1):
        values = [str(v).strip() for v in row if not is_blank(v)]
        if not values:
            continue
        norm_values = [re.sub(r"\s+", "", v).lower() for v in values]
        unique_count = len(set(norm_values))
        keyword_hits = sum(1 for v in norm_values if any(k.lower() in v for k in header_keywords))
        repeated_title_penalty = 8 if len(values) >= 3 and unique_count == 1 else 0
        score = keyword_hits * 10 + unique_count * 2 + min(len(values), 20) * 0.2 - repeated_title_penalty
        if len(values) >= 2 and (unique_count >= 2 or keyword_hits >= 1):
            candidates.append((score, idx))

    if candidates:
        candidates.sort(key=lambda item: (-item[0], item[1]))
        return candidates[0][1]

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
    if "鍙戠エ" in text:
        return "鍙戠エ鍑瘉"
    if "浠樻" in text or "鏀粯" in text or "鎵撴" in text or "杞处" in text:
        return "浠樻鍑瘉"
    if "鏁版嵁鎴浘" in text or ("鏁版嵁" in text and "鎴浘" in text):
        return "鏁版嵁鎴浘"
    if "鎴浘" in text:
        return "鏁版嵁鎴浘"
    if "鍚堝悓" in text:
        return "鍚堝悓鍑瘉"
    if "鍑瘉" in text:
        return column_name
    return column_name or "鍥剧墖鍑瘉"


def build_image_caption(headers, row_values, column_name, data_row_idx):
    """Build image caption as {鍙戝竷骞冲彴鍒楃殑鍐呭}-{濯掍綋鍚嶇О鍒楃殑鍐呭}-{鍥剧墖鎵€鍦ㄥ垪鐨勫悕瀛梷.

    Uses exact column name matching to find 鍙戝竷骞冲彴 and 濯掍綋鍚嶇О values,
    then uses the actual cell values from those columns for the current row.
    The column_name (voucher type) is used as-is without inference.
    """
    sequence_col_idx = None
    platform_col_idx = None
    media_col_idx = None
    has_daren_header = False

    for idx, header in enumerate(headers or []):
        if idx >= len(row_values):
            break
        h = normalize_match_text(header)
        if not h:
            continue
        if sequence_col_idx is None and h == "序号":
            if row_values[idx] is not None and str(row_values[idx]).strip() != "":
                sequence_col_idx = idx
        if platform_col_idx is None and "发布平台" in h:
            if row_values[idx] is not None and str(row_values[idx]).strip() != "":
                platform_col_idx = idx
        if media_col_idx is None:
            media_keywords = ["媒体名称", "媒体名", "达人", "账号名称", "账号", "名称", "kol", "koc"]
            if "达人" in h:
                has_daren_header = True
            if any(normalize_match_text(k) in h for k in media_keywords):
                if row_values[idx] is not None and str(row_values[idx]).strip() != "":
                    media_col_idx = idx

    sequence = row_values[sequence_col_idx] if sequence_col_idx is not None and sequence_col_idx < len(row_values) else None
    platform = row_values[platform_col_idx] if platform_col_idx is not None and platform_col_idx < len(row_values) else None
    media = row_values[media_col_idx] if media_col_idx is not None and media_col_idx < len(row_values) else None

    media_fallback = "未知达人" if has_daren_header else "未知媒体"
    parts = [
        caption_safe(platform, "未知平台"),
        caption_safe(media, media_fallback),
        caption_safe(column_name, "图片凭证"),
    ]
    if sequence is not None and str(sequence).strip() != "":
        parts.insert(0, caption_safe(sequence, f"第{data_row_idx + 1}"))
    return "-".join(parts)


def parse_sheet(ws, output_dir):
    """Parse a worksheet into faithful table data plus independent image metadata."""
    merged_value_map, merged_format_map = expand_merged_cells(ws)
    images = extract_images(ws, output_dir)
    compact_info = build_value_matrix(ws, merged_value_map, merged_format_map)
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

    optional_cols = [i for i, h in enumerate(headers) if is_non_required_header(h)]
    required_cols = [i for i in range(len(headers)) if i not in optional_cols]

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

    rows = apply_percent_column_semantics(
        ws, headers, rows, compact_info, data_original_rows, merged_value_map, merged_format_map
    )

    image_row_map = {}
    image_col_map = {}
    row_image_counts = {}
    image_cols_original = set()

    filtered_images = []
    excluded_images = []

    for img in images:
        if not img.get("file"):
            continue
        data_row_idx = nearest_data_row(img.get("anchor_row_original"), data_original_rows)
        if data_row_idx is None:
            continue

        col_name, data_col_index = infer_image_column_name(img, headers, compact_info)
        old_col = img.get("anchor_col_index_original")
        mapped_col_index = compact_info["old_to_new_col"].get(old_col) - 1 if old_col in compact_info["old_to_new_col"] else None
        header_for_filter = None
        if data_col_index is not None and 0 <= data_col_index < len(headers):
            header_for_filter = headers[data_col_index]
        elif mapped_col_index is not None and 0 <= mapped_col_index < len(headers):
            header_for_filter = headers[mapped_col_index]
        else:
            header_for_filter = col_name

        # Highest-priority exclusion: any image anchored to or inferred from a
        # column whose header contains “非必填 / PPT非必填” must have no relation to
        # the final PPTX, including image pages and captions.
        if is_non_required_header(header_for_filter) or is_non_required_header(col_name):
            img["excluded_from_pptx"] = True
            img["exclude_reason"] = "非必填列"
            excluded_images.append(img)
            continue

        row_values_for_caption = rows[data_row_idx] if 0 <= data_row_idx < len(rows) else []
        img["data_row_index"] = data_row_idx
        img["data_row_number"] = data_row_idx + 1
        img["data_col_index"] = data_col_index
        img["column_name"] = col_name
        img["caption"] = build_image_caption(headers, row_values_for_caption, col_name, data_row_idx)
        img["caption_rule"] = "鍙戝竷骞冲彴-濯掍綋鍚嶇О-鍑瘉绫诲瀷"
        img["belongs_to_table_column"] = data_col_index is not None
        img["anchor_row"] = compact_info["old_to_new_row"].get(img.get("anchor_row_original"))
        img["anchor_col_index"] = compact_info["old_to_new_col"].get(img.get("anchor_col_index_original"))
        img["anchor_col"] = get_column_letter(img["anchor_col_index"]) if img.get("anchor_col_index") else None

        filtered_images.append(img)
        rkey = str(data_row_idx)
        image_row_map.setdefault(rkey, []).append(img)
        row_image_counts[data_row_idx] = row_image_counts.get(data_row_idx, 0) + 1
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
        "images": filtered_images,
        "excluded_images": excluded_images,
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
    """Prefer a sheet named 姹囨€? otherwise do not guess too aggressively."""
    for i, sheet in enumerate(sheets):
        name = str(sheet.get("name", ""))
        if ("汇总" in name) or ("summary" in name.lower()):
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
    for token in ["锛堝繀濉級", "(蹇呭～)", "蹇呭～", "（必填）", "(必填)", "必填", "（非必填）", "(非必填)", "非必填"]:
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

    Business rule: the detail sheet should be merged only with the portion of the
    summary sheet whose FIRST COLUMN corresponds to the detail sheet name. Do not
    match against other columns such as 发布平台 / 内容形式, because values like
    “视频号” may appear in unrelated summary rows and would pollute the detail PPT.
    """
    if not summary_rows:
        return []
    if len(summary_rows) == 1:
        return [0]

    def strip_sequence(text):
        return re.sub(r"^\s*\d+[-_、，.．\s]*", "", str(text or "")).strip()

    detail_text = strip_sequence(detail_name)
    detail_norm = normalize_match_text(detail_text)
    if not detail_norm:
        return []

    # Primary rule: exact normalized match against summary-table first column.
    matched = []
    for ridx, row in enumerate(summary_rows):
        first_value = row[0] if row else None
        first_norm = normalize_match_text(strip_sequence(first_value))
        if first_norm and first_norm == detail_norm:
            matched.append(ridx)
    if matched:
        return matched

    # Do not perform fuzzy / token-based fallback for multi-row summary sheets.
    # A detail sheet may only inherit rows whose summary-table FIRST COLUMN exactly
    # corresponds to that detail sheet name after normalized cleanup. Composite sheet
    # names such as “A+B” are intentionally not expanded to “A” and “B”, because this
    # can mix unrelated summary blocks into the detail PPT.

    # Avoid order-based fallback for multi-row summary sheets. Returning an empty
    # list is safer than attaching unrelated summary rows to a detail PPT.
    return []


def build_summary_row_map(detail, summary_contexts):
    """Map detail data row indexes to matched summary row contexts.

    The main use case is settlement files where detail rows have `杈句汉` while
    summary rows have `濯掍綋鍚嶇О锛堝繀濉級`. Header aliases are intentionally broad,
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
      - If multiple attached summary rows can be matched to detail row values (e.g. detail `杈句汉` 鈫?summary `濯掍綋鍚嶇О`),
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


