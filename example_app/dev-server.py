#!/usr/bin/env python3
"""
Local development server for McGheeLab standalone apps.

Usage:
    python3 dev-server.py            # Serves on port 8001
    python3 dev-server.py 8080       # Custom port

Opens your browser automatically. Ctrl+C to stop.
"""

import http.server
import os
import sys
import webbrowser
from functools import partial

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
DIR = os.path.dirname(os.path.abspath(__file__))

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    """Adds CORS headers so Firebase SDK works locally."""

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def log_message(self, format, *args):
        # Quieter logging — only show errors and page loads (not every asset)
        path = args[0].split()[1] if args else ''
        if path.endswith(('.html', '/')) or '40' in str(args[1] if len(args) > 1 else ''):
            super().log_message(format, *args)

handler = partial(CORSHandler, directory=DIR)

print(f'\n  McGheeLab App Dev Server')
print(f'  http://localhost:{PORT}')
print(f'  Serving from: {DIR}')
print(f'  Press Ctrl+C to stop\n')

webbrowser.open(f'http://localhost:{PORT}')

try:
    with http.server.HTTPServer(('', PORT), handler) as server:
        server.serve_forever()
except KeyboardInterrupt:
    print('\n  Server stopped.')
