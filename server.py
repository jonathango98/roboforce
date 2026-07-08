#!/usr/bin/env python3
"""RF Admin server: serves the static pages and a small key-value storage API.

Data lives as one pretty-printed JSON file per key in ./data/ — human-readable,
easy to back up, and deletable individually. No dependencies beyond stdlib.

API (all same-origin, used by storage.js):
  GET    /api/storage        -> {"<key>": "<raw stored string>", ...}
  PUT    /api/storage/<key>  -> body is the raw value string; writes data/<key>.json
  DELETE /api/storage/<key>  -> removes data/<key>.json
"""
import json
import re
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
PORT = 8080

# Keys mirror the old localStorage keys, e.g. "shift-report:2026-07-08".
KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _storage_key(self):
        key = urllib.parse.unquote(self.path[len("/api/storage/"):])
        if KEY_RE.match(key) and ".." not in key:
            return key
        return None

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/api/storage":
            data = {}
            if DATA_DIR.is_dir():
                for f in sorted(DATA_DIR.glob("*.json")):
                    data[f.stem] = f.read_text(encoding="utf-8")
            return self._send_json(data)
        if self.path.startswith("/api/storage/"):
            key = self._storage_key()
            f = DATA_DIR / f"{key}.json" if key else None
            if not f or not f.is_file():
                return self._send_json({"error": "not found"}, 404)
            return self._send_json({"key": key, "value": f.read_text(encoding="utf-8")})
        super().do_GET()

    def do_PUT(self):
        if not self.path.startswith("/api/storage/"):
            return self._send_json({"error": "not found"}, 404)
        key = self._storage_key()
        if not key:
            return self._send_json({"error": "invalid key"}, 400)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8")
        try:
            # Pretty-print valid JSON so the files are pleasant to read/edit.
            text = json.dumps(json.loads(raw), indent=2, ensure_ascii=False)
        except ValueError:
            text = raw
        DATA_DIR.mkdir(exist_ok=True)
        target = DATA_DIR / f"{key}.json"
        tmp = DATA_DIR / f"{key}.json.tmp"
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(target)  # atomic swap so a crash never leaves a torn file
        self._send_json({"ok": True})

    def do_DELETE(self):
        if not self.path.startswith("/api/storage/"):
            return self._send_json({"error": "not found"}, 404)
        key = self._storage_key()
        if not key:
            return self._send_json({"error": "invalid key"}, 400)
        (DATA_DIR / f"{key}.json").unlink(missing_ok=True)
        self._send_json({"ok": True})

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet; errors still surface via tracebacks


if __name__ == "__main__":
    DATA_DIR.mkdir(exist_ok=True)
    print(f"Serving {ROOT} on http://localhost:{PORT} (data in {DATA_DIR})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
