"""Serves phone-bridge/ over HTTPS on 0.0.0.0:5500 with a self-signed cert.

Why this exists: Web Bluetooth (and other powerful browser APIs) only work in a "secure
context" -- HTTPS, or http://localhost specifically. Serving this app over plain HTTP to a LAN
IP (http://192.168.x.x:5500, needed so a phone on the same Wi-Fi can reach a dev machine) is NOT
a secure context, so navigator.bluetooth is simply undefined there -- not a browser-support
issue, a transport issue. This wraps the same static file serving in TLS so it qualifies.

The cert in .certs/ is self-signed (see .certs/README or the openssl command used to generate
it) -- your browser WILL show an untrusted-certificate warning. That's expected for a
self-signed dev cert, not a sign anything is broken: tap through it once ("Advanced" ->
"Proceed" / "visit this site" -- exact wording varies by browser).

Usage: python serve_https.py [port]  (default 5500)
"""
import http.server
import os
import ssl
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(DIRECTORY, ".certs")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)


def main():
    cert_path = os.path.join(CERT_DIR, "cert.pem")
    key_path = os.path.join(CERT_DIR, "key.pem")
    if not (os.path.exists(cert_path) and os.path.exists(key_path)):
        print(f"Missing cert/key in {CERT_DIR} -- generate them first, e.g.:")
        print(
            '  openssl req -x509 -newkey rsa:2048 -keyout .certs/key.pem -out .certs/cert.pem '
            '-days 365 -nodes -subj "/CN=frostmind-dev" '
            '-addext "subjectAltName=IP:<your-LAN-IP>,IP:127.0.0.1,DNS:localhost"'
        )
        sys.exit(1)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)

    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"Serving {DIRECTORY} over HTTPS on 0.0.0.0:{PORT}")
    print("Self-signed cert -- your browser will warn once, tap through it (expected).")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
