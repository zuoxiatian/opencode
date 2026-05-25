"""
Layout Engine 鈥?excel-to-pptx skill

甯冨眬鍘熷垯锛?
  - 琛ㄦ牸鍒楅泦鍚堢敱 read_excel.py 鐨?headers/data 鍐冲畾锛屼笉鍥犲浘鐗囬敋鐐瑰鍒犲垪銆?
  - 姣忛〉鏍囬浣跨敤褰撳墠鍒嗚〃 sheet 鍚嶃€?
  - 姹囨€昏〃浠呭湪鍗曡姹囨€绘椂浣滀负鍗曡琛ㄦ牸鏄剧ず锛涘琛屾眹鎬诲彧鐢ㄤ簬鍏宠仈锛屼笉鍦ㄥ垎琛ㄤ笂鏂归噸澶嶅睍绀恒€?
  - 鍥剧墖灏介噺涓庡叧鑱旇〃鏍艰鍚岄〉鍛堢幇锛涘唴瀹硅繃澶氭椂鍑忓皯姣忛〉鏁版嵁琛屾暟銆?

Usage:
  python layout_engine.py <input.json> [--output <path>] [--all]
"""

import argparse
import json
import sys
import os
import math
import re


SLIDE_W = 25.4
SLIDE_H = 14.2875
LANDSCAPE_W = 33.867
LANDSCAPE_H = 19.05

MARGIN_TOP = 1.35
MARGIN_BOTTOM = 0.6
MARGIN_LR = 0.8
MARGIN_INTERNAL = 0.32
TITLE_H = 0.75
SUMMARY_H = 1.05
SUMMARY_H_MULTI = 1.75
SUMMARY_ROWS_PER_PAGE = 10
SUMMARY_TABLE_FONT_SIZE = 5
FONT_SIZES = [12, 10, 8, 7, 6, 5]
IMAGE_HEADER_KEYWORDS = [
    "鎴浘", "鍥剧墖", "鐓х墖", "鍑瘉", "绁ㄦ嵁", "鍙戠エ", "浠樻", "鏀粯", "鍥炲崟", "姘村崟", "涓嬪崟",
]


def row_height(font_size):
    return {12: 0.62, 10: 0.52, 8: 0.42, 7: 0.36, 6: 0.31, 5: 0.28}.get(font_size, 0.42)


def header_row_height(font_size):
    return row_height(font_size) + 0.12


CHAR_W_CN = 0.042
CHAR_W_EN = 0.022


def estimate_text_width(text, font_size):
    if text is None:
        return 0
    text = str(text)
    cn = sum(1 for c in text if "\u4e00" <= c <= "\u9fff" or "\u3000" <= c <= "\u303f")
    en = len(text) - cn
    return (cn * CHAR_W_CN + en * CHAR_W_EN) * (font_size / 10.0)


def is_non_required_header(header):
    """Return True when a column header explicitly marks the column as 非必填/PPT非必填."""
    if header is None:
        return False
    normalized = str(header).replace(" ", "").replace("\n", "").lower()
    markers = ["非必填", "(非必填)", "（非必填）", "ppt非必填", "非必填列"]
    return any(marker in normalized for marker in markers)


def default_display_col_indices(headers, selected_col_indices=None):
    """Select display columns using the global rule: exclude 非必填, otherwise keep all."""
    all_indices = [i for i in range(len(headers or [])) if not is_non_required_header(headers[i])]
    if selected_col_indices is None:
        return all_indices
    selected = [ci for ci in selected_col_indices if 0 <= ci < len(headers or []) and not is_non_required_header(headers[ci])]
    return selected or all_indices


def estimate_col_widths(headers, data, col_indices, font_size):
    widths = []
    for ci in col_indices:
        max_w = estimate_text_width(headers[ci] if ci < len(headers) else "", font_size)
        for row in data[:50]:
            if ci < len(row) and row[ci] is not None:
                max_w = max(max_w, estimate_text_width(row[ci], font_size))
        widths.append(max_w + 0.35)
    return widths


