from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Convert a document to Markdown with MarkItDown.")
    parser.add_argument("input", help="Document path to convert")
    parser.add_argument("-o", "--output", help="Markdown output path. Prints to stdout when omitted.")
    args = parser.parse_args()

    from markitdown import MarkItDown

    result = MarkItDown().convert(args.input).text_content
    if args.output:
        Path(args.output).write_text(result, encoding="utf-8")
        return 0

    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
