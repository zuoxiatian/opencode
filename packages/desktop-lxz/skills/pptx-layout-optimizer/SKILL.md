---
name: pptx-layout-optimizer
description: >
  PPTX layout optimization and overlap repair. Use when a user provides a .pptx/.pptm file and asks to fix blocked, overlapped, hidden, crowded, or visually colliding slide elements; requests “PPT布局优化”, “PPT遮挡修复”, “元素重叠”, “排版错乱”, “文字被盖住”, or wants an optimized PowerPoint copy plus a layout audit report. The skill audits slide geometry, conservatively moves low-priority shapes, preserves all original content, and outputs an optimized PPTX with Markdown/JSON reports.
---

# PPTX Layout Optimizer

Use this skill when the user already has a PowerPoint file and the main problem is **layout obstruction** rather than content creation. The goal is to preserve all original pages, text, images, charts, and tables, while reducing accidental overlaps among visible elements. The default result should include an optimized `.pptx` file and a readable layout report.

> The optimization is geometry-based. It uses each shape’s `left`、`top`、`width`、`height` coordinates exposed by python-pptx, whose documentation states these values are writable and expressed in EMU units.[1] It should therefore be treated as a conservative repair pass, not as a full redesign engine.

## Workflow

| Step | Action | Output |
| --- | --- | --- |
| 1 | Save the user’s original PPTX unchanged and work on a copy. | Original file remains untouched. |
| 2 | Run an audit first when the deck is complex, image-heavy, or business-critical. | Markdown/JSON report describing overlap risks. |
| 3 | Run the optimizer in `balanced` mode unless the user requests stricter or more aggressive behavior. | Optimized PPTX copy. |
| 4 | Review the report and remaining-risk section before delivery. | Clear explanation of what was fixed and what remains. |
| 5 | Attach the optimized PPTX and Markdown report to the final response. | User receives usable files, not just notes. |

## Core script

Use the bundled script:

```bash
python /home/ubuntu/skills/pptx-layout-optimizer/scripts/optimize_pptx_layout.py input.pptx \
  -o output_layout_optimized.pptx \
  --report output_layout_report.md \
  --json-report output_layout_report.json \
  --mode balanced
```

If `python-pptx` is unavailable, install it before running the script:

```bash
sudo pip3 install python-pptx
```

## Mode selection

| Mode | Use when | Behavior |
| --- | --- | --- |
| `audit` | The user wants diagnosis only, or the PPTX is highly sensitive. | Detect overlaps and write reports without changing the deck. |
| `safe` | The deck has strict branding, templates, or complex master layouts. | Move only obvious low-priority objects and keep placeholders mostly locked. |
| `balanced` | Default for most “遮挡、重叠、布局错乱” requests. | Move movable objects while locking titles, footers, backgrounds, and decorative lines. |
| `aggressive` | The user explicitly wants stronger automatic repair and accepts more layout movement. | Search more candidate positions and treat smaller overlaps as risks. |

## What the optimizer does

The optimizer parses every slide, builds rectangular bounding boxes for visible shapes, detects risky overlaps by intersection area, and chooses a movable low-priority shape for each collision. It locks likely backgrounds, titles, page headers, page footers, connectors, and very thin decorative lines. For movable objects, it tests nearby positions and grid positions, then applies the candidate that reduces remaining collision risk with the least movement.

| Object type | Default handling | Rationale |
| --- | --- | --- |
| Background images or full-slide blocks | Ignore or lock | These are normally intended to sit behind content. |
| Titles, page headers, page footers | Lock | Moving them can damage the slide hierarchy. |
| Text boxes | Move when needed | Text obstruction is usually the most visible problem. |
| Pictures | Move when needed | Screenshots or illustrations often collide with text and tables. |
| Tables and charts | Move conservatively | They carry structured information and should not be distorted. |
| Group shapes | Treat as one object; lock in `safe` mode | Internal group geometry may be fragile. |
| Connectors and thin lines | Skip | These often intentionally cross other elements. |

## Quality rules

Always preserve the original deck and never delete content. Use a new filename such as `原文件名_layout_optimized.pptx`. Always generate a report because a geometrically valid repair can still require human visual judgment. If the remaining-risk section lists important slide collisions, tell the user plainly which pages may still need manual redesign.

| Quality check | Required standard |
| --- | --- |
| File preservation | Original PPTX must remain unchanged. |
| Content integrity | No text, images, tables, charts, or pages should be removed. |
| Reportability | Deliver a Markdown report with summary, per-slide counts, actions, and remaining risks. |
| Conservative repair | Prefer small moves over major restructuring. |
| Transparency | Explain unresolved overlaps instead of pretending the deck is perfect. |

## Recommended commands

For a normal user request:

```bash
python /home/ubuntu/skills/pptx-layout-optimizer/scripts/optimize_pptx_layout.py /path/input.pptx \
  -o /path/input_layout_optimized.pptx \
  --report /path/input_layout_report.md \
  --json-report /path/input_layout_report.json \
  --mode balanced
```

For a branding-sensitive or executive deck:

```bash
python /home/ubuntu/skills/pptx-layout-optimizer/scripts/optimize_pptx_layout.py /path/input.pptx \
  -o /path/input_layout_safe.pptx \
  --report /path/input_layout_safe_report.md \
  --mode safe
```

For diagnosis before editing:

```bash
python /home/ubuntu/skills/pptx-layout-optimizer/scripts/optimize_pptx_layout.py /path/input.pptx \
  --report /path/input_layout_audit.md \
  --json-report /path/input_layout_audit.json \
  --mode audit
```

## When to avoid relying only on this skill

If the user wants a completely new visual style, a new slide deck, image-based slides, or content rewriting, use the relevant presentation design or slide generation workflow instead. If the deck contains severe crowding where there is no physical space left on a slide, the optimizer may reduce overlap but cannot guarantee a polished design; recommend splitting dense slides, reducing text, or rebuilding the affected pages.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Many remaining overlaps | Slide has too little free space or locked template elements. | Try `aggressive`, then manually redesign high-risk pages if needed. |
| A grouped block still overlaps | Group internals are not individually optimized. | Ungroup manually or rebuild that slide if precision is required. |
| A connector appears as overlap | Lines may intentionally cross objects. | Keep connector skipping enabled. |
| Visual result differs from report | PowerPoint rendering depends on fonts, effects, rotation, and master layouts. | Open the optimized PPTX visually before final delivery when possible. |

## References

[1]: https://python-pptx.readthedocs.io/en/latest/api/shapes.html "python-pptx Shapes API"
[2]: https://python-pptx.readthedocs.io/en/stable/dev/analysis/shp-pos-and-size.html "python-pptx Shape position and size"