def find_best_font_size(headers, data, col_indices, available_width):
    font_size = 5
    widths = estimate_col_widths(headers, data, col_indices, font_size)
    total = sum(widths)
    if total > available_width and total > 0:
        max_col = available_width * 0.36
        widths = [min(w, max_col) for w in widths]
        total = sum(widths)
        if total > available_width and total > 0:
            scale = available_width / total
            widths = [w * scale for w in widths]
    return font_size, widths


def count_image_columns(sheet):
    if sheet.get("image_column_count") is not None:
        return int(sheet.get("image_column_count") or 0)
    cols = set()
    for img in sheet.get("images", []):
        if img.get("anchor_col_index_original") is not None:
            cols.add(img.get("anchor_col_index_original"))
    return len(cols)


def max_images_per_row(sheet):
    if sheet.get("max_images_per_data_row") is not None:
        return int(sheet.get("max_images_per_data_row") or 0)
    image_row_map = sheet.get("image_row_map", {})
    return max((len(v) for v in image_row_map.values()), default=0)


def choose_layout_mode(sheet, include_images):
    images = [img for img in sheet.get("images", []) if img.get("file") and img.get("data_row_index") is not None]
    if not include_images or not images:
        return "full-table"
    return "top-table-bottom-images"


def clean_header_name(value):
    text = str(value or "")
    for token in ["锛堝繀濉級", "(蹇呭～)", "（必填）", "(必填)", "必填", "（非必填）", "(非必填)", "非必填", "ppt非必填", "PPT非必填"]:
        text = text.replace(token, "")
    return text.strip().lower()


def is_image_like_header(value):
    text = clean_header_name(value)
    return any(key.lower() in text for key in IMAGE_HEADER_KEYWORDS)


def is_non_required_header(value):
    """Hard rule: any header containing 非必填/PPT非必填 must never enter PPT tables."""
    text = str(value or "").replace(" ", "").replace("\n", "").lower()
    markers = ["非必填", "ppt非必填", "(非必填)", "（非必填）", "非必填列"]
    return any(marker in text for marker in markers)


def is_effectively_empty_header(value):
    text = clean_header_name(value)
    if not text:
        return True
    # Headers made only of punctuation/brackets are not meaningful for PPT tables.
    return re.fullmatch(r"[\(\)\[\]\{\}（）\-_.,:;，。；：/\\|]+", text) is not None


def column_has_any_data(data, col_idx):
    for row in data or []:
        if col_idx < len(row):
            cell = row[col_idx]
            if cell is not None and str(cell).strip() != "":
                return True
    return False


def externalized_image_col_indices(sheet):
    """Return table column indexes whose embedded images are already rendered outside the table."""
    cols = set()
    for img in sheet.get("images", []) or []:
        if not img.get("file") or img.get("data_row_index") is None:
            continue
        ci = img.get("data_col_index")
        if isinstance(ci, int):
            cols.add(ci)
    return cols


def filter_table_columns_for_layout(headers, data, col_indices, sheet, layout_mode, include_images):
    """Remove image/voucher source columns from the main table when pictures are displayed separately.

    The removed columns are not data loss: their embedded pictures remain in `images` and are placed in
    the planned image grid with captions. Keeping the source columns would only create blank placeholder
    columns and compress the readable business fields.
    """
    image_cols = externalized_image_col_indices(sheet)
    if not include_images or layout_mode == "full-table":
        kept = []
        dropped = []
        for ci in col_indices:
            header = headers[ci] if ci < len(headers) else ""
            if is_effectively_empty_header(header) or is_non_required_header(header):
                dropped.append(ci)
            else:
                kept.append(ci)
        return (kept or col_indices), dropped

    has_external_images = bool(image_cols)
    dropped = []
    kept = []
    for ci in col_indices:
        header = headers[ci] if ci < len(headers) else ""
        should_drop = False
        if is_effectively_empty_header(header):
            should_drop = True
        elif is_non_required_header(header):
            should_drop = True
        elif not column_has_any_data(data, ci):
            should_drop = True
        elif ci in image_cols or (has_external_images and is_image_like_header(header)):
            should_drop = True
        if should_drop:
            dropped.append(ci)
        else:
            kept.append(ci)

    if kept:
        return kept, dropped
    return col_indices, []


