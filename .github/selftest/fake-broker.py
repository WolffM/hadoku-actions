"""A stand-in vault broker for the self-test: GET /api/secrets/get/<name>.

`ok` answers 200 with a fixed value; `deny` answers a JSON 403 — the broker
saying NO, which fetch.sh must never paper over with its fallback.
"""
import http.server
import json
import sys

MODE, PORT = sys.argv[1], int(sys.argv[2])


class Broker(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        code, body = (200, {'value': 'tok-from-vault'}) if MODE == 'ok' else (403, {'error': 'acl denied'})
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, *args):
        pass


http.server.HTTPServer(('127.0.0.1', PORT), Broker).serve_forever()
