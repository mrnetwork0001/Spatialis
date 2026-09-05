#!/usr/bin/env python3
"""
Tools/serve.py
------------------------------------------------------------------------------
Development server for the Spatialis landing page and simulator.

Replaces `python3 -m http.server`, which sends no Cache-Control header at all.
Browsers then apply heuristic caching to ES modules, so an edited file can keep
serving a stale copy - and a stale module presents as the app silently not
starting, which is indistinguishable from a real bug. Every response here is
no-store, so a reload always gets what is on disk.

Also sets the correct MIME type for .glb, which the stdlib does not know.

Usage: python3 Tools/serve.py [port]
License: Apache-2.0
"""

import functools
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self):
        # The whole point of this file.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quiet the per-request noise; keep failures.
        status = str(args[1]) if len(args) > 1 else ""
        if status.startswith(("4", "5")):
            sys.stderr.write("  %s %s\n" % (status, args[0]))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Spatialis  →  http://localhost:{PORT}/")
        print(f"app        →  http://localhost:{PORT}/Simulator/")
        print("cache disabled (no-store) - a reload always gets fresh files\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
