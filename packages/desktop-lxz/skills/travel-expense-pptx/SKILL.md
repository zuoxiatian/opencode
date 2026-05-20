---
name: travel-expense-pptx
description: >
  Generate travel expense settlement PPT from Excel summary data and invoice images using VLM.
  Supports extracting structured data from invoice/travel images (plane tickets, high-speed rail,
  etc.) via Vision Language Model, combining with Excel summary tables to produce formatted PPTX.
  Use when: (1) user provides an Excel file with travel expense summary and a folder of invoice
  images, (2) user says "差旅PPT" / "生成差旅结算" / "差旅费用报告" / "从发票生成PPT",
  (3) user wants to convert travel expense data and receipts into a presentation.
  Triggers: "差旅PPT", "生成差旅结算", "差旅费用报告", "从发票生成PPT",
  "差旅结算单", "travel expense PPT".
---

# Travel Expense PPTX

Generates a formatted travel expense settlement PPT from Excel summary data and invoice images.

```
Excel Summary + Invoice Images → VLM Recognition → JSON → PPTX (dynamic pages)
```

## Environment

```bash
PYTHON=python  # system Python with openpyxl, python-pptx, Pillow
SCRIPT=生成差旅PPT.py
```

Required: `openpyxl`, `python-pptx`, `Pillow`, `openai`.

## Input Requirements

### Excel File (`--excel`)
- Should contain travel expense summary data starting from row 3
- Expected columns:
  - Column A: Category (e.g., "差旅-城际交通")
  - Column B: Description/Direction
  - Column C: Media Name
  - Column D: Platform (e.g., "机票", "高铁", "住宿", "补贴")
  - Column E: Content Format
  - Column I: Unit Price
  - Column J: Quantity
  - Column K: Unit
  - Column L: Total Price
  - Column M: Corresponding RFQ
  - Column N: Notes

### Image Folder (`--images`)
- Folder containing invoice/travel images in PNG format
- Images are named with `.png` extension
- Each image is processed by VLM to extract:
  - Passenger name
  - Travel date (YYYY-MM-DD)
  - Departure location
  - Destination
  - Travel type (plane/high-speed rail)
  - Amount

## Output Structure

Each PPT page follows this layout:
```
┌─────────────────────────────────────────┐
│  Title: 人员差旅（城际交通）  ¥xxx.xx元  │
├─────────────────────────────────────────┤
│  汇总表格 (内容方向 | 媒体 | 平台 | ...) │
├─────────────────────────────────────────┤
│  明细表格 (姓名 | 时间 | 行程 | 出行方式) │
│  - rows that fit on page                │
│  - ...                                  │
├─────────────────────────────────────────┤
│  (if more rows, continue on next page) │
└─────────────────────────────────────────┘
```

**Rules:**
- Title with total amount at top
- Summary table below title (from Excel data, all non-empty columns preserved)
- Detail table below summary (from VLM-recognized images)
- Tables positioned slightly up-left (offset ~1cm right, ~1cm up for 2cm diagonal adjustment)
- Content that doesn't fit auto-recurses to next page
- No blank pages - only pages with content are created

**Summary Table Column Handling:**
- Dynamically detects all columns that have data in Excel
- Only displays columns with non-empty values
- Auto-scales font size: 10pt (≤6 cols), 8pt (7-8 cols), 7pt (>8 cols)
- All monetary values formatted with ¥ symbol and thousand separators

## Command

```bash
python 生成差旅PPT.py --excel <excel_path> --images <image_folder> --output <output_pptx>
```

### Arguments

| Argument | Short | Default | Description |
|----------|-------|---------|-------------|
| `--excel` | `-e` | `差旅表.xlsx` | Excel file path with travel summary |
| `--images` | `-i` | `城际交通` | Folder containing invoice images |
| `--output` | `-o` | `差旅结算.pptx` | Output PPTX file path |

## Example

```bash
# Basic usage
python 生成差旅PPT.py

# With custom paths
python 生成差旅PPT.py --excel 差旅表.xlsx --images 城际交通 --output 差旅结算.pptx
```

## VLM Configuration

The script uses a VLM (Vision Language Model) endpoint for invoice recognition:
- Endpoint: `http://116.62.224.41:17600/v1`
- Model: `qwen3.6-27b`
- API key is embedded in the script

The VLM extracts structured JSON from invoice images:
```json
{
  "name": "Zhang San",
  "date": "2026-05-15",
  "departure": "Shanghai Hongqiao",
  "destination": "Beijing",
  "travel_type": "高铁",
  "amount": 553.00
}
```

## Processing Flow

1. **Read Excel** - Parse summary data from active sheet starting row 3
2. **Recognize Images** - For each PNG in image folder:
   - Encode image as base64
   - Send to VLM with extraction prompt
   - Parse JSON response
   - Convert to internal format
3. **Generate PPTX** - Create presentation with dynamic pages:
   - Title with total amount at top
   - Summary table below title
   - Detail table with VLM-recognized data below summary
   - Auto-pagination when content exceeds one page
   - Remove trailing blank pages

## Pagination Rules

- Calculate available height: slide height minus title area minus summary table minus padding
- Calculate rows per page: available height / row height
- When detail rows exceed rows per page:
  - Add new slide with same title and header row
  - Continue detail table from where previous page ended
- Remove any trailing slides that contain only blank content

## Architecture Notes

- VLM recognition uses temperature=0.1 for consistent results
- JSON parsing handles both raw JSON and markdown-wrapped responses
- Tables are centered on slides with proper styling
- Amounts are formatted with thousand separators and 2 decimal places
- Travel type classification: "高铁"/"火车" → "高铁", otherwise → "飞机"
- Summary and detail tables both use black borders for clarity
