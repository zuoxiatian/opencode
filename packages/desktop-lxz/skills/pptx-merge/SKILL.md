---
name: pptx-merge
description: >
  Merge multiple PPTX files into a single presentation while preserving embedded images.
  Handles relationship remapping automatically so all images display correctly after merging.
  Use when: (1) user wants to combine multiple PPTX files, (2) user says "合并PPT" / "合并演示文稿"
  / "把多个PPT合并成一个", (3) user has multiple presentations that need to be combined.
  Triggers: "合并PPT", "合并演示文稿", "merge PPTX", "combine presentations".
---

# PPTX Merge

Merge multiple PPTX files into a single presentation with proper image handling.

## Environment

```bash
PYTHON=~/.venv-doc/bin/python3  # or workspace/.venv-doc/bin/python3
SCRIPTS=skills/pptx-merge/scripts
```

Required: `python-pptx` (for verification only, the merge uses zipfile).

## Basic Usage

Merge files in specific order:

```bash
$PYTHON $SCRIPTS/merge_pptx.py file1.pptx file2.pptx file3.pptx -o merged.pptx
```

## How It Works

1. Takes multiple PPTX files as input (in desired merge order)
2. Copies all slides from each file sequentially
3. For each image found:
   - Generates a new unique filename (UUID-based)
   - Copies the image data to the merged file
   - Updates the slide's relationship XML to reference the new image ID
   - Updates the slide content to use the new relationship ID
4. Updates presentation.xml to reference all slides
5. Updates Content_Types.xml for all new media files

## Features

- Preserves all embedded images correctly
- Handles any number of input files
- Maintains merge order (first file's slides first, etc.)
- Generates unique media filenames to avoid conflicts
- Updates all relationship references properly

## Examples

### Merge all PPTX files in current directory

```bash
$PYTHON $SCRIPTS/merge_pptx.py *.pptx -o all_merged.pptx
```

### Merge specific files in order

```bash
$PYTHON $SCRIPTS/merge_pptx.py chapter1.pptx chapter2.pptx chapter3.pptx -o book.pptx
```

## Architecture

The merge process works at the OPC (Open Packaging Conventions) level:

1. PPTX files are ZIP archives containing XML parts
2. Slides are in `ppt/slides/` directory
3. Images are in `ppt/media/` directory
4. Relationships are in `_rels/` directories
5. The merge:
   - Copies slide XML files with new sequential names
   - Copies image files with new UUID-based names
   - Creates new relationship entries mapping new IDs to new image paths
   - Updates slide XML to reference new relationship IDs
   - Updates presentation.xml to reference all slides
   - Updates Content_Types.xml for new parts

This approach ensures all images remain accessible because:
- Each image gets a unique filename (avoiding overwrite conflicts)
- Each slide's relationship XML maps the embedded reference to the correct image
- The presentation.xml knows about all slides
- Content_Types.xml knows about all media types