---
name: excel-to-pptx
description: >
  Convert Excel spreadsheets (with optional PPTX templates) to well-formatted PowerPoint (.pptx).
  Supports multi-sheet Excel files (summary + detail sheets), embedded images, merged cells,
  dynamic column selection via natural language, per-sheet template mapping, automatic table
  pagination with font-size scaling, and image layout within slides. Use when: (1) user provides
  an Excel file and asks to convert to PPTX/PPT, (2) user says "Excel转PPT" / "表格转幻灯片" /
  "结算文件转报告" / "导出PPT", (3) user provides Excel + one or more PPTX templates and wants
  data rendered with those styles, (4) user wants to put Excel table data and images into presentation
  slides, especially when summary sheets contain merged cells or detail sheets contain many embedded images.
  Triggers: "Excel转PPT", "excel to pptx", "表格转幻灯片", "做PPT", "结算报告",
  "把Excel做成PPT", "导出PPT", "生成演示文稿", "Excel生成报告" (when Excel file is provided).
---

# Excel to PPTX

Five scripts form the pipeline. All run under `~/.venv-doc/bin/python3` unless that venv is unavailable; in that case use the system Python with `openpyxl`, `python-pptx`, and `Pillow` installed.

```
Excel + Templates → read_excel.py + read_template.py → JSON
  → filter_columns.py → filtered JSON → layout_engine.py → Layout Plan
  → build_pptx.py → .pptx
```

**Critical: column filtering must only set `selected_col_indices` on each sheet, never replace `headers` or `data`.** The layout engine reads these fields directly and relies on them being the complete, unfiltered table matrix.

## Environment

```bash
PYTHON=~/.venv-doc/bin/python3  # or workspace/.venv-doc/bin/python3
SCRIPTS=skills/excel-to-pptx/scripts
THEME=skills/excel-to-pptx/assets/default-theme.json
```

Required: `openpyxl`, `python-pptx`, `Pillow`.

## Step 1 — Parse inputs

Parse Excel:

```bash
$PYTHON $SCRIPTS/read_excel.py <input.xlsx> -o /tmp/excel_data.json
```

If user provided PPTX templates, parse each:

```bash
$PYTHON $SCRIPTS/read_template.py <template1.pptx> -o /tmp/tmpl1.json
$PYTHON $SCRIPTS/read_template.py <template2.pptx> -o /tmp/tmpl2.json
```

`read_excel.py` must be treated as the source of truth. **The highest priority is faithfully preserving the Excel table matrix.** Image layout optimizations must never delete table headers, suppress data columns, or create fake blank columns in the rendered table.

| Normalization | Required behavior |
| --- | --- |
| Empty rows/columns | Build the table matrix from real cell values first, then remove blank spacer rows and blank spacer columns before header detection and JSON export. Image-only anchor columns are extracted as image metadata and must not become empty table columns. |
| Merged cells | Expand merged ranges by filling every cell in the range with the top-left value before removing blank rows/columns. This is especially important for summary sheets because one merged summary value may apply to multiple detail sheets. |
| Summary sheet associations | If a summary sheet is detected, expanded summary rows are associated with detail sheets via `detail_sheet_associations`, `summary_association`, and `summary_context`. Prefer block/module prefixes such as `4-...` over pure sequence matching. If one detail sheet corresponds to multiple expanded summary rows, also build `summary_context_rows` and `summary_row_map` so each page can render only the summary rows matching that page's detail rows. If the summary has a single data row, show it only on the first page. |
| Embedded images | Extract images separately from the table matrix, normalize anchors after row/column compaction, attach `data_row_index`, `column_name`, and `caption`. Captions use `列名-行序号` so pictures can be traced back to table rows. |

`read_template.py` extracts slide dimensions, theme colors, font names, and table styles. Template metadata can be attached to each sheet before layout.

## Step 2 — Present structure & collect user preferences

Tell user what was found, including merged-cell normalization and image density when relevant:

```text
发现 6 个 Sheet：
  【汇总】— 5行×8列（自动识别为汇总表；已展开合并单元格；已删除空行空列）
  【1-车马费合作-云评】— 24行×23列，13张嵌入图片，图片列2列，单行最多3张，必填列9个
  【2-车马费合作-通稿】— 47行×6列
  ...

检测到 2 个模板：
  云评模板.pptx → 自动匹配 "1-车马费合作-云评"
  平台模板.pptx → 自动匹配 "4-媒体合作-平台单链接"

请告诉我：
1. 要转哪些 Sheet？（如 "全部" / "1,3,4"）
2. 不要哪些列？（如 "不要对接、审核人" / "只要必填列"）
3. 图片要不要放进去？
```

**Key: user replies in natural language.** Parse intent, do not force scripted choices.

