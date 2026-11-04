#!/usr/bin/env python3
"""BotCamp sandbox control plane.

Owns the lease lifecycle for per-user execution sandboxes and proxies
`/u/<user_id>/...` to the leased pod. Only the Kubernetes backend is
implemented here (TKE standard cluster + super node); the interface is
kept narrow so a docker backend can be added without touching callers.

API (Bearer SANDBOX_TOKEN):
  POST   /leases              {user_id, session_id, profile?}
  GET    /leases/{id}
  POST   /leases/{id}/extend  {seconds}
  DELETE /leases/{id}
  GET    /healthz
  *      /u/<user_id>/<rest>  reverse proxy to the lease's pod
"""
import http.client
import json
import os
import re
import secrets
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("SANDBOX_PORT", "8791"))
TOKEN = os.environ.get("SANDBOX_TOKEN", "")
DB_PATH = os.environ.get("SANDBOX_DB", "/var/lib/botcamp-sandbox/leases.db")

K8S_API = os.environ.get("K8S_API", "https://10.0.1.13")
K8S_CA = os.environ.get("K8S_CA", "/root/.kube/pki/ca.crt")
K8S_CERT = os.environ.get("K8S_CERT", "/root/.kube/pki/client.crt")
K8S_KEY = os.environ.get("K8S_KEY", "/root/.kube/pki/client.key")
NS = os.environ.get("SANDBOX_NS", "botcamp")
IMAGE = os.environ.get("SANDBOX_IMAGE", "ccr.ccs.tencentyun.com/botcamp/sandbox:dev")
PULL_SECRET = os.environ.get("SANDBOX_PULL_SECRET", "tcr-cred")
CFS_IP = os.environ.get("SANDBOX_CFS_IP", "10.0.4.2")
POD_PORT = int(os.environ.get("SANDBOX_POD_PORT", "8765"))

TTL = int(os.environ.get("SANDBOX_TTL", "600"))
EXTEND = int(os.environ.get("SANDBOX_EXTEND", "120"))
MAX_TTL = int(os.environ.get("SANDBOX_MAX_TTL", "7200"))
MAX_PER_USER = int(os.environ.get("SANDBOX_MAX_PER_USER", "1"))
MAX_TOTAL = int(os.environ.get("SANDBOX_MAX_TOTAL", "40"))
DRAIN_GRACE = int(os.environ.get("SANDBOX_DRAIN_GRACE", "30"))
POD_TIMEOUT = int(os.environ.get("SANDBOX_POD_TIMEOUT", "300"))

PROFILES = {
    "small": ("500m", "1Gi"),
    "std": ("1", "2Gi"),
    "big": ("2", "4Gi"),
}

DB_LOCK = threading.Lock()
RE_LEASE = re.compile(r"^/leases/([A-Za-z0-9_-]{8,64})(/extend)?$")
RE_USER = re.compile(r"^/u/([A-Za-z0-9_.-]{1,64})(/.*)?$")


def now():
    return int(time.time())


