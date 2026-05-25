---
name: settlement-workflow
description: >
  结算文件完整处理工作流：先使用 settlement-excel-validator 检查 Excel 文件是否合格，
  如果合格则使用 excel-to-pptx 转换为 PPTX，最后询问是否使用 pptx-merge 合并所有 PPTX。
  触发词：结算工作流、完整处理、一键结算。
---

# 结算文件完整处理工作流

本 skill 串联三个现有 skill，完成从 Excel 检验到 PPT 生成与合并的完整流程。

## 工作流步骤

```
1. settlement-excel-validator → 检查 Excel 是否合格
   ↓ 合格
2. excel-to-pptx → 将 Excel 转换为 PPTX
   ↓ 转换完成
3. 询问用户是否合并 → 如果是
4. pptx-merge → 合并所有生成的 PPTX
```

## 环境变量

```bash
PYTHON=py  # Windows 环境使用 py 启动器
SETTLEMENT_VALIDATOR=skills/settlement-excel-validator/scripts
EXCEL_TO_PPTX=skills/excel-to-pptx/excel-to-pptx/scripts
PPTX_MERGE=skills/pptx-merge/scripts
```

## Step 1 — 检查 Excel 文件

使用 settlement-excel-validator 检查用户输入的 Excel 文件：

```bash
$PYTHON %SETTLEMENT_VALIDATOR%\validate_settlement_excel.py <input.xlsx> --out-dir <output_dir>
```

检查后读取 `validation_result.json` 判断是否合格：

| 字段 | 含义 |
| --- | --- |
| `qualified: true` | 文件合格，可继续流程 |
| `qualified: false` | 文件不合格，显示 `problems` 列表，不继续 |

向用户展示检查结果：
- 合格：说明文件符合标准，询问是否继续生成 PPTX
- 不合格：列出具体问题（必须修正的问题在前，建议确认的问题在后），询问用户是否要手动处理后再试

## Step 2 — Excel 转 PPTX

当用户确认继续时，使用 excel-to-pptx 转换：

```bash
$PYTHON %EXCEL_TO_PPTX%\read_excel.py <input.xlsx> -o /tmp/excel_data.json
```

按 excel-to-pptx skill 的完整流程执行，最终生成多个 PPTX 文件（每个明细 sheet 一个文件）。

## Step 3 — 询问是否合并

转换完成后，列出所有生成的 PPTX 文件，询问用户是否需要合并。

如果用户选择合并，使用 pptx-merge 将所有 PPTX 按顺序合并为一个文件：

```bash
$PYTHON %PPTX_MERGE%\merge_pptx.py <file1.pptx> <file2.pptx> ... -o <merged_output.pptx>
```

## 流程终止条件

- 用户在 Step 1 不合格后选择不修改 → 结束
- 用户在 Step 2 前选择不转换 → 结束
- 用户在 Step 3 选择不合并 → 结束
- 合并完成 → 结束

## 注意事项

- 本 skill 是编排层，不做实际的 Excel 解析、PPT 生成或合并逻辑
- 所有判断和用户交互通过 LLM/Agent 完成
- 临时文件建议放在 `/tmp` 或用户指定目录
- 合并时按文件名自然顺序排列 PPTX 文件