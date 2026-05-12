#!/usr/bin/env python3
"""
PPTX Template Reader — excel-to-pptx skill
解析 PPTX 模板文件，提取母版配色、字体、布局占位符信息。

Usage:
  python read_template.py <template.pptx> [-o output.json]

Output JSON:
  {
    "name": "模板名",
    "slide_width_cm": 25.4,
    "slide_height_cm": 14.2875,
    "theme": {
      "title_color": "#1B365D",
      "header_bg": "#1B365D",
      ...
    },
    "layouts": [...],
    "master_slides": [...]
  }
"""

import argparse
import json
import sys
import os

from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from lxml import etree

EMU_PER_CM = 360000

# XML namespaces
NSMAP = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
}


def rgb_to_hex(color):
    """Convert RGBColor or color object to hex string."""
    if isinstance(color, RGBColor):
        return f"#{color}"
    if isinstance(color, str):
        return color
    return None


def extract_color_from_element(elem, tag='srgbClr'):
    """Extract hex color from an XML element."""
    if elem is None:
        return None
    srgb = elem.find(f'.//{{{NSMAP["a"]}}}{tag}')
    if srgb is not None:
        return f"#{srgb.get('val', '000000')}"
    # Try schemeClr
    scheme = elem.find(f'.//{{{NSMAP["a"]}}}schemeClr')
    if scheme is not None:
        return f"scheme:{scheme.get('val', '')}"
    return None


def parse_slide_theme(slide, prs):
    """Extract colors from a slide's text runs and shapes."""
    colors = {}
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                if run.font.size:
                    colors.setdefault('title_size', int(run.font.size.pt))
                if run.font.name:
                    colors.setdefault('font_name', run.font.name)
                if run.font.color and run.font.color.rgb:
                    hex_c = rgb_to_hex(run.font.color.rgb)
                    if hex_c:
                        colors.setdefault('text_color', hex_c)
        # Shape fill
        if shape.shape_type is not None:
            try:
                fill = shape.fill
                if fill.type is not None:
                    try:
                        c = fill.fore_color.rgb
                        hex_c = rgb_to_hex(c)
                        if hex_c:
                            colors.setdefault('shape_fill', hex_c)
                    except:
                        pass
            except:
                pass
    return colors


def parse_table_styles(slide):
    """Extract table styles if any tables exist on the slide."""
    table_styles = {}
    for shape in slide.shapes:
        if shape.has_table:
            table = shape.table
            # Header row colors
            if table.rows:
                for ci, cell in enumerate(table.rows[0].cells):
                    tcPr = cell._tc.find(f'{{{NSMAP["a"]}}}tcPr')
                    if tcPr is not None:
                        fill = tcPr.find(f'.//{{{NSMAP["a"]}}}solidFill')
                        color = extract_color_from_element(fill)
                        if color:
                            table_styles.setdefault('header_bg', color)
                        # Text color
                        rPr = tcPr.find(f'.//{{{NSMAP["a"]}}}rPr')
                        if rPr is not None:
                            solidFill = rPr.find(f'{{{NSMAP["a"]}}}solidFill')
                            fg = extract_color_from_element(solidFill)
                            if fg:
                                table_styles.setdefault('header_fg', fg)
            # Data row colors
            for ri, row in enumerate(table.rows[1:], 1):
                for cell in row.cells:
                    tcPr = cell._tc.find(f'{{{NSMAP["a"]}}}tcPr')
                    if tcPr is not None:
                        fill = tcPr.find(f'.//{{{NSMAP["a"]}}}solidFill')
                        color = extract_color_from_element(fill)
                        if color:
                            key = 'row_even_bg' if ri % 2 == 1 else 'row_odd_bg'
                            table_styles.setdefault(key, color)
                            break  # one cell per row is enough
    return table_styles


def extract_slide_master_colors(prs):
    """Extract theme colors from the presentation's slide master."""
    colors = {}
    try:
        # Access theme XML
        theme_xml = None
        for rel in prs.part.rels.values():
            if 'theme' in rel.reltype:
                theme_xml = rel.target_part.blob
                break

        if theme_xml:
            root = etree.fromstring(theme_xml)
            # Extract color scheme
            clrScheme = root.find('.//{{{NSMAP["a"]}}}clrScheme')
            if clrScheme is not None:
                for child in clrScheme:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    srgb = child.find(f'{{{NSMAP["a"]}}}srgbClr')
                    if srgb is not None:
                        colors[f'theme_{tag}'] = f"#{srgb.get('val', '')}"
    except Exception as e:
        print(f"Warning: could not extract master theme: {e}", file=sys.stderr)

    return colors


