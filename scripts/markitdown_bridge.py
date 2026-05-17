from __future__ import annotations

import argparse
import sys
from pathlib import Path


def write_stdout(text: str) -> None:
    sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


def write_stderr(text: str) -> None:
    sys.stderr.buffer.write(f"{text}\n".encode("utf-8", errors="replace"))
    sys.stderr.buffer.flush()


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
        write_stderr(f"File does not exist: {path}")
        return 2

    try:
        text = convert_file(path)
    except Exception as error:
        write_stderr(str(error))
        return 1

    write_stdout(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
