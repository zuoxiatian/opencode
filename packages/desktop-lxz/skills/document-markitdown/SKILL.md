---
name: document-markitdown
description: >
  Read and extract text content from documents using the bundled MarkItDown Python package.
  Use for PDF, Word, PowerPoint, Excel, HTML, CSV, JSON, XML, text, and other office/document
  files when the user asks to inspect, summarize, convert, or quote document contents.
  Triggers: read document, extract file text, convert to markdown, PDF content, Word content,
  PPT content, Excel content, read pdf/docx/pptx/xlsx.
---

# Document MarkItDown

Use the bundled Python runtime and this skill's `scripts/convert.py` helper to convert document files to Markdown text. MarkItDown is installed into the bundled Python environment under `runtimes/<platform>/python`, so do not use a skill-local vendor path.

## Environment

Use `OPENCODE_PYTHON` first. Do not ask the user to install Python or packages.

PowerShell:

```powershell
$skillDir = "C:\path\to\document-markitdown"
& $env:OPENCODE_PYTHON "$skillDir\scripts\convert.py" "C:\path\file.pdf"
```

Bash:

```bash
skill_dir="/path/to/document-markitdown"
"$OPENCODE_PYTHON" "$skill_dir/scripts/convert.py" "/path/file.pdf"
```

If `OPENCODE_PYTHON` is unavailable, use `python` from PATH. The desktop app puts bundled runtimes first in PATH.

## Supported Inputs

Use this skill for:

- PDF: `.pdf`
- Word: `.docx`, `.doc`
- PowerPoint: `.pptx`, `.ppt`
- Excel: `.xlsx`, `.xls`, `.csv`
- Web/data/text: `.html`, `.xml`, `.json`, `.txt`, `.md`
- Other formats supported by MarkItDown in the bundled runtime

## Basic Workflow

1. Resolve the user's document path to an absolute path.
2. Locate this skill directory and run `scripts/convert.py` with the bundled Python runtime.
3. Save large extracted content to a Markdown file when output is long.
4. Use the extracted Markdown to answer the user's question, summarize, quote short relevant sections, or continue processing.

## Convert A File To Markdown

PowerShell single-file conversion:

```powershell
$skillDir = "C:\path\to\document-markitdown"
$inputFile = "C:\path\document.pdf"
$outputFile = "C:\path\document.markdown.md"
& $env:OPENCODE_PYTHON "$skillDir\scripts\convert.py" $inputFile --output $outputFile
```

Bash single-file conversion:

```bash
skill_dir="/path/to/document-markitdown"
input_file="/path/document.pdf"
output_file="/path/document.markdown.md"
"$OPENCODE_PYTHON" "$skill_dir/scripts/convert.py" "$input_file" --output "$output_file"
```

## Inspect Without Saving

For small files or quick checks:

```powershell
$skillDir = "C:\path\to\document-markitdown"
& $env:OPENCODE_PYTHON "$skillDir\scripts\convert.py" "C:\path\document.docx"
```

## Notes

- Prefer writing extracted Markdown to a file for large PDFs, PPTX files, and Excel workbooks.
- MarkItDown and its dependencies should be installed into the bundled Python runtime, for example `runtimes/win32-x64/python/Lib/site-packages` on Windows.
- If conversion fails for a legacy binary format such as `.doc`, `.ppt`, or `.xls`, report the failure and suggest converting the file to `.docx`, `.pptx`, or `.xlsx`.
- Keep extracted text as Markdown; do not invent missing document content.
