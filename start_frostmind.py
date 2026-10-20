"""
Start the whole FROSTMIND stack on THIS machine, whatever network it's on -- nothing is tied to a
fixed IP address, so the same command works on a desktop today and a laptop tomorrow.

    .venv\\Scripts\\python.exe start_frostmind.py

What it does, every launch:
  1. Detects this machine's current LAN IPv4 address(es).
  2. Generates a fresh self-signed HTTPS certificate covering those addresses + localhost
     (phone-bridge/.certs/). The phone needs HTTPS for Web Bluetooth, and a certificate made for
     an old address would trip the browser, so it's simply re-made each time (takes a second).
  3. Starts:
       - backend  https://<LAN-IP>:8000   for the phone (HTTPS, so the HTTPS phone page can call it)
       - backend  http://localhost:8001   for the admin panel on this machine (no cert prompts)
       - phone app https://<LAN-IP>:5500  (phone-bridge/, static files over HTTPS)
       - admin panel http://localhost:3000 (web/, Next.js dev server -- skipped if not installed)
  4. Prints the addresses to open, then streams every server's log here. Ctrl+C stops everything.

The phone app works out the backend address from the address you opened it at
(phone-bridge/js/config.js), so there is nothing to type on the phone.
"""
from __future__ import annotations

import datetime as dt
import ipaddress
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CERT_DIR = ROOT / "phone-bridge" / ".certs"
PY = sys.executable


def lan_ips() -> list[str]:
    ips: set[str] = set()
    try:  # the address the OS would use to reach the internet = the "main" LAN address
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127.") and not ip.startswith("169.254."))


def cert_still_valid(ips: list[str]) -> bool:
    """Keep the existing certificate when it already covers this machine's current addresses and
    isn't close to expiry -- regenerating on every launch would make phones that already tapped
    "Proceed" hit the certificate warning (and failed API calls) again after each restart."""
    from cryptography import x509

    path = CERT_DIR / "cert.pem"
    if not path.exists() or not (CERT_DIR / "key.pem").exists():
        return False
    try:
        cert = x509.load_pem_x509_certificate(path.read_bytes())
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        covered = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
        fresh = cert.not_valid_after_utc - dt.datetime.now(dt.timezone.utc) > dt.timedelta(days=30)
        return fresh and set(ips) <= covered
    except Exception:  # noqa: BLE001 - unreadable cert: just make a new one
        return False


def make_cert(ips: list[str]) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    CERT_DIR.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "frostmind-dev")])
    sans = [x509.DNSName("localhost"), x509.DNSName(socket.gethostname()), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    sans += [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .sign(key, hashes.SHA256())
    )
    (CERT_DIR / "key.pem").write_bytes(
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption())
    )
    (CERT_DIR / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def stream(name: str, proc: subprocess.Popen) -> None:
    for line in iter(proc.stdout.readline, ""):
        print(f"[{name}] {line.rstrip()}", flush=True)


def main() -> None:
    ips = lan_ips()
    if cert_still_valid(ips):
        print("HTTPS certificate: reusing the existing one (already covers this machine's address).")
    else:
        make_cert(ips)
        print("HTTPS certificate: generated a new one for " + ", ".join(ips or ["localhost"]) + " -- accept it once on the phone.")
    cert, key = str(CERT_DIR / "cert.pem"), str(CERT_DIR / "key.pem")

    services: list[tuple[str, list[str], Path]] = [
        ("backend-phone", [PY, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000",
                           "--ssl-keyfile", key, "--ssl-certfile", cert], ROOT / "backend"),
        # plain HTTP for the admin panel; on all interfaces so the panel also works when opened
        # from another device on the network (http://<LAN-IP>:3000)
        ("backend-admin", [PY, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"], ROOT / "backend"),
        ("phone-app", [PY, "serve_https.py", "5500"], ROOT / "phone-bridge"),
    ]
    npm = shutil.which("npm")
    if npm and (ROOT / "web" / "node_modules").exists():
        services.append(("admin-panel", [npm, "run", "dev"], ROOT / "web"))
    else:
        print("(admin panel skipped: run `npm install` in web/ first)")

    procs: list[subprocess.Popen] = []
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    for name, cmd, cwd in services:
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             encoding="utf-8", errors="replace")
        procs.append(p)
        threading.Thread(target=stream, args=(name, p), daemon=True).start()

    time.sleep(4)
    bar = "=" * 68
    print(f"\n{bar}\n FROSTMIND is running on this machine\n{bar}")
    if ips:
        for ip in ips:
            print(f" PHONE  (same Wi-Fi):  1) open https://{ip}:8000/health  -> Advanced -> Proceed")
            print(f"                       2) open https://{ip}:5500         -> Advanced -> Proceed")
    else:
        print(" No network address found -- connect this machine to Wi-Fi/LAN and restart.")
    print(" ADMIN  (this machine): http://localhost:3000   (admin@frostmind.local / frostmind-admin)")
    for ip in ips:
        print(f" ADMIN  (other devices): http://{ip}:3000")
    print(" API docs:              http://localhost:8001/docs")
    print(f" Ctrl+C stops everything.\n{bar}\n", flush=True)

    try:
        while all(p.poll() is None for p in procs):
            time.sleep(1)
        for p, (name, _, _) in zip(procs, services):
            if p.poll() is not None:
                print(f"\n!! {name} exited (code {p.returncode}) -- see its log above. Stopping the rest.")
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        for p in procs:
            if p.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
                else:
                    p.send_signal(signal.SIGINT)
        print("All FROSTMIND servers stopped.")


if __name__ == "__main__":
    main()
