#!/usr/bin/env python3
"""Chrome native messaging host for Canvas Local Archive.

PDF conversion (one per connection) with LibreOffice:
  in:  {"name": "Slides.pptx"}, {"data": "<base64>"}..., {"end": true}
  out: {"data": "<base64>"}..., {"done": true}  or  {"error": "..."}

Theme (the Stylix palette Nix wrote to $CANVAS_ARCHIVE_THEME, or null):
  in:  {"theme": true}
  out: {"theme": {"colors": {"base00": "191724", ...}, "fonts": {...}, "polarity": "dark"} | null}
"""
import base64
import json
import os
import pathlib
import re
import struct
import subprocess
import sys
import tempfile

ALLOWED = re.compile(r"\.(docx?|odt|rtf|pptx?|ppsx?|odp)$", re.I)
MAX_INPUT = 1 << 30
OUT_CHUNK = 700_000  # base64 stays under Chrome's 1 MiB host-to-browser message limit
THEME_KEYS = [f"base0{digit}" for digit in "0123456789ABCDEF"]


def read():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        raise EOFError
    (size,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(size))


def send(message):
    data = json.dumps(message).encode()
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


def theme():
    path = os.environ.get("CANVAS_ARCHIVE_THEME")
    if not path:
        return None
    try:
        data = json.loads(pathlib.Path(path).read_text())
        colors = {key: str(data["colors"][key]).lstrip("#") for key in THEME_KEYS}
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not all(re.fullmatch(r"[0-9a-fA-F]{6}", value) for value in colors.values()):
        return None
    fonts = {key: value for key, value in (data.get("fonts") or {}).items() if isinstance(value, str)}
    return {"colors": colors, "fonts": fonts, "polarity": data.get("polarity")}


def convert(work, first):
    match = ALLOWED.search(str(first.get("name", "")))
    if not match:
        raise ValueError("unsupported file type")
    source = work / ("input" + match.group(0).lower())
    total = 0
    with source.open("wb") as file:
        while not (message := read()).get("end"):
            chunk = base64.b64decode(message["data"], validate=True)
            total += len(chunk)
            if total > MAX_INPUT:
                raise ValueError("file is larger than 1 GiB")
            file.write(chunk)
    # Private profile per run: concurrent soffice calls sharing one profile fail silently.
    # soffice output must never reach stdout, which carries the protocol.
    subprocess.run(
        ["soffice", f"-env:UserInstallation={(work / 'profile').as_uri()}", "--headless", "--norestore",
         "--convert-to", "pdf", "--outdir", str(work), str(source)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600, check=True,
    )
    pdf = work / "input.pdf"
    if not pdf.is_file() or pdf.stat().st_size == 0:
        raise ValueError("LibreOffice produced no PDF")
    with pdf.open("rb") as file:
        while chunk := file.read(OUT_CHUNK):
            send({"data": base64.b64encode(chunk).decode()})
    send({"done": True})


def main():
    with tempfile.TemporaryDirectory(prefix="canvas-pdf-") as work:
        try:
            first = read()
            if first.get("theme"):
                send({"theme": theme()})
            else:
                convert(pathlib.Path(work), first)
        except EOFError:
            pass
        except FileNotFoundError:
            send({"error": "LibreOffice (soffice) is not installed"})
        except subprocess.TimeoutExpired:
            send({"error": "LibreOffice timed out after 10 minutes"})
        except subprocess.CalledProcessError:
            send({"error": "LibreOffice could not convert this file"})
        except Exception as error:  # report, never crash silently
            send({"error": str(error) or type(error).__name__})


if __name__ == "__main__":
    main()
