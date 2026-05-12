"""
Layout Engine — excel-to-pptx skill

布局原则：
  - 表格列集合由 read_excel.py 的 headers/data 决定，不因图片锚点增删列。
  - 每页标题使用当前分表 sheet 名。
  - 汇总表仅在单行汇总时作为单行表格显示；多行汇总只用于关联，不在分表上方重复展示。
  - 图片尽量与关联表格行同页呈现；内容过多时减少每页数据行数。

Usage:
  python layout_engine.py <input.json> [--output <path>] [--all]
"""

import argparse
import json
import sys
import os
import math


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
FONT_SIZES = [12, 10, 8, 7, 6, 5]
IMAGE_HEADER_KEYWORDS = [
    "截图", "图片", "照片", "凭证", "票据", "发票", "付款", "支付", "回单", "水单", "下单",
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

    image_cols = count_image_columns(sheet)
    max_row_imgs = max_images_per_row(sheet)
    if image_cols > 3:
        return "top-table-bottom-images"
    if image_cols < 3 and max_row_imgs < 4:
        return "left-table-right-images"
    return "top-table-bottom-images"


def clean_header_name(value):
    return str(value or "").replace("（必填）", "").replace("(必填)", "").strip().lower()


def is_image_like_header(value):
    text = clean_header_name(value)
    return any(key.lower() in text for key in IMAGE_HEADER_KEYWORDS)


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
    if not include_images or layout_mode == "full-table":
        return col_indices, []

    image_cols = externalized_image_col_indices(sheet)
    has_external_images = bool(image_cols)
    dropped = []
    kept = []
    for ci in col_indices:
        header = headers[ci] if ci < len(headers) else ""
        should_drop = ci in image_cols or (has_external_images and is_image_like_header(header))
        if should_drop:
            dropped.append(ci)
        else:
            kept.append(ci)

    if kept:
        return kept, dropped
    return col_indices, []


def choose_table_font_size(headers, data, col_indices, available_width, available_height, layout_mode, font_size=5):
    """Select font size - uses passed font_size or falls back to 5pt for consistency."""
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
        # 上表下图时最多 4 列，避免单张图过小导致文字不可读。
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
    """Return page summary display context.

    New business rule: when the summary sheet contributes multiple rows to a
    detail sheet, those rows are used only for row-level association and should
    not be rendered above the detail table. Only single-row summary contexts are
    displayed, and they are rendered as a one-row table by build_pptx.py.
    """
    if not has_summary_for_page(base_summary_context, page_idx):
        return None

    if base_summary_context.get("rows"):
        return None
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
        # 纯表格优先紧凑呈现，允许按容量尽量放入一页，不因行级汇总映射强制分页。
        return None
    if layout_mode == "left-table-right-images":
        if max_row_imgs >= 3:
            return 1
        if max_row_imgs == 2:
            return 2
        return 3
    # 上表下图：优先图片清晰，通常每页 1-2 行。
    if max_row_imgs >= 6 or image_cols > 4:
        return 1
    return 2


def plan_table_pages(sheet, slide_w, slide_h, include_images, font_size=5):
    headers = sheet.get("headers", [])
    data = sheet.get("data", [])
    if not data or not headers:
        return []

    col_indices = sheet.get("selected_col_indices", list(range(len(headers))))
    col_indices = [ci for ci in col_indices if 0 <= ci < len(headers)]
    if not col_indices:
        col_indices = list(range(len(headers)))

    image_row_map = sheet.get("image_row_map", {})
    summary_context = sheet.get("summary_context")
    layout_mode = choose_layout_mode(sheet, include_images)
    col_indices, dropped_image_col_indices = filter_table_columns_for_layout(
        headers, data, col_indices, sheet, layout_mode, include_images
    )

    content_top = MARGIN_TOP
    content_h = slide_h - MARGIN_TOP - MARGIN_BOTTOM
    content_w = slide_w - 2 * MARGIN_LR

    # 仅单行汇总需要预留展示区域；多行汇总不在分表上方展示。
    display_summary_context = summary_context if summary_context and not summary_context.get("rows") else None
    expected_summary_rows = 1 if display_summary_context else 0
    reserved_summary_h = summary_height_for_count(expected_summary_rows) + MARGIN_INTERNAL if display_summary_context else 0
    usable_top = content_top + reserved_summary_h
    usable_h = max(2.0, content_h - reserved_summary_h)

    if layout_mode == "left-table-right-images":
        table_w = content_w * 0.58
        image_w = content_w * 0.39
        gap_w = content_w * 0.03
        table_area = {"x_cm": MARGIN_LR, "y_cm": usable_top, "w_cm": table_w, "h_cm": usable_h}
        image_area = {"x_cm": MARGIN_LR + table_w + gap_w, "y_cm": usable_top, "w_cm": image_w, "h_cm": usable_h}
    elif layout_mode == "top-table-bottom-images":
        table_w = content_w
        row_cap = choose_row_cap(layout_mode, sheet) or 2
        font_tmp, _ = choose_table_font_size(headers, data, col_indices, table_w, usable_h, layout_mode, font_size)
        table_h_needed = header_row_height(font_tmp) + row_cap * row_height(font_tmp)
        table_h = min(max(table_h_needed, 1.5), usable_h * 0.36)
        table_area = {"x_cm": MARGIN_LR, "y_cm": usable_top, "w_cm": table_w, "h_cm": table_h, "row_cap": row_cap}
        image_area = {"x_cm": MARGIN_LR, "y_cm": usable_top + table_h + MARGIN_INTERNAL, "w_cm": content_w, "h_cm": max(1.2, usable_h - table_h - MARGIN_INTERNAL)}
    else:
        table_w = content_w
        table_area = {"x_cm": MARGIN_LR, "y_cm": usable_top, "w_cm": table_w, "h_cm": usable_h}
        image_area = None

    font_size, col_widths = choose_table_font_size(headers, data, col_indices, table_w, table_area["h_cm"], layout_mode, font_size)
    h_row = row_height(font_size)
    h_header = header_row_height(font_size)
    capacity = max(1, int((table_area["h_cm"] - h_header) / h_row))
    cap_by_images = choose_row_cap(layout_mode, sheet)
    data_rows_per_page = min(capacity, cap_by_images) if cap_by_images else capacity
    data_rows_per_page = max(1, data_rows_per_page)

    pages = []
    total_pages = math.ceil(len(data) / data_rows_per_page)
    for page_idx in range(total_pages):
        start = page_idx * data_rows_per_page
        end = min(start + data_rows_per_page, len(data))
        page_rows = data[start:end]
        page_images = collect_page_images(image_row_map, start, end) if layout_mode != "full-table" else []
        page_image_area = image_area if page_images else None
        page_summary_context = build_page_summary_context(sheet, summary_context, start, end, page_idx)

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
            "summary_area": build_summary_area(content_top, content_w, page_summary_context) if page_summary_context else None,
            "table_area": table_area,
            "image_area": page_image_area,
            "image_grid": make_image_grid(len(page_images), page_image_area, layout_mode) if page_images else None,
            "headers": [headers[ci] if ci < len(headers) else "" for ci in col_indices],
            "rows": [[row[ci] if ci < len(row) else None for ci in col_indices] for row in page_rows],
            "images": page_images,
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
    title = options.get("title", "报告")
    sw, sh = get_slide_dims(sheet, options)
    include_images = options.get("include_images", True)
    template_info = sheet.get("template")

    plan = {
        "title": f"{title} — {sheet.get('name', 'Sheet')}",
        "sheet_name": sheet.get("name", "Sheet"),
        "orientation": options.get("default_orientation", "portrait"),
        "pages": [],
    }
    plan["pages"].append({
        "type": "cover",
        "title": sheet.get("name", "Sheet"),
        "orientation": options.get("default_orientation", "portrait"),
        "slide_dims": {"w": sw, "h": sh},
    })

    for page in plan_table_pages(sheet, sw, sh, include_images, options.get("font_size", 5)):
        page["slide_dims"] = {"w": sw, "h": sh}
        if template_info:
            page["theme"] = template_info.get("theme", {})
        plan["pages"].append(page)
    return plan


def build_layout_plan(parsed_data, options):
    sheets = parsed_data.get("sheets", [])
    sheet = sheets[0] if sheets else None
    if not sheet:
        return {"title": options.get("title", "报告"), "pages": []}
    return build_plan_for_sheet(sheet, options)


def build_all_layouts(parsed_data, options):
    results = []
    for i, sheet in enumerate(parsed_data.get("sheets", [])):
        if should_skip_sheet(parsed_data, i, options):
            continue
        results.append((sheet.get("name", f"sheet_{i + 1}"), build_plan_for_sheet(sheet, options)))
    return results


def main():
    parser = argparse.ArgumentParser(description="Layout engine for Excel→PPTX")
    parser.add_argument("input", help="Input JSON (parsed Excel data)")
    parser.add_argument("--output", "-o", help="Output JSON path (or dir for --all)")
    parser.add_argument("--title", help="Report title")
    parser.add_argument("--orientation", choices=["portrait", "landscape"], default="portrait")
    parser.add_argument("--include-images", action="store_true", default=True)
    parser.add_argument("--include-summary", action="store_true", default=False)
    parser.add_argument("--all", action="store_true", help="Generate one layout per detail sheet")
    parser.add_argument("--font-size", type=int, default=5, help="Table font size in pt (default: 5)")
    args = parser.parse_args()

    with open(args.input, encoding="utf-8") as f:
        parsed_data = json.load(f)

    options = {
        "title": args.title or parsed_data.get("file", "报告").replace(".xlsx", ""),
        "default_orientation": args.orientation,
        "include_images": args.include_images,
        "include_summary": args.include_summary,
        "font_size": args.font_size,
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
                print(f"Layout: {name} → {len(plan['pages'])} pages → {out_path}", file=sys.stderr)
            else:
                print(json_str)
    else:
        plan = build_layout_plan(parsed_data, options)
        json_str = json.dumps(plan, ensure_ascii=False, indent=2, default=str)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(json_str)
            print(f"Layout plan: {len(plan['pages'])} pages → {args.output}", file=sys.stderr)
        else:
            print(json_str)


if __name__ == "__main__":
    main()
