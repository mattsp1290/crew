#!/usr/bin/env python3
"""Temporary synthetic HTTP observer; never serves files or request contents."""

import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="New private evidence directory")
    parser.add_argument("--port", type=int, default=0, help="Loopback port; 0 selects a free port")
    args = parser.parse_args()
    os.umask(0o077)
    args.out.mkdir(mode=0o700)
    token = secrets.token_urlsafe(24)
    routes = {f"/{token}/{phase}": phase for phase in ("positive", "negative")}
    values = {phase: secrets.token_hex(24) for phase in routes.values()}
    counts = dict.fromkeys(values, 0)

    def save_counts():
        temporary = args.out / "counts.tmp"
        temporary.write_text(json.dumps(counts))
        temporary.replace(args.out / "counts.json")

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(5)
            super().setup()

        def log_message(self, *_args):
            pass

        def parse_request(self):
            valid = super().parse_request()
            self.canary_phase = None
            if valid:
                try:
                    self.canary_phase = routes.get(urlsplit(self.path).path)
                except ValueError:
                    pass
                if self.canary_phase is not None:
                    counts[self.canary_phase] += 1
                    save_counts()
                    method = self.command if self.command in ("GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH") else "other"
                    with (args.out / "hits.jsonl").open("a") as log:
                        log.write(json.dumps({"phase": self.canary_phase, "method": method, "time": time.time()}) + "\n")
            return valid

        def respond(self, include_body):
            phase = self.canary_phase
            if phase is None:
                self.send_error(404)
                return
            body = json.dumps({"phase": phase, "value": values[phase]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if include_body:
                self.wfile.write(body)

        def do_GET(self):
            self.respond(include_body=True)

        def do_HEAD(self):
            self.respond(include_body=False)

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    save_counts()
    readiness = {
        "host": "127.0.0.1", "port": server.server_port,
        "routes": {phase: path for path, phase in routes.items()},
        "expected": values,
    }
    ready_file = args.out / "ready.tmp"
    ready_file.write_text(json.dumps(readiness, indent=2))
    ready_file.replace(args.out / "ready.json")
    print(f"Synthetic canary ready; local configuration: {args.out / 'ready.json'}", flush=True)

    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
