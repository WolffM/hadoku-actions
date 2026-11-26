"""A stand-in monitoring-api e2e store for the self-test.

`ok` answers a POST to .../results with `{"inserted": len(results)}` and a POST
to .../runs with `{"id": ...}`, reading the real body (gunzipped when it says
`Content-Encoding: gzip`, as monitoring-api does), and appends every body it
received, with its encoding, to /tmp/fake-e2e-store-<port>.jsonl so the
self-test can assert what actually arrived. GET .../runs/last-green answers with the sha in the
LAST_GREEN_SHA env var (null when unset). `deny` answers a JSON 403 to every
POST. `hang` reads a POST and never answers, the way the live store did on
2026-10-29 (hadoku-actions#4).
"""
import http.server
import gzip
import json
import os
import sys
import time

MODE, PORT = sys.argv[1], int(sys.argv[2])
LOG = f'/tmp/fake-e2e-store-{PORT}.jsonl'


class Store(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b''
        encoding = self.headers.get('Content-Encoding') or 'identity'
        if encoding == 'gzip':
            raw = gzip.decompress(raw)
        body = json.loads(raw) if raw else {}
        if MODE == 'hang':
            time.sleep(3600)
            return
        if MODE != 'ok':
            self._send(403, {'error': 'forbidden'})
            return
        with open(LOG, 'a') as f:
            f.write(json.dumps({'path': self.path, 'encoding': encoding, 'body': body}) + '\n')
        if self.path.rstrip('/').endswith('/runs'):
            self._send(200, {'id': f"{body.get('gh_run_id')}:{body.get('run_attempt')}:{body.get('app')}"})
        else:
            self._send(200, {'inserted': len(body.get('results', []))})

    def do_GET(self):
        if '/runs/last-green' in self.path:
            sha = os.environ.get('LAST_GREEN_SHA') or None
            self._send(200, {'run': {'head_sha': sha} if sha else None})
            return
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


http.server.HTTPServer(('127.0.0.1', PORT), Store).serve_forever()
