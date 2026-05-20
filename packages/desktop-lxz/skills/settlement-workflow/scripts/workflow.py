#!/usr/bin/env python3
"""
结算文件完整处理工作流编排脚本
串联 settlement-excel-validator → excel-to-pptx → pptx-merge
"""

import os
import sys
import json
import subprocess
import argparse

PYTHON = "py"
VALIDATOR_SCRIPT = r"C:\Users\27401\.lxz\skills\settlement-excel-validator\scripts\validate_settlement_excel.py"
EXCEL_TO_PPTX_SCRIPTS = r"C:\Users\27401\.lxz\skills\excel-to-pptx\excel-to-pptx\scripts"
MERGE_SCRIPT = r"C:\Users\27401\.lxz\skills\pptx-merge\scripts\merge_pptx.py"


def run_command(cmd, description):
    """执行命令并返回结果"""
    print(f"\n{'='*50}")
    print(f"{description}")
    print(f"命令: {' '.join(cmd)}")
    print(f"{'='*50}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    print(result.stdout)
    if result.stderr:
        print(result.stderr)
    return result.returncode == 0, result.stdout, result.stderr


def check_excel(input_file, output_dir):
    """Step 1: 检查 Excel 文件是否合格"""
    cmd = [PYTHON, VALIDATOR_SCRIPT, input_file, "--out-dir", output_dir]
    success, stdout, stderr = run_command(cmd, "Step 1: 检查 Excel 文件")

    result_file = os.path.join(output_dir, "validation_result.json")
    if os.path.exists(result_file):
        with open(result_file, 'r', encoding='utf-8') as f:
            result = json.load(f)
        return result
    return None


def excel_to_pptx(input_file):
    """Step 2: Excel 转 PPTX（调用 excel-to-pptx skill 的完整流程）"""
    print("\n" + "="*50)
    print("Step 2: Excel 转 PPTX")
    print("请按照 excel-to-pptx skill 的流程手动执行以下步骤：")
    print("1. 解析 Excel: read_excel.py")
    print("2. 过滤列: filter_columns.py")
    print("3. 布局规划: layout_engine.py")
    print("4. 生成 PPTX: build_pptx.py")
    print("="*50)
    return True


def merge_pptx(input_files, output_file):
    """Step 3: 合并 PPTX"""
    cmd = [PYTHON, MERGE_SCRIPT] + input_files + ["-o", output_file]
    success, stdout, stderr = run_command(cmd, "Step 3: 合并 PPTX")
    return success


def main():
    parser = argparse.ArgumentParser(description="结算文件完整处理工作流")
    parser.add_argument("input", help="输入的 Excel 文件路径")
    parser.add_argument("--check-only", action="store_true", help="仅检查，不转换")
    parser.add_argument("--convert-only", action="store_true", help="仅转换，不合并")
    args = parser.parse_args()

    input_file = args.input
    output_dir = os.path.join(os.path.dirname(input_file), "validation_output")

    if not os.path.exists(input_file):
        print(f"错误: 文件不存在: {input_file}")
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    print(f"输入文件: {input_file}")
    print(f"检查输出目录: {output_dir}")

    result = check_excel(input_file, output_dir)

    if not result:
        print("错误: 无法获取检查结果")
        sys.exit(1)

    if not result.get("qualified", False):
        print("\n检查结果: 文件不合格")
        print("\n问题列表:")
        for problem in result.get("problems", []):
            print(f"  - [{problem.get('severity', 'unknown')}] {problem.get('message', '')}")
        print("\n请处理后重新提交。")
        sys.exit(0)

    print("\n检查结果: 文件合格")
    print("\n是否继续转换为 PPTX？请回复 '是' 或 '否'。")
    continue_convert = input("> ").strip().lower()

    if continue_convert not in ('是', 'yes', 'y', '继续'):
        print("流程已取消。")
        sys.exit(0)

    excel_to_pptx(input_file)

    if args.check_only or args.convert_only:
        print("流程结束。")
        sys.exit(0)

    print("\n是否合并所有生成的 PPTX 文件？请回复 '是' 或 '否'。")
    continue_merge = input("> ").strip().lower()

    if continue_merge not in ('是', 'yes', 'y', '继续'):
        print("流程结束。")
        sys.exit(0)

    pptx_files = [f for f in os.listdir(os.path.dirname(input_file)) if f.endswith('.pptx')]
    if not pptx_files:
        print("未找到生成的 PPTX 文件。")
        sys.exit(1)

    output_file = os.path.join(os.path.dirname(input_file), "merged_output.pptx")
    merge_pptx(pptx_files, output_file)
    print(f"合并完成: {output_file}")


if __name__ == "__main__":
    main()