def parse_template(filepath):
    """Parse a PPTX template and extract theme/layout info."""
    prs = Presentation(filepath)

    slide_w_cm = prs.slide_width / EMU_PER_CM
    slide_h_cm = prs.slide_height / EMU_PER_CM

    # Extract master theme colors
    master_colors = extract_slide_master_colors(prs)

    # Parse all slide layouts for their properties
    layout_info = []
    for layout in prs.slide_layouts:
        layout_info.append({
            "name": layout.name,
            "slide_count": len(layout.placeholders),
        })

    # Parse existing slides for theme extraction
    slide_themes = []
    table_styles_found = {}
    for slide in prs.slides:
        theme = parse_slide_theme(slide, prs)
        if theme:
            slide_themes.append(theme)
        ts = parse_table_styles(slide)
        if ts:
            table_styles_found.update(ts)

    # Merge all discovered colors into a theme
    theme = {}
    # Start with master colors
    theme.update(master_colors)
    # Apply slide-level discoveries
    for st in slide_themes:
        for k, v in st.items():
            theme.setdefault(k, v)
    # Apply table styles
    for k, v in table_styles_found.items():
        theme[k] = v

    # Map to our standard theme keys
    result_theme = {}
    mapping = {
        'title_color': ['theme_dk1', 'text_color'],
        'header_bg': ['shape_fill', 'theme_dk2'],
        'header_fg': ['theme_lt1'],
        'row_even': ['row_even_bg', 'shape_fill'],
        'row_odd': ['row_odd_bg'],
        'accent': ['theme_accent1', 'shape_fill'],
    }
    for our_key, source_keys in mapping.items():
        for sk in source_keys:
            if sk in theme:
                result_theme[our_key] = theme[sk]
                break

    # Font discovery
    if 'font_name' in theme:
        result_theme['title_font'] = theme['font_name']
        result_theme['body_font'] = theme['font_name']
        result_theme['header_font'] = theme['font_name']

    if 'title_size' in theme:
        result_theme['title_size'] = theme['title_size']

    return {
        "name": os.path.basename(filepath),
        "file_path": filepath,
        "slide_width_cm": round(slide_w_cm, 2),
        "slide_height_cm": round(slide_h_cm, 2),
        "orientation": "landscape" if slide_w_cm > slide_h_cm else "portrait",
        "total_slides": len(prs.slides),
        "theme": result_theme,
        "raw_colors": theme,
        "layouts": layout_info,
    }


def match_template_to_sheet(template_info, sheet_name):
    """Score how well a template matches a sheet (0-1)."""
    score = 0
    tname = template_info["name"].lower()
    sname = sheet_name.lower()

    # Exact name match in filename
    if sname.replace(" ", "") in tname.replace(" ", "").replace("-", ""):
        score += 0.5

    # Keyword overlap
    sheet_parts = set(sname.replace("-", " ").split())
    template_parts = set(os.path.splitext(tname)[0].replace("-", " ").split())
    overlap = sheet_parts & template_parts
    if overlap:
        score += len(overlap) * 0.15

    # Cap at 1.0
    return min(score, 1.0)


def auto_match_templates(templates, sheet_names):
    """Auto-assign templates to sheets based on filename matching."""
    assignments = {}
    used_templates = set()

    # Score all pairs
    scores = []
    for si, sn in enumerate(sheet_names):
        for ti, tmpl in enumerate(templates):
            score = match_template_to_sheet(tmpl, sn)
            if score > 0:
                scores.append((score, si, ti))

    # Greedy assignment (highest score first)
    scores.sort(reverse=True)
    for score, si, ti in scores:
        if sheet_names[si] not in assignments and ti not in used_templates:
            assignments[sheet_names[si]] = templates[ti]
            used_templates.add(ti)

    return assignments


def main():
    parser = argparse.ArgumentParser(description="Parse PPTX template")
    parser.add_argument("input", help="Path to PPTX template")
    parser.add_argument("--output", "-o", help="Output JSON path")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    result = parse_template(args.input)

    json_str = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(json_str)
        print(f"Template parsed to {args.output}", file=sys.stderr)
    else:
        print(json_str)


if __name__ == "__main__":
    main()
