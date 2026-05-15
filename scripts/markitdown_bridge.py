from __future__ import annotations

import argparse
import sys
from pathlib import Path


def convert_file(path: Path) -> str:
    from markitdown import MarkItDown

    converter = MarkItDown(enable_plugins=False)
    if hasattr(converter, "convert_local"):
        result = converter.convert_local(str(path))
    else:
        result = converter.convert(str(path))
    return getattr(result, "text_content", "") or ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert local files to Markdown for MyWiki.")
    parser.add_argument("path", help="Local file path to convert.")
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists() or not path.is_file():
        print(f"File does not exist: {path}", file=sys.stderr)
        return 2

    try:
        text = convert_file(path)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1

    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