## Step 3 — Match templates & filter columns

### Template matching

Auto-match by filename keywords via `read_template.py:auto_match_templates`. Let user confirm or override.

Attach matched template info to each sheet's JSON:

```json
{
  "name": "1-车马费合作-云评",
  "template": { "name": "云评模板.pptx", "theme": {}, "slide_width_cm": 25.4 }
}
```

Unmatched sheets use the default theme.

### Column filtering

**Use `filter_columns.py` to set `selected_col_indices` without modifying `headers` or `data`.**

```bash
# Exclude columns containing keywords
$PYTHON $SCRIPTS/filter_columns.py /tmp/excel_data.json --exclude "对接,审核人" -o /tmp/filtered.json

# Include only required columns
$PYTHON $SCRIPTS/filter_columns.py /tmp/excel_data.json --include-required -o /tmp/filtered.json

# Include specific columns
$PYTHON $SCRIPTS/filter_columns.py /tmp/excel_data.json --include "序号,媒体名称,播放量" -o /tmp/filtered.json

# Combine: required columns + exclude some
$PYTHON $SCRIPTS/filter_columns.py /tmp/excel_data.json --include-required --exclude "备注" -o /tmp/filtered.json
```

Parse user language as follows:

| User wording | Action |
| --- | --- |
| `不要XX` | Run with `--exclude "XX"` |
| `只要必填列` | Run with `--include-required` |
| `保留序号、媒体名称、播放量` | Run with `--include "序号,媒体名称,播放量"` |
| `全部列` or no filter | Skip filtering, use all columns |

**Important: do NOT replace `headers` or `data` in the JSON.** The layout engine reads these directly. Only `selected_col_indices` should be set.

## Step 4 — Layout engine

Generate one layout plan per selected detail sheet:

```bash
mkdir -p /tmp/layouts
$PYTHON $SCRIPTS/layout_engine.py /tmp/filtered.json -o /tmp/layouts --all \
  --title "报告标题" --orientation portrait --include-images
```

The layout engine reads `headers` and `data` directly from the JSON and uses each sheet's `selected_col_indices` (set by `filter_columns.py`) to determine which columns to display.

For a single sheet:

```bash
$PYTHON $SCRIPTS/layout_engine.py /tmp/single_sheet.json -o /tmp/layout.json \
  --title "报告标题" --include-images
```

### Summary-row and image layout rules

When `summary_context` exists, the layout engine must reserve a compact summary area between the page title and detail table. The summary row is context for the detail sheet, not a substitute for the detail table. Therefore, it must not consume or replace detail table headers or data rows.

If a summary block contains multiple expanded rows for the same detail sheet, never repeat the first row on every page and never render the multi-row summary block above detail pages. Multi-row summary data is retained only for row-level association, verification, and traceability. Only a single-row summary context may be rendered above the detail table, and it must be rendered as a compact one-row table rather than as inline text.

Use the parser metadata `image_column_count`, `max_images_per_data_row`, `image_row_map`, and per-image `caption`.

| Case | Layout mode | Rationale |
| --- | --- | --- |
| No images or user excludes images | Full-width table | Maximize table readability. |
| Image columns `< 3` and one data row has `< 4` images | `left-table-right-images` | Preserve the original table structure and place images beside the row table. |
| Image columns `> 3` | `top-table-bottom-images` | Put the table above and images below so screenshots/text remain legible. |
| Image columns `= 3` or one data row has `>= 4` images | `top-table-bottom-images` | Favor image readability over fitting many table rows on one slide. |

For `top-table-bottom-images`, cap table rows per page aggressively: normally 2 detail rows per page, and 1 row when a single row has very many images. For `left-table-right-images`, also reduce rows when row-level images are present so the table row and its associated images can appear on the same slide. This is intentional; readable screenshots are more important than dense pages. When embedded pictures are already extracted into the image grid, their source image/voucher columns must be removed from the main table to avoid blank duplicated fields; the pictures themselves, captions, and row association metadata remain as the authoritative representation of those fields. Every table page title should be the paginated table's sheet name, with page number only as secondary text.

## Step 5 — Generate PPTX

```bash
for layout in /tmp/layouts/*.json; do
  name=$(basename "$layout" .json)
  $PYTHON $SCRIPTS/build_pptx.py "$layout" -o "/tmp/${name}.pptx" --theme $THEME
done
```

Each detail sheet produces a separate `.pptx` file. `build_pptx.py` renders the layout modes above, repeats headers on paginated tables, draws `summary_context` above the table when planned, renders multi-row page-level summary contexts as compact tables, places pictures into the planned image grid, and draws each picture's `caption` below the image.

## Step 6 — Deliver