def choose_table_font_size(headers, data, col_indices, available_width, available_height, layout_mode, font_size=5):
    """Pick largest readable font in 12→10→8→7→6→5 that fits width+10-row height."""
    rows_per_page = 10
    for size in FONT_SIZES:
        widths = estimate_col_widths(headers, data, col_indices, size)
        total = sum(widths)
        if total > available_width and total > 0:
            max_col = available_width * 0.36
            widths = [min(w, max_col) for w in widths]
            total = sum(widths)
            if total > available_width and total > 0:
                scale = available_width / total
                widths = [w * scale for w in widths]
        needed_h = header_row_height(size) + rows_per_page * row_height(size)
        if needed_h <= available_height:
            return size, widths

    widths = estimate_col_widths(headers, data, col_indices, 5)
    total = sum(widths)
    if total > available_width and total > 0:
        scale = available_width / total
        widths = [w * scale for w in widths]
    return 5, widths


def collect_page_images(image_row_map, start, end):
    page_images = []
    for ridx in range(start, end):
        row_images = image_row_map.get(str(ridx), [])
        page_images.extend(sorted(row_images, key=lambda img: (img.get("anchor_col_index_original", 9999), img.get("index", 9999))))
    return page_images


def make_image_grid(image_count, image_area, layout_mode):
    if image_count <= 0 or not image_area:
        return None
    if layout_mode == "left-table-right-images":
        cols = 1 if image_count <= 2 else 2
    else:
        # 涓婅〃涓嬪浘鏃舵渶澶?4 鍒楋紝閬垮厤鍗曞紶鍥捐繃灏忓鑷存枃瀛椾笉鍙銆?
        cols = min(4, max(1, math.ceil(math.sqrt(image_count))))
    return {
        "cols": cols,
        "rows": math.ceil(image_count / cols),
        "gap_cm": 0.18,
        "caption_h_cm": 0.32,
    }


def has_summary_for_page(summary_context, page_idx):
    if not summary_context:
        return False
    mode = summary_context.get("display_mode", "every_page")
    if mode in ("every_page", "match_detail_rows", "page_row_matches"):
        return True
    return page_idx == 0


def unique_contexts(contexts):
    seen = set()
    result = []
    for ctx in contexts:
        key = ctx.get("summary_row_index", ctx.get("summary_row_number"))
        if key in seen:
            continue
        seen.add(key)
        result.append(ctx)
    return result


def build_page_summary_context(sheet, base_summary_context, start, end, page_idx):
    """Return the summary context that should be rendered on the current detail page."""
    if not has_summary_for_page(base_summary_context, page_idx):
        return None

    if base_summary_context.get("rows"):
        row_map = sheet.get("summary_row_map") or {}
        contexts = []
        for ridx in range(start, end):
            contexts.extend(row_map.get(str(ridx), []))
        contexts = unique_contexts(contexts)
        if contexts:
            return {
                "summary_sheet_name": base_summary_context.get("summary_sheet_name"),
                "detail_sheet_index": base_summary_context.get("detail_sheet_index"),
                "detail_sheet_name": base_summary_context.get("detail_sheet_name"),
                "display_mode": "page_row_matches",
                "headers": base_summary_context.get("headers", []),
                "rows": [ctx.get("row", []) for ctx in contexts],
                "values_list": [ctx.get("values", {}) for ctx in contexts],
                "summary_row_indices": [ctx.get("summary_row_index") for ctx in contexts],
                "summary_row_numbers": [ctx.get("summary_row_number") for ctx in contexts],
                "match_note": "当前页明细对应的汇总行",
            }
        return base_summary_context
    return base_summary_context