def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    directory = os.path.dirname(DB_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS leases (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                profile TEXT NOT NULL,
                state TEXT NOT NULL,
                pod_name TEXT,
                pod_ip TEXT,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_used_at INTEGER NOT NULL
            )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_leases_user ON leases(user_id, state)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_leases_state ON leases(state, expires_at)")


def lease_row(lease_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM leases WHERE id=?", (lease_id,)).fetchone()
    return dict(row) if row else None


def lease_for_user(user_id):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM leases WHERE user_id=? AND state='running' ORDER BY created_at DESC LIMIT 1",
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def json_bytes(obj):
    return json.dumps(obj, separators=(",", ":")).encode()


class BackendError(RuntimeError):
    pass


class K8sBackend:
    def __init__(self):
        self.ctx = ssl.create_default_context(cafile=K8S_CA)
        self.ctx.load_cert_chain(K8S_CERT, K8S_KEY)

    def _call(self, method, path, body=None, timeout=30):
        url = K8S_API.rstrip("/") + path
        data = json_bytes(body) if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise BackendError("%s %s -> %s %s" % (method, path, exc.code, detail))

    def start(self, lease):
        cpu, mem = PROFILES.get(lease["profile"], PROFILES["std"])
        name = "sbx-" + lease["id"][:12].lower()
        pod = {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": name,
                "namespace": NS,
                "labels": {"app": "botcamp-sandbox", "botcamp/lease": lease["id"]},
            },
            "spec": {
                "restartPolicy": "Never",
                "terminationGracePeriodSeconds": DRAIN_GRACE,
                "enableServiceLinks": False,
                "imagePullSecrets": [{"name": PULL_SECRET}],
                "containers": [{
                    "name": "sandbox",
                    "image": IMAGE,
                    "imagePullPolicy": "IfNotPresent",
                    "securityContext": {"privileged": True},
                    "ports": [{"containerPort": POD_PORT, "name": "http"}],
                    "env": [
                        {"name": "CFS_IP", "value": CFS_IP},
                        {"name": "BOTCAMP_USER_ID", "value": lease["user_id"]},
                        {"name": "BOTCAMP_SESSION_ID", "value": lease["session_id"]},
                        {"name": "BOTCAMP_LEASE_ID", "value": lease["id"]},
                    ],
                    "resources": {
                        "requests": {"cpu": cpu, "memory": mem},
                        "limits": {"cpu": cpu, "memory": mem},
                    },
                    "readinessProbe": {
                        "httpGet": {"path": "/healthz", "port": POD_PORT},
                        "periodSeconds": 2,
                        "failureThreshold": 30,
                    },
                }],
            },
        }
        self._call("POST", "/api/v1/namespaces/%s/pods" % NS, pod)
        try:
            ip = self._wait_ip(name)
        except Exception:
            # never leave an orphan pod behind when the lease fails to come up
            try:
                self._call(
                    "DELETE",
                    "/api/v1/namespaces/%s/pods/%s?gracePeriodSeconds=0" % (NS, name),
                )
            except Exception:
                pass
            raise
        return name, ip

    def _wait_ip(self, name, timeout=None):
        timeout = timeout or POD_TIMEOUT
        deadline = time.time() + timeout
        while time.time() < deadline:
            info = self._call("GET", "/api/v1/namespaces/%s/pods/%s" % (NS, name))
            status = info.get("status") or {}
            ip = status.get("podIP")
            phase = status.get("phase")
            if ip and phase == "Running":
                return ip
            if phase in ("Failed", "Succeeded"):
                raise BackendError("pod %s ended as %s" % (name, phase))
            time.sleep(2)
        raise BackendError("pod %s has no IP after %ss" % (name, timeout))

    def stop(self, lease, force=False):
        name = lease.get("pod_name") or ""
        if not name:
            return True
        grace = 0 if force else DRAIN_GRACE
        try:
            self._call(
                "DELETE",
                "/api/v1/namespaces/%s/pods/%s?gracePeriodSeconds=%d" % (NS, name, grace),
            )
        except BackendError:
            if not force:
                raise
        return True


BACKEND = K8sBackend()


def create_lease(user_id, session_id, profile):
    if profile not in PROFILES:
        profile = "std"
    with DB_LOCK:
        existing = lease_for_user(user_id)
        if existing:
            extend(existing["id"], EXTEND)
            return lease_row(existing["id"]), False
        with db() as conn:
            running = conn.execute(
                "SELECT COUNT(*) AS n FROM leases WHERE state IN ('running','pending')"
            ).fetchone()["n"]
        if running >= MAX_TOTAL:
            raise BackendError("capacity: %d leases in flight" % running)
        lid = secrets.token_urlsafe(12)
        with db() as conn:
            conn.execute(
                "INSERT INTO leases (id,user_id,session_id,profile,state,created_at,expires_at,last_used_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (lid, user_id, session_id, profile, "pending", now(), now() + TTL, now()),
            )
    lease = lease_row(lid)
    try:
        pod_name, pod_ip = BACKEND.start(lease)
    except Exception:
        with db() as conn:
            conn.execute("UPDATE leases SET state='dead' WHERE id=?", (lid,))
        raise
    with db() as conn:
        conn.execute(
            "UPDATE leases SET state='running', pod_name=?, pod_ip=?, expires_at=? WHERE id=?",
            (pod_name, pod_ip, now() + TTL, lid),
        )
    return lease_row(lid), True


def extend(lease_id, seconds):
    seconds = max(30, min(int(seconds), MAX_TTL))
    with db() as conn:
        conn.execute(
            "UPDATE leases SET expires_at=?, last_used_at=? WHERE id=? AND state='running'",
            (now() + seconds, now(), lease_id),
        )
    return lease_row(lease_id)


def destroy(lease_id, force=False):
    lease = lease_row(lease_id)
    if not lease:
        return False
    with db() as conn:
        conn.execute("UPDATE leases SET state='draining' WHERE id=?", (lease_id,))
    try:
        BACKEND.stop(lease, force=force)
    finally:
        with db() as conn:
            conn.execute("UPDATE leases SET state='dead' WHERE id=?", (lease_id,))
    return True


def reap():
    while True:
        try:
            with db() as conn:
                rows = [dict(r) for r in conn.execute(
                    "SELECT * FROM leases WHERE state='running' AND expires_at < ?", (now(),)
                ).fetchall()]
            for lease in rows:
                try:
                    destroy(lease["id"])
                except Exception:
                    pass
            with db() as conn:
                conn.execute("DELETE FROM leases WHERE state='dead' AND last_used_at < ?",
                             (now() - 86400,))
        except Exception:
            pass
        time.sleep(10)


class Handler(BaseHTTPRequestHandler):
    server_version = "botcamp-sandbox"

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    def send_json(self, obj, status=200):
        raw = json_bytes(obj)
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def body_json(self, limit=1 << 20):
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return {}
        if length > limit:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def authorized(self):
        if not TOKEN:
            return True
        return (self.headers.get("authorization") or "") == "Bearer " + TOKEN

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/healthz":
            with db() as conn:
                running = conn.execute(
                    "SELECT COUNT(*) AS n FROM leases WHERE state IN ('running','pending')"
                ).fetchone()["n"]
            return self.send_json({"ok": True, "leases": running})
        if not self.authorized():
            return self.send_json({"error": "unauthorized"}, 401)
        match = RE_USER.match(path)
        if match:
            return self.proxy(match.group(1), match.group(2) or "/")
        match = RE_LEASE.match(path)
        if match and not match.group(2):
            lease = lease_row(match.group(1))
            if not lease:
                return self.send_json({"error": "not found"}, 404)
            return self.send_json(lease)
        return self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if not self.authorized():
            return self.send_json({"error": "unauthorized"}, 401)
        if path == "/leases":
            try:
                body = self.body_json()
            except Exception:
                return self.send_json({"error": "bad json"}, 400)
            user_id = str(body.get("user_id") or "").strip()
            if not user_id:
                return self.send_json({"error": "user_id required"}, 400)
            try:
                lease, created = create_lease(
                    user_id,
                    str(body.get("session_id") or "default").strip(),
                    str(body.get("profile") or "std"),
                )
            except BackendError as exc:
                status = 429 if str(exc).startswith("capacity") else 503
                return self.send_json({"error": str(exc)}, status)
            except Exception as exc:
                return self.send_json({"error": str(exc)}, 502)
            return self.send_json({"lease": lease, "created": created}, 201 if created else 200)
        match = RE_LEASE.match(path)
        if match and match.group(2):
            body = self.body_json()
            lease = extend(match.group(1), body.get("seconds", EXTEND))
            if not lease:
                return self.send_json({"error": "not found"}, 404)
            return self.send_json({"lease": lease})
        return self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not self.authorized():
            return self.send_json({"error": "unauthorized"}, 401)
        match = RE_LEASE.match(path)
        if not match:
            return self.send_json({"error": "not found"}, 404)
        return self.send_json({"ok": destroy(match.group(1))})

    def proxy(self, user_id, rest):
        lease = lease_for_user(user_id)
        if not lease:
            return self.send_json({"error": "no running lease", "user_id": user_id}, 404)
        extend(lease["id"], EXTEND)
        target = rest if rest.startswith("/") else "/" + rest
        marker = "/u/" + user_id
        raw_path = self.path
        if len(raw_path) > len(marker) and raw_path[len(marker)] == "?":
            target += "?" + raw_path.split("?", 1)[1]
        headers = {}
        for key, value in self.headers.items():
            if key.lower() in ("host", "authorization", "connection", "cookie"):
                continue
            headers[key] = value
        headers["host"] = "sandbox.local"
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        conn = http.client.HTTPConnection(lease["pod_ip"], POD_PORT, timeout=600)
        try:
            conn.request(self.command, target, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status)
            for key, value in resp.getheaders():
                if key.lower() in ("transfer-encoding", "connection", "content-length", "keep-alive"):
                    continue
                self.send_header(key, value)
            self.send_header("x-botcamp-lease", lease["id"])
            self.end_headers()
            while True:
                chunk = resp.read(2048)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception as exc:
            try:
                self.send_json({"error": "sandbox unreachable: %s" % exc}, 502)
            except Exception:
                pass
        finally:
            conn.close()


def main():
    init_db()
    threading.Thread(target=reap, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("sandbox control plane on 127.0.0.1:%d" % PORT, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
