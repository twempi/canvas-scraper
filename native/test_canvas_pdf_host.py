"""Run: python3 -I native/test_canvas_pdf_host.py  (uses the real soffice on PATH)."""
import base64
import json
import pathlib
import struct
import subprocess
import sys

HOST = pathlib.Path(__file__).with_name("canvas_pdf_host.py")


def frame(message):
    data = json.dumps(message).encode()
    return struct.pack("=I", len(data)) + data


def run(name, payload):
    stdin = frame({"name": name}) + frame({"data": base64.b64encode(payload).decode()}) + frame({"end": True})
    out = subprocess.run([sys.executable, "-I", str(HOST)], input=stdin, capture_output=True, timeout=180, check=True).stdout
    messages = []
    while out:
        (size,) = struct.unpack("=I", out[:4])
        messages.append(json.loads(out[4:4 + size]))
        out = out[4 + size:]
    return messages


replies = run("Notes.rtf", rb"{\rtf1\ansi Hello from Canvas}")
assert replies[-1] == {"done": True}, replies
pdf = b"".join(base64.b64decode(m["data"]) for m in replies[:-1])
assert pdf.startswith(b"%PDF-"), pdf[:20]
assert run("script.sh", b"echo hi") == [{"error": "unsupported file type"}]


def ask_theme(env):
    out = subprocess.run([sys.executable, "-I", str(HOST)], input=frame({"theme": True}), capture_output=True, timeout=30, check=True, env=env).stdout
    (size,) = struct.unpack("=I", out[:4])
    return json.loads(out[4:4 + size])


import os
import tempfile

palette = {f"base0{d}": "#191724" if d == "0" else "e0def4" for d in "0123456789ABCDEF"}
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as theme_file:
    json.dump({"colors": palette, "fonts": {"sansSerif": "Iosevka", "bad": 3}, "polarity": "dark"}, theme_file)
reply = ask_theme({"CANVAS_ARCHIVE_THEME": theme_file.name})["theme"]
assert reply["colors"]["base00"] == "191724" and reply["fonts"] == {"sansSerif": "Iosevka"}, reply
assert ask_theme({}) == {"theme": None}
with open(theme_file.name, "w") as handle:
    json.dump({"colors": {**palette, "base08": "nope"}}, handle)
assert ask_theme({"CANVAS_ARCHIVE_THEME": theme_file.name}) == {"theme": None}
os.unlink(theme_file.name)
print("ok: theme reply")
print(f"ok: {len(pdf)} byte PDF")
