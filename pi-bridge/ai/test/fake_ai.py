"""Fake AI service for end-to-end tests of the alert/pause logic: reports a clean print for the
first FAKE_GOOD calls, then strong "spaghetti" detections."""
import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
GOOD = int(os.environ.get("FAKE_GOOD", "32"))
calls = 0
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, o):
        b = json.dumps(o).encode(); self.send_response(200)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self): self._send({"ready": True, "model": "fake", "backend": "fake", "avg_ms": 1, "error": ""})
    def do_POST(self):
        global calls
        self.rfile.read(int(self.headers.get("Content-Length") or 0)); calls += 1
        d = [["failure", 0.05, [100, 100, 50, 50]]] if calls <= GOOD else [["failure", 0.9, [100, 100, 80, 80]], ["failure", 0.8, [300, 200, 60, 60]], ["failure", 0.7, [400, 120, 40, 40]], ["failure", 0.6, [200, 250, 50, 50]]]
        self._send({"detections": d, "width": 640, "height": 360, "ms": 1})
ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("FFAI_PORT", "3333"))), H).serve_forever()