def summary_context_row_count(summary_context):
    if not summary_context:
        return 0
    rows = summary_context.get("rows")
    if isinstance(rows, list) and rows:
        return len(rows)
    return 1


def summary_height_for_count(row_count):
    if row_count <= 1:
        return SUMMARY_H
    return min(2.25, max(SUMMARY_H_MULTI, 0.62 + row_count * 0.34))


def compact_summary_area_height(row_count, available_height):
    """Return a compact summary block height instead of stretching to the full slide.

    This mirrors detail-table behavior: the summary table uses small fixed-height rows
    and only consumes the vertical space it actually needs. Pagination is handled before
    rendering, so the area may still grow up to the available height on unusually small slides.
    """
    data_rows = max(1, int(row_count or 1))
    compact_h = 0.48 + header_row_height(SUMMARY_TABLE_FONT_SIZE) + data_rows * row_height(SUMMARY_TABLE_FONT_SIZE)
    return min(max(0.95, compact_h), available_height)


def summary_rows_per_page(available_height):
    """Use the same 10-row page cap as detail tables, unless the slide is too short."""
    usable_table_h = max(0.3, available_height - 0.48)
    capacity = int((usable_table_h - header_row_height(SUMMARY_TABLE_FONT_SIZE)) // row_height(SUMMARY_TABLE_FONT_SIZE))
    return max(1, min(SUMMARY_ROWS_PER_PAGE, capacity))


def clone_summary_context(summary_context, start=None, end=None):
    """Copy summary context, optionally slicing multi-row summary data for one standalone page."""
    if not summary_context:
        return None
    ctx = dict(summary_context)
    rows = summary_context.get("rows") or []
    if rows:
        s = 0 if start is None else start
        e = len(rows) if end is None else end
        ctx["rows"] = rows[s:e]
        if summary_context.get("values_list"):
            ctx["values_list"] = summary_context.get("values_list", [])[s:e]
        if summary_context.get("summary_row_indices"):
            ctx["summary_row_indices"] = summary_context.get("summary_row_indices", [])[s:e]
        if summary_context.get("summary_row_numbers"):
            ctx["summary_row_numbers"] = summary_context.get("summary_row_numbers", [])[s:e]
    ctx["match_note"] = ctx.get("match_note") or "分表对应汇总信息"
    return ctx


def plan_standalone_summary_pages(sheet, slide_w, slide_h):
    """Create separate summary-info pages before detail table pages.

    Multi-row summaries are paginated as standalone summary pages. A single-row
    summary is not allowed to occupy a whole slide by itself; it is rendered at
    the top of the first detail-table slide and reduces that first slide's detail
    capacity from 10 rows to 9 rows.
    """
    summary_context = sheet.get("summary_context")
    if not summary_context:
        return []

    content_top = MARGIN_TOP
    content_w = slide_w - 2 * MARGIN_LR
    content_h = slide_h - MARGIN_TOP - MARGIN_BOTTOM
    rows_value = summary_context.get("rows")
    rows = rows_value or []
    if isinstance(rows_value, list) and not rows_value:
        return []

    row_count = summary_context_row_count(summary_context)
    if row_count <= 1:
        return []

    max_rows_per_page = summary_rows_per_page(content_h)
    chunks = [(i, min(i + max_rows_per_page, len(rows))) for i in range(0, len(rows), max_rows_per_page)]

    pages = []
    total = len(chunks)
    for page_idx, (start, end) in enumerate(chunks):
        page_context = clone_summary_context(summary_context, start, end)
        pages.append({
            "type": "summary_context",
            "title": f"{sheet.get('name', 'Sheet')} 汇总信息",
            "sheet_name": sheet.get("name", "Sheet"),
            "page_index": page_idx,
            "page_total": total,
            "summary_context": page_context,
            "summary_area": {
                "x_cm": MARGIN_LR,
                "y_cm": content_top,
                "w_cm": content_w,
                "h_cm": content_h,
                "compact_h_cm": compact_summary_area_height(end - start, content_h),
            },
        })
    return pages


def build_summary_area(content_top, content_w, summary_context=None):
    row_count = summary_context_row_count(summary_context)
    return {
        "x_cm": MARGIN_LR,
        "y_cm": content_top,
        "w_cm": content_w,
        "h_cm": summary_height_for_count(row_count),
    }


def choose_row_cap(layout_mode, sheet):
    image_cols = count_image_columns(sheet)
    max_row_imgs = max_images_per_row(sheet)
    if layout_mode == "full-table":
        # 绾〃鏍间紭鍏堢揣鍑戝憟鐜帮紝鍏佽鎸夊閲忓敖閲忔斁鍏ヤ竴椤碉紝涓嶅洜琛岀骇姹囨€绘槧灏勫己鍒跺垎椤点€?
        return None
    if layout_mode == "left-table-right-images":
        if max_row_imgs >= 3:
            return 1
        if max_row_imgs == 2:
            return 2
        return 3
    # 涓婅〃涓嬪浘锛氫紭鍏堝浘鐗囨竻鏅帮紝閫氬父姣忛〉 1-2 琛屻€?
    if max_row_imgs >= 6 or image_cols > 4:
        return 1
    return 2


def plan_table_pages(sheet, slide_w, slide_h, include_images, font_size=5):
    headers = sheet.get("headers", [])
    data = sheet.get("data", [])
    if not data or not headers:
        return []

    col_indices = default_display_col_indices(headers, sheet.get("selected_col_indices"))
    if not col_indices:
        return []

    summary_context = sheet.get("summary_context")
    layout_mode = choose_layout_mode(sheet, include_images)
    col_indices, dropped_image_col_indices = filter_table_columns_for_layout(
        headers, data, col_indices, sheet, layout_mode, include_images
    )

    content_top = MARGIN_TOP
    content_h = slide_h - MARGIN_TOP - MARGIN_BOTTOM
    content_w = slide_w - 2 * MARGIN_LR

    single_summary_on_first_page = bool(summary_context) and summary_context_row_count(summary_context) == 1
    first_summary_area = build_summary_area(content_top, content_w, summary_context) if single_summary_on_first_page else None
    first_table_top = content_top
    first_table_h = content_h
    if first_summary_area:
        first_table_top = first_summary_area["y_cm"] + first_summary_area["h_cm"] + 0.20
        first_table_h = max(1.0, content_h - first_summary_area["h_cm"] - 0.20)

    table_w = content_w
    regular_table_area = {"x_cm": MARGIN_LR, "y_cm": content_top, "w_cm": table_w, "h_cm": content_h}
    first_table_area = {"x_cm": MARGIN_LR, "y_cm": first_table_top, "w_cm": table_w, "h_cm": first_table_h}

    font_size, col_widths = choose_table_font_size(headers, data, col_indices, table_w, first_table_area["h_cm"], layout_mode, font_size)
    regular_rows_per_page = 10
    first_rows_per_page = 9 if single_summary_on_first_page else regular_rows_per_page

    pages = []
    start = 0
    page_idx = 0
    row_ranges = []
    while start < len(data):
        cap = first_rows_per_page if page_idx == 0 else regular_rows_per_page
        end = min(start + cap, len(data))
        row_ranges.append((start, end))
        start = end
        page_idx += 1
    total_pages = len(row_ranges)
    for page_idx, (start, end) in enumerate(row_ranges):
        page_rows = data[start:end]
        page_summary_context = clone_summary_context(summary_context) if page_idx == 0 and single_summary_on_first_page else None
        page_summary_area = first_summary_area if page_summary_context else None
        table_area = first_table_area if page_summary_context else regular_table_area

        pages.append({
            "type": "table",
            "title": sheet.get("name", "Sheet"),
            "sheet_name": sheet.get("name", "Sheet"),
            "layout": layout_mode,
            "page_index": page_idx,
            "page_total": total_pages,
            "row_start": start,
            "row_end": end,
            "font_size": font_size,
            "col_widths": col_widths,
            "table_width_cm": table_w,
            "dropped_image_col_indices": dropped_image_col_indices,
            "summary_context": page_summary_context,
            "summary_area": page_summary_area,
            "table_area": table_area,
            "image_area": None,
            "image_grid": None,
            "headers": [headers[ci] if ci < len(headers) else "" for ci in col_indices],
            "rows": [[row[ci] if ci < len(row) else None for ci in col_indices] for row in page_rows],
            "images": [],
        })
    return pages


def plan_image_pages(sheet, slide_w, slide_h, include_images):
    if not include_images:
        return []
    images = [img for img in sheet.get("images", []) if img.get("file") and img.get("data_row_index") is not None]
    if not images:
        return []

    content_top = MARGIN_TOP
    content_h = slide_h - MARGIN_TOP - MARGIN_BOTTOM
    content_w = slide_w - 2 * MARGIN_LR
    image_area = {"x_cm": MARGIN_LR, "y_cm": content_top, "w_cm": content_w, "h_cm": content_h}

    gap_cm = 0.18
    caption_h_cm = 0.32
    per_page = 8

    def image_grid_for_count(count):
        visible_count = max(1, min(per_page, int(count or 1)))
        rows = 1 if visible_count == 1 else 2
        cols = min(4, max(1, math.ceil(visible_count / rows)))
        return {
            "cols": cols,
            "rows": rows,
            "gap_cm": gap_cm,
            "caption_h_cm": caption_h_cm,
            "target_max_px": 300,
            "fill_order": "column_major",
            "max_images_per_page": per_page,
        }

    pages = []
    total_pages = math.ceil(len(images) / per_page)
    for page_idx in range(total_pages):
        start = page_idx * per_page
        end = min(start + per_page, len(images))
        image_grid = image_grid_for_count(end - start)
        pages.append({
            "type": "images",
            "title": sheet.get("name", "Sheet"),
            "sheet_name": sheet.get("name", "Sheet"),
            "layout": "top-table-bottom-images",
            "page_index": page_idx,
            "page_total": total_pages,
            "image_area": image_area,
            "image_grid": image_grid,
            "images": images[start:end],
        })
    return pages


def get_slide_dims(sheet, options):
    template = sheet.get("template")
    if template and template.get("slide_width_cm"):
        return template["slide_width_cm"], template["slide_height_cm"]
    orientation = sheet.get("orientation") or options.get("default_orientation", "portrait")
    if orientation == "landscape":
        return LANDSCAPE_W, LANDSCAPE_H
    return SLIDE_W, SLIDE_H


def should_skip_sheet(parsed_data, sheet_index, options):
    summary_idx = parsed_data.get("summary_sheet_index", -1)
    if sheet_index == summary_idx and not options.get("include_summary", False):
        return True
    return False


def build_plan_for_sheet(sheet, options):
    title = options.get("title", "鎶ュ憡")
    sw, sh = get_slide_dims(sheet, options)
    include_images = options.get("include_images", True)
    template_info = sheet.get("template")

    plan = {
        "title": f"{title} — {sheet.get('name', 'Sheet')}",
        "sheet_name": sheet.get("name", "Sheet"),
        "orientation": options.get("default_orientation", "portrait"),
        "pages": [],
    }
    if template_info:
        plan["template_file_path"] = template_info.get("file_path")
        plan["template_name"] = template_info.get("name")
    planned_pages = (
        plan_standalone_summary_pages(sheet, sw, sh)
        + plan_table_pages(sheet, sw, sh, include_images)
        + plan_image_pages(sheet, sw, sh, include_images)
    )

    if options.get("include_cover", True):
        cover_page = {
            "type": "cover",
            "title": sheet.get("name", "Sheet"),
            "orientation": options.get("default_orientation", "portrait"),
            "slide_dims": {"w": sw, "h": sh},
        }
        if template_info:
            cover_page["theme"] = template_info.get("theme", {})
        plan["pages"].append(cover_page)

    for page in planned_pages:
        page["slide_dims"] = {"w": sw, "h": sh}
        if template_info:
            page["theme"] = template_info.get("theme", {})
        plan["pages"].append(page)
    return plan


def build_layout_plan(parsed_data, options):
    sheets = parsed_data.get("sheets", [])
    sheet = sheets[0] if sheets else None
    if not sheet:
        return {"title": options.get("title", "鎶ュ憡"), "pages": []}
    return build_plan_for_sheet(sheet, options)


def build_all_layouts(parsed_data, options):
    results = []
    for i, sheet in enumerate(parsed_data.get("sheets", [])):
        if should_skip_sheet(parsed_data, i, options):
            continue
        results.append((sheet.get("name", f"sheet_{i + 1}"), build_plan_for_sheet(sheet, options)))
    return results


def main():
    parser = argparse.ArgumentParser(description="Layout engine for Excel鈫扨PTX")
    parser.add_argument("input", help="Input JSON (parsed Excel data)")
    parser.add_argument("--output", "-o", help="Output JSON path (or dir for --all)")
    parser.add_argument("--title", help="Report title")
    parser.add_argument("--orientation", choices=["portrait", "landscape"], default="portrait")
    parser.add_argument("--include-images", action="store_true", default=True)
    parser.add_argument("--include-summary", action="store_true", default=True, help="Include the detected summary sheet as its own PPTX when --all is used")
    parser.add_argument("--no-summary", dest="include_summary", action="store_false", help="Skip the detected summary sheet when --all is used")
    parser.add_argument("--all", action="store_true", help="Generate one layout per detail sheet")
    parser.add_argument("--font-size", type=int, default=5, help="Table font size in pt (default: 5)")
    parser.add_argument("--include-cover", dest="include_cover", action="store_true", default=True, help="Add a centered sheet-name cover slide to each generated PPTX (default)")
    parser.add_argument("--no-cover", dest="include_cover", action="store_false", help="Do not add cover slides")
    args = parser.parse_args()

    with open(args.input, encoding="utf-8") as f:
        parsed_data = json.load(f)

    options = {
        "title": args.title or parsed_data.get("file", "鎶ュ憡").replace(".xlsx", ""),
        "default_orientation": args.orientation,
        "include_images": args.include_images,
        "include_summary": args.include_summary,
        "font_size": args.font_size,
        "include_cover": args.include_cover,
    }

    if args.all:
        if args.output:
            os.makedirs(args.output, exist_ok=True)
        for name, plan in build_all_layouts(parsed_data, options):
            json_str = json.dumps(plan, ensure_ascii=False, indent=2, default=str)
            out_path = os.path.join(args.output, f"{name}.json") if args.output else None
            if out_path:
                with open(out_path, "w", encoding="utf-8") as f:
                    f.write(json_str)
                print(f"Layout: {name} 鈫?{len(plan['pages'])} pages 鈫?{out_path}", file=sys.stderr)
            else:
                print(json_str)
    else:
        plan = build_layout_plan(parsed_data, options)
        json_str = json.dumps(plan, ensure_ascii=False, indent=2, default=str)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(json_str)
            print(f"Layout plan: {len(plan['pages'])} pages 鈫?{args.output}", file=sys.stderr)
        else:
            print(json_str)


if __name__ == "__main__":
    main()

