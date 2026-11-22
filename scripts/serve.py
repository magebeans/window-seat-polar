"""Dev server for web/ on http://localhost:8080 (service workers need localhost or https).

Sends no-cache headers so you always test what the service worker cached, not the HTTP cache.
Deliberately does NOT support Range requests: the app must never need them from the server.
"""
import functools
import http.server
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".webmanifest": "application/manifest+json",
                      ".pbf": "application/x-protobuf", ".bin": "application/octet-stream"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "--quiet" not in sys.argv:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(next((a for a in sys.argv[1:] if a.isdigit()), 8080))
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(WEB))).serve_forever()
