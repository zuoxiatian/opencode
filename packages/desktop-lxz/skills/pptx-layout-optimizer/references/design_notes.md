# PPTX Layout Optimizer 设计说明

本 skill 采用“几何审计 + 保守自动修复 + 报告追踪”的模式。核心资源为 `scripts/optimize_pptx_layout.py`，它读取用户提供的 `.pptx`，基于 python-pptx 解析每页 shape 的 `left/top/width/height`，建立矩形边界框，检测具有实际遮挡风险的重叠，并在不改变页面内容的前提下移动低优先级元素，输出优化后的 `.pptx` 与 Markdown/JSON 报告。

## 处理对象与优先级

| 对象类型 | 默认策略 | 说明 |
| --- | --- | --- |
| 背景大图或全页矩形 | 忽略或锁定 | 面积超过页面 80% 且位于底层时通常是背景，不作为遮挡冲突处理。 |
| 标题、页眉、页脚 | 锁定 | 优先保证页面结构稳定，不主动移动。 |
| 文本框、图片、表格、图表 | 可移动 | 作为主要优化对象，通过候选位置搜索减少遮挡。 |
| 组合形状、连接线、细线装饰 | 保守处理 | 组合形状只按整体矩形处理；连接线和极细装饰通常跳过。 |

## 核心算法

| 阶段 | 方法 |
| --- | --- |
| 解析 | 对每张幻灯片收集可定位 shape，记录 z-order、名称、类型、文本摘要、矩形框和面积。 |
| 审计 | 计算两两矩形相交面积；当交叠面积超过较小元素面积的阈值时记为风险；背景、装饰线、预期覆盖层会被过滤。 |
| 修复 | 针对每个冲突选择低优先级、可移动且未锁定的 shape，生成向下、向上、向右、向左以及网格候选位置。 |
| 评分 | 候选位置必须在安全边距内，并以“剩余冲突面积、移动距离、是否越界”为综合评分。 |
| 输出 | 保存优化后的 PPTX；生成报告列出每页检测到的冲突、修复动作、未修复原因和整体风险级别。 |

## 脚本接口

```bash
python /home/ubuntu/skills/pptx-layout-optimizer/scripts/optimize_pptx_layout.py input.pptx \
  -o output_optimized.pptx \
  --report output_layout_report.md \
  --json-report output_layout_report.json \
  --mode balanced
```

可选模式包括 `audit`、`safe`、`balanced` 和 `aggressive`。`audit` 只生成报告不修改文件；`safe` 只移动明显低优先级元素；`balanced` 为默认模式；`aggressive` 可移动更多元素，但仍不删除任何内容。

## 使用边界

此工具解决的是几何遮挡和元素重叠，不负责重新设计整套 PPT 的视觉风格。它不会删除内容，不会改写文案，也不会主动重建复杂表格。如果用户要求彻底重新排版、改设计风格或生成新演示稿，应结合其他 PPT 设计流程，而不是只运行本脚本。
