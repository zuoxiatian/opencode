---
name: excel-to-pptx
metadata:
  version: "1.0.1"
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
| Summary sheet associations | If a summary sheet is detected, expanded summary rows are associated with detail sheets via `detail_sheet_associations`, `summary_association`, and `summary_context`. Prefer block/module prefixes such as `4-...` over pure sequence matching. If one detail sheet corresponds to multiple expanded summary rows, also build `summary_context_rows` and `summary_row_map` for verification and traceability. The layout engine renders the matched summary information as standalone summary page(s) before the detail table pages, not as an embedded block above the detail table. |
| Embedded images | Extract images separately from the table matrix, normalize anchors after row/column compaction, attach `data_row_index`, `column_name`, and `caption`. Captions use `列名-行序号` so pictures can be traced back to table rows. |

`read_template.py` extracts slide dimensions, theme colors, font names, and table styles. Template metadata can be attached to each sheet before layout. **Important: extracted template dimensions are metadata only; they must not be used to recalculate table/image geometry unless the user explicitly asks to preserve the template's physical page size.**

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

请告诉我您的需求，下面是目前默认的操作逻辑:
1.处理全部的sheet，带有“非必填”的列不保存到结果里
2.sheet中如果存在图片，则保存到结果里
3.每个生成的sheet PPTX默认增加一页封面，封面标题使用sheet名称，并居中放置；如用户提供PPTX模板则继承该模板，否则使用内置固定样式
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

Unmatched sheets use the default theme. Matched templates must carry the real `file_path` in `sheet["template"]["file_path"]`; `build_pptx.py` then opens that PPTX with `Presentation(template_path)` and clears only sample slides, so masters, layouts and theme are preserved in the generated output. **The generated table/image layout must remain locked to the built-in default layout canvas; user-template slide dimensions must not override table margins, row density, image-grid geometry, or title positions.** When a user template has a different slide size, the builder should scale the template's master/layout artwork into the default layout canvas rather than scaling the generated data layout to the template.

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
| `全部列` or no filter | 默认保留全部列，但列名包含 `非必填` / `PPT非必填` / `（非必填）` 的字段仍必须排除 |

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

When `summary_context` exists, the layout engine must create standalone `summary_context` page(s) before the detail table pages. The summary information is context for the detail sheet, not a substitute for the detail table. Therefore, it must not consume or replace detail table headers or data rows.

If a summary block contains multiple expanded rows for the same detail sheet, paginate those rows into readable standalone summary information pages, then render the detail table on subsequent pages. Multi-row standalone summary pages must use compact table row heights rather than stretching the table to the full slide height; by default, they follow the same 10-row page cap as detail table pages and automatically continue onto subsequent summary pages when needed. Detail table pages must not duplicate the multi-row summary block above the table. If a summary context has only one row, render that one summary row and the first detail-table page on the same slide: the summary row consumes one row slot, so the first page shows 1 summary row plus up to 9 detail rows. Detail sheets without summary context keep the normal 10 detail rows per page.

Use the parser metadata `image_column_count`, `max_images_per_data_row`, `image_row_map`, and per-image `caption`.

| Case | Layout mode | Rationale |
| --- | --- | --- |
| No images or user excludes images | Full-width table | Maximize table readability. |
| Image columns `< 3` and one data row has `< 4` images | `left-table-right-images` | Preserve the original table structure and place images beside the row table. |
| Image columns `> 3` | `top-table-bottom-images` | Put the table above and images below so screenshots/text remain legible. |
| Image columns `= 3` or one data row has `>= 4` images | `top-table-bottom-images` | Favor image readability over fitting many table rows on one slide. |