Send all `.pptx` files to the user with a summary:

```text
生成完成！共 5 个文件：
1-车马费合作-云评.pptx（4页，1.9MB）
2-车马费合作-通稿.pptx（4页，35KB）
3-媒体合作-线下合同.pptx（4页，2.4MB）
4-媒体合作-平台单链接.pptx（4页，5.7MB）
5-媒体合作-平台多链接.pptx（6页，4.1MB）
```

Attach all generated PPTX files.

## Architecture decisions

- **Excel normalization first**: expand merged cells, remove blank rows/columns from the real cell matrix, then detect headers and export JSON. Do not repair merged summary sheets later in the PPT step.
- **Table fidelity first**: the parser must preserve the original Excel table headers and data values. Image-only columns must be stored as image metadata and must not appear as blank table columns. During layout, if embedded images are rendered beside or below the table, their source image/voucher columns should also be excluded from the main table because the image grid already carries that information.
- **Column filtering**: use `filter_columns.py` to set `selected_col_indices` only. Never replace `headers` or `data` in the JSON — the layout engine reads these directly.
- **Summary sheet**: skipped by default as an independent PPT section, but its expanded rows are associated to detail sheets through JSON metadata. Prefer explicit block/module prefixes and row-level business-key matching over pure sequential matching. Multi-row summary blocks must not be rendered above detail pages; they are retained for association, verification, and traceability only.
- **Font ladder**: 12→10→8→7→6→5pt when columns are too wide or pure-table height would otherwise exceed the slide; auto-reduce per page while preserving readability.
- **Table pagination**: available height / row height = rows per page; header repeats each page.
- **Image captions**: every embedded image should display `{发布平台}-{媒体名称}-{凭证类型}` under the picture for traceability.
- **Image layout**: few image columns use side-by-side table/image layout; many image columns use top-table/bottom-image layout and fewer rows per page.
- **One PPTX per detail sheet**: each detail sheet generates its own PPTX with cover + table pages.
- **Per-sheet templates**: each detail sheet can have independent theme/colors/orientation.
- **Template auto-match**: greedy keyword matching on filename vs sheet name.
- **Image extraction**: embedded images are saved to a temp dir and associated with rows by normalized anchor position.

## Edge cases

- All columns selected but too wide → font reduces; suggest landscape if still failing.
- Empty rows/columns caused by report formatting → removed during parsing.
- Summary cells merged across multiple rows → expanded so repeated values remain available for association. When multiple expanded summary rows belong to one detail sheet, match summary rows to the current page's detail rows and render all matched rows above the detail table instead of repeating only the first summary row.
- No images → skip image layout entirely.
- Image-heavy sheet with unreadable screenshots → use `top-table-bottom-images`, reduce rows per page, or ask user whether to split further.
- Empty sheet → skip (0 pages).
- Only 1 detail sheet → skip TOC page.
- Template has no detectable colors → fall back to default theme.
- Image file missing or corrupt → skip with warning, do not fail the whole job.

## 新增业务规则：结算表展示优化（2026-05）

处理结算类 Excel 时，必须遵循以下展示规则，并将其作为默认转换行为：

| 规则 | 要求 |
| --- | --- |
| 图片下标命名 | 图片下标必须使用 `{发布平台}-{媒体名称}-{凭证类型}` 格式。凭证类型优先从图片所在列名判断，例如“数据截图”“发票凭证”“付款凭证”“合同凭证”等；缺失字段允许使用“未知平台”“第N行”等兜底值。 |
| 多行汇总 | 当汇总表因合并单元格展开或业务结构形成多行数据，并与分表存在多行对应关系时，汇总数据只用于行级关联和校验，不再展示在分表页面上方。 |
| 单行汇总 | 当汇总表只有一行或某分表只关联一条汇总记录时，分表首页上方必须用单行表格展示汇总信息，不得渲染为长文本段落。 |
| 多链接单元格 | 若单个单元格粘贴多个显式链接，只保留第一个链接，避免 PPT 表格过宽、过长；单链接或非链接文本保持原意。 |
| 纯表格压缩 | 对没有图片的纯表格页，应采用高度感知的紧凑排版：在 12→10→8→7→6→5pt 字号梯度内选择能让整表不越界的最大可读字号，优先将中等行数的纯表格压缩到单个数据页内；若确实无法单页容纳，再分页。 |
| 图片字段外置 | 当图片已抽取并放置在表格旁边或下方时，主表格中对应的图片/截图/凭证/发票/付款/下单等源字段必须移除，避免空列重复占位；图片本体、下标和行关联元数据保留。 |
| 表格边框 | 所有主表格与汇总表格必须添加清晰黑色边框，确保投影、打印和审阅时表格边界明确。 |

