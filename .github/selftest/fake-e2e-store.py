"""A stand-in monitoring-api results store for the self-test: POST /.

`ok` answers 200 with `{"inserted": len(results)}`, reading the real body so
the self-test can assert the row count that actually arrived. `deny` answers
a JSON 403 — a transport/auth failure the action must WARN on, never fail the
caller's job over.
"""
import http.server
import json
import sys

MODE, PORT = sys.argv[1], int(sys.argv[2])


class Store(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        if MODE == 'ok':
            code, resp = 200, {'inserted': len(body.get('results', []))}
        else:
            code, resp = 403, {'error': 'forbidden'}
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())

    def do_GET(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


http.server.HTTPServer(('127.0.0.1', PORT), Store).serve_forever()