For `top-table-bottom-images`, cap table rows per page aggressively: normally 2 detail rows per page, and 1 row when a single row has very many images. For `left-table-right-images`, also reduce rows when row-level images are present so the table row and its associated images can appear on the same slide. This is intentional; readable screenshots are more important than dense pages. When embedded pictures are already extracted into the image grid, their source image/voucher columns must be removed from the main table to avoid blank duplicated fields; the pictures themselves, captions, and row association metadata remain as the authoritative representation of those fields. Every table page title should be the paginated table's sheet name, with page number only as secondary text. Image-only pages should use a compact centered grid with up to 8 images per slide. Each image is rendered in the original order from top to bottom within a column, then left to right across columns; the renderer scales each picture proportionally and stops when the longest edge reaches the 300px-equivalent size, without upscaling smaller images.

## Step 5 — Generate PPTX

```bash
for layout in /tmp/layouts/*.json; do
  name=$(basename "$layout" .json)
  $PYTHON $SCRIPTS/build_pptx.py "$layout" -o "/tmp/${name}.pptx" --theme $THEME
done
```

Each selected sheet produces a separate `.pptx` file, including the detected summary sheet when `--all` is used with the default `--include-summary` behavior. By default, every generated PPTX starts with a centered cover slide whose title is the sheet name; pass `--no-cover` to `layout_engine.py` only when the user explicitly asks to remove covers. `build_pptx.py` renders the layout modes above, repeats headers on paginated tables, draws standalone `summary_context` page(s) before detail pages when planned, places pictures into the planned image grid, and draws each picture's `caption` below the image. When a layout plan contains `template_file_path`, `build_pptx.py` must use the actual PPTX template as the presentation base; if a direct `--template` argument is supplied, it overrides the plan-level template path. After creating each generated slide from a user template, the renderer must remove cloned title/body placeholders such as “点击此处添加标题” so empty template placeholder text boxes never appear in the output. Generated table shapes should use the planned content width as much as possible instead of being horizontally centered as small blocks. Vertically, tables should keep dense row heights and flow normally from top to bottom; when a page has fewer than 10 rows, do not stretch or vertically center the table to fill the slide.

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
- **Summary sheet**: included by default as an independent PPTX when `--all` is used. Its expanded rows are also associated to detail sheets through JSON metadata. Prefer explicit block/module prefixes and row-level business-key matching over pure sequential matching. Matched summary blocks must be rendered as standalone summary information page(s) before the detail table pages, while the detail pages themselves remain focused on the detail sheet table and images.
- **Font ladder**: 12→10→8→7→6→5pt when columns are too wide or pure-table height would otherwise exceed the slide; auto-reduce per page while preserving readability.
- **Table pagination**: available height / row height = rows per page; header repeats each page.
- **Image captions**: every embedded image should display `{发布平台}-{媒体名称}-{凭证类型}` under the picture for traceability.
- **Image layout**: image-only pages use a centered grid with a hard cap of 8 images per slide. The preferred grid is 4 columns × 2 rows for a full image page. Images are filled top-to-bottom, then left-to-right, and each image is proportionally reduced until its longest edge is no larger than 300px-equivalent display size.
- **One PPTX per selected sheet**: each detail sheet generates its own PPTX with a centered sheet-name cover first, matched standalone summary information pages next, followed by table/image pages. The detected summary sheet also generates its own standalone PPTX by default.
- **Per-sheet templates**: each detail sheet can have independent theme/colors/orientation.
- **Template auto-match**: greedy keyword matching on filename vs sheet name.
- **Image extraction**: embedded images are saved to a temp dir and associated with rows by normalized anchor position.

## Edge cases

