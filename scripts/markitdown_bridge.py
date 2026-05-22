from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlparse


def write_stdout(text: str) -> None:
    sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


def write_stderr(text: str) -> None:
    sys.stderr.buffer.write(f"{text}\n".encode("utf-8", errors="replace"))
    sys.stderr.buffer.flush()


def convert_with_markitdown(source: str, *, is_url: bool) -> str:
    configure_ffmpeg()

    from markitdown import MarkItDown

    converter = MarkItDown(enable_plugins=False)
    if not is_url and hasattr(converter, "convert_local"):
        result = converter.convert_local(source)
    else:
        result = converter.convert(source)
    return getattr(result, "text_content", "") or ""


def configure_ffmpeg() -> None:
    ffmpeg_path = os.environ.get("MYWIKI_FFMPEG_PATH", "").strip()
    if not ffmpeg_path:
        return
    path = Path(ffmpeg_path)
    if not path.exists() or not path.is_file():
        raise RuntimeError(f"Configured ffmpeg executable does not exist: {path}")

    current_path = os.environ.get("PATH", "")
    ffmpeg_dir = str(path.parent)
    os.environ["PATH"] = ffmpeg_dir if not current_path else f"{ffmpeg_dir}{os.pathsep}{current_path}"

    try:
        from pydub import AudioSegment

        AudioSegment.converter = str(path)
        AudioSegment.ffmpeg = str(path)
        probe = path.with_name("ffprobe.exe" if path.suffix.lower() == ".exe" else "ffprobe")
        if probe.exists() and probe.is_file():
            AudioSegment.ffprobe = str(probe)
    except ImportError:
        return


def is_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert local files or HTTP(S) URLs to Markdown for MyWiki.")
    parser.add_argument("source", nargs="?", help="Local file path or HTTP(S) URL to convert.")
    parser.add_argument("--url", dest="url", help="HTTP(S) URL to convert.")
    args = parser.parse_args()

    source = (args.url or args.source or "").strip()
    if not source:
        write_stderr("A local file path or --url is required.")
        return 2

    is_url = bool(args.url) or is_http_url(source)
    if is_url:
        if not is_http_url(source):
            write_stderr(f"Only HTTP(S) URLs are supported: {source}")
            return 2
    else:
        path = Path(source)
        if not path.exists() or not path.is_file():
            write_stderr(f"File does not exist: {path}")
            return 2
        source = str(path)

    try:
        text = convert_with_markitdown(source, is_url=is_url)
    except Exception as error:
        write_stderr(str(error))
        return 1

    write_stdout(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