- All columns selected but too wide → font reduces; suggest landscape if still failing.
- Empty rows/columns caused by report formatting → removed during parsing.
- Summary cells merged across multiple rows → expanded so repeated values remain available for association. When multiple expanded summary rows belong to one detail sheet, render the matched summary rows as standalone summary information page(s) before the detail table pages, rather than repeating or embedding them above the detail table.
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
| 多行汇总 | 当汇总表因合并单元格展开或业务结构形成多行数据，并与分表存在多行对应关系时，必须先生成独立的汇总信息页；若行数较多，应分页展示汇总信息，然后再展示分表明细页。 |
| 单行汇总 | 当汇总表只有一行或某分表只关联一条汇总记录时，默认与分表第一页同页展示：汇总占 1 行，分表第一页最多 9 行；无汇总时分表每页固定 10 行。不得让一行汇总信息单独占用整页。 |
| 多链接单元格 | 若单个单元格粘贴多个显式链接，只保留第一个链接，避免 PPT 表格过宽、过长；单链接或非链接文本保持原意。 |
| 纯表格压缩 | 对没有图片的纯表格页，应采用高度感知的紧凑排版：在 12→10→8→7→6→5pt 字号梯度内选择能让整表不越界的最大可读字号，优先将中等行数的纯表格压缩到单个数据页内；若确实无法单页容纳，再分页。 |
| 图片字段外置 | 当图片已抽取并放置在表格旁边或下方时，主表格中对应的图片/截图/凭证/发票/付款/下单等源字段必须移除，避免空列重复占位；图片本体、下标和行关联元数据保留。 |
| 表格边框 | 所有主表格与汇总表格必须添加清晰黑色边框，确保投影、打印和审阅时表格边界明确。 |
| 日期展示保真 | Excel 中只展示月份和日期的日期型单元格，必须按单元格显示格式输出，例如 `m"月"d"日"` 或 `m月d日` 应输出 `2月6日`，不得改写为 `02/06`、`2026-02-06` 或其他未在表格中显示的形式。 |
| 金额精度保真 | 金额、费用、报价等数值必须按 Excel 显示精度输出，禁止暴露 Python/浮点二进制误差，例如 `107921.52` 不得输出为 `107921.52000000002`。读取阶段应先完成数字字符串化，再进入布局与 PPT 生成。 |
| 百分数保真 | 百分数字段必须按 Excel 显示倍率输出，禁止在去除尾随零时误删整数位，例如 `80%` 不得输出为 `8%`，`90%` 不得输出为 `9%`，`100%` 不得输出为 `1%`。若列表头含 `%` 且同列存在百分比格式单元格，则同列 `General` 格式的数值单元格也应按百分号语义输出，避免 `0%` 被写成裸 `0`。 |
| 用户模板保真 | 如果用户上传或指定 PPTX 模板，最终输出必须以该 PPTX 文件作为 presentation base 生成，而不是只读取颜色后新建默认空白 PPT。保留模板的母版、版式和主题，仅清除模板自带示例页；但表格和图片排版必须锁定内置默认布局画布，不得因为模板页面尺寸不同而改变边距、表格宽度、图片网格或标题位置。若模板尺寸不同，应缩放模板母版/版式内容到默认画布，而不是缩放生成的数据布局。 |
| 非必填字段过滤 | 列名只要包含 `非必填`、`PPT非必填`、`（非必填）` 等标记，优先级最高：无论该字段是否在 `selected_col_indices`、默认全列选择、图片源字段、图片锚点列或 fallback 列选择中出现，都不得进入最终 PPTX 主表格、匹配到分表的汇总信息块、独立汇总页、图片页、图片下标或任何行关联元数据。若所有列名都不含这些标记，则默认保留全部列，不再按固定优先级或 10 列上限裁剪汇总信息。 |
| 汇总表精确合并 | 分表 PPTX 只允许合并“汇总表第一列值与当前分表 sheet 名完全一致”的汇总行；不得把第一列属于其他分表、上级分类或相邻板块的汇总行混入当前分表。多行汇总应先生成独立汇总页再展示分表明细；单行汇总应与分表第一页同页展示，汇总占 1 行、分表最多 9 行，剩余分表数据按普通表格分页递归。 |
| 汇总表独立输出 | 使用 `--all` 批量生成时，检测到的汇总表默认也要单独生成一个 PPTX，其表格内容和图片外置规则与其他 sheet 保持一致；只有用户明确要求不输出汇总表时才使用 `--no-summary`。 |

