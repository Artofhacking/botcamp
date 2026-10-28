#!/usr/bin/env python3
"""BotCamp: account + login + metered model gateway + admin console."""
import base64, hashlib, hmac, json, os, re, secrets, sqlite3, threading, time, urllib.request, urllib.error
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

UPSTREAM = os.environ.get("BOTCAMP_UPSTREAM", "https://aits.aigc.sx.cn/v1").rstrip("/")
UPSTREAM_KEY = os.environ.get("BOTCAMP_UPSTREAM_KEY", "")
ADMIN_PASSWORD = os.environ.get("BOTCAMP_ADMIN_PASSWORD", "")
SECRET = os.environ.get("BOTCAMP_SECRET", "").encode() or secrets.token_bytes(32)
DB_PATH = os.environ.get("BOTCAMP_DB", "/opt/botcamp/data/botcamp.db")
PORT = int(os.environ.get("BOTCAMP_PORT", "8790"))
RPM = int(os.environ.get("BOTCAMP_RPM", "60"))
PINNED_MODEL = os.environ.get("BOTCAMP_MODEL", "deepseek-v4.1")
RATE_IN = float(os.environ.get("BOTCAMP_RATE_IN", "0.14"))    # per 1M input tokens
RATE_OUT = float(os.environ.get("BOTCAMP_RATE_OUT", "0.28"))  # per 1M output tokens

PREFIX = "/botcamp"

def read_version():
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION")) as f:
            return f.read().strip() or "dev"
    except OSError:
        return os.environ.get("BOTCAMP_VERSION", "dev")

VERSION = read_version()
RELAY_SECRET = os.environ.get("BOTCAMP_RELAY_SECRET", "")
RELAY_FILE = os.path.join(os.path.dirname(DB_PATH), "relay.json")

def relay_read():
    try:
        with open(RELAY_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def relay_write(data):
    os.makedirs(os.path.dirname(RELAY_FILE), exist_ok=True)
    tmp = RELAY_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, RELAY_FILE)
DB_LOCK = threading.Lock()
HITS = {}
HITS_LOCK = threading.Lock()

# ---------- storage ----------
def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          name TEXT DEFAULT '',
          note TEXT DEFAULT '',
          pw_hash TEXT NOT NULL,
          token_hash TEXT,
          status TEXT DEFAULT 'active',
          created_at INTEGER NOT NULL,
          last_login_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS usage(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          model TEXT,
          prompt_tokens INTEGER DEFAULT 0,
          cached_tokens INTEGER DEFAULT 0,
          completion_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          status INTEGER DEFAULT 0,
          latency_ms INTEGER DEFAULT 0,
          stream INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS usage_user_ts ON usage(user_id, ts);
        CREATE TABLE IF NOT EXISTS devices(
          slot INTEGER PRIMARY KEY,
          secret_hash TEXT DEFAULT '',
          device_id TEXT UNIQUE NOT NULL,
          user_id INTEGER NOT NULL,
          name TEXT DEFAULT '',
          platform TEXT DEFAULT '',
          token TEXT DEFAULT '',
          updated_at INTEGER NOT NULL,
          online INTEGER DEFAULT 0
        );
        """)

def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120_000)
    return "pbkdf2$120000$%s$%s" % (base64.b64encode(salt).decode(), base64.b64encode(dk).decode())

def check_password(password, stored):
    try:
        _, iters, salt_b64, hash_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iters))
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except Exception:
        return False

def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()

def sign(payload):
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    mac = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32]
    return body + "." + mac

def unsign(value):
    try:
        body, mac = value.rsplit(".", 1)
        if not hmac.compare_digest(mac, hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32]):
            return None
        return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except Exception:
        return None

# ---------- helpers ----------
def now():
    return int(time.time())

def json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode()

def rate_ok(user_id):
    limit = RPM
    window = 60
    t = time.time()
    with HITS_LOCK:
        bucket = HITS.setdefault(user_id, [])
        bucket[:] = [x for x in bucket if t - x < window]
        if len(bucket) >= limit:
            return False
        bucket.append(t)
    return True

def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")

# ---------- admin ui ----------
RELAY_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BotCamp 登录</title>
<style>
:root{--bg:#0b0b0d;--card:#141418;--line:#26262e;--tx:#e8e8ee;--mut:#8b8b98;--acc:#6c8cff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif}
.card{width:min(92vw,360px);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px}
h1{font-size:18px;margin:0 0 4px}p.sub{margin:0 0 20px;color:var(--mut);font-size:13px}
label{display:block;font-size:12px;color:var(--mut);margin:14px 0 6px}
input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:#1b1b21;color:var(--tx);font:inherit}
button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:9px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}
.err{color:#e5574f;font-size:13px;min-height:18px;margin-top:12px}
</style></head><body>
<div class="card">
  <h1>BotCamp</h1>
  <p class="sub">登录后即可连接你的桌面 Bot 团队</p>
  <label>邮箱</label><input id="email" type="email" autocomplete="username" placeholder="you@example.com">
  <label>密码</label><input id="password" type="password" autocomplete="current-password" placeholder="••••••••">
  <button id="go">登录</button>
  <div class="err" id="err"></div>
</div>
<script>
const $=s=>document.querySelector(s)
$('#go').onclick=async()=>{
  const btn=$('#go'), err=$('#err')
  btn.disabled=true; err.textContent=''
  try{
    const r=await fetch('/botcamp/api/relay/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({email:$('#email').value.trim(),password:$('#password').value})})
    const d=await r.json()
    if(!r.ok) throw new Error(d.error||'登录失败')
    const g=await fetch('/botcamp/api/relay/go',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
    const j=await g.json()
    if(!g.ok) throw new Error(j.error||'桌面端未上线')
    location.href=j.redirect
  }catch(e){ err.textContent=e.message; btn.disabled=false }
}
$('#password').addEventListener('keydown',e=>{ if(e.key==='Enter') $('#go').click() })
</script></body></html>"""

RELAY_DEVICES_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>选择设备</title>
<style>
:root{--bg:#0b0b0d;--card:#141418;--line:#26262e;--tx:#e8e8ee;--mut:#8b8b98;--acc:#6c8cff;--ok:#3fbf7f}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;display:flex;justify-content:center;padding:28px 16px}
.wrap{width:min(96vw,460px)}h1{font-size:18px;margin:0 0 4px}p.sub{color:var(--mut);font-size:13px;margin:0 0 20px}
.dev{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.dev .name{flex:1}.dev .meta{color:var(--mut);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;background:#555}.dot.on{background:var(--ok)}
button{border:0;border-radius:9px;padding:9px 14px;background:var(--acc);color:#fff;font:inherit;cursor:pointer}
button:disabled{background:#2a2a33;color:#777;cursor:not-allowed}
.err{color:#e5574f;font-size:13px;margin-top:14px}
</style></head><body><div class="wrap">
<h1>选择设备</h1><p class="sub">这些是登录过 BotCamp 客户端的电脑</p>
<div id="list"></div><div class="err" id="err"></div>
</div><script>
const $=s=>document.querySelector(s)
async function load(){
  const r=await fetch('/botcamp/api/relay/devices');const d=await r.json()
  if(!r.ok){location.href='/botcamp/relay';return}
  if(!d.devices.length){$('#list').innerHTML='<p class="sub">还没有设备。先在电脑上打开 BotCamp 客户端并登录。</p>';return}
  if(d.devices.length===1){connect(d.devices[0].slot);return}
  $('#list').innerHTML=d.devices.map(x=>`<div class="dev"><span class="dot ${x.online?'on':''}"></span>
    <div class="name"><div>${x.name||x.slot}</div><div class="meta">${x.platform||''} · ${x.online?'在线':'离线'} · ${x.last_seen||''}</div></div>
    <button ${x.online?'':'disabled'} onclick="connect('${x.slot}')">连接</button></div>`).join('')
}
async function connect(slot){
  const r=await fetch('/botcamp/api/relay/go',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dev:slot})})
  const d=await r.json()
  if(!r.ok){$('#err').textContent=d.error||'连接失败';return}
  location.href=d.redirect
}
load()
</script></body></html>"""

ADMIN_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BotCamp 控制台</title>
<style>
:root{--bg:#0b0b0d;--card:#141418;--line:#26262e;--tx:#e8e8ee;--mut:#8b8b98;--acc:#6c8cff;--ok:#3fbf7f;--bad:#e5574f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.55 system-ui,-apple-system,"PingFang SC",sans-serif}
header{display:flex;align-items:center;gap:16px;padding:16px 24px;border-bottom:1px solid var(--line)}
h1{font-size:16px;margin:0;font-weight:600}main{max-width:1180px;margin:0 auto;padding:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:18px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
input,button{font:inherit;border-radius:8px;border:1px solid var(--line);background:#1b1b21;color:var(--tx);padding:8px 12px}
button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#fff}
button.ghost{background:transparent;color:var(--mut);border-color:var(--line)}
button.danger{background:transparent;border-color:#5a2b2b;color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mut);font-weight:500}td.num{text-align:right;font-variant-numeric:tabular-nums}
.mut{color:var(--mut)}.pill{padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.pill.on{color:var(--ok);border-color:#1f5a3c}.pill.off{color:var(--bad);border-color:#5a2b2b}
.toast{position:fixed;right:20px;bottom:20px;background:#1f1f27;border:1px solid var(--line);padding:12px 16px;border-radius:10px;display:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.kpi{background:#101014;border:1px solid var(--line);border-radius:10px;padding:14px}
.kpi b{display:block;font-size:22px;margin-top:4px}
</style></head><body>
<header><h1>BotCamp 控制台</h1><span class="mut" id="who"></span><span class="mut" id="ver"></span><span style="flex:1"></span><button class="ghost" id="logout">退出</button></header>
<main>
  <div class="card" id="loginCard">
    <div class="row"><input id="pw" type="password" placeholder="管理员密码" style="min-width:260px"><button id="loginBtn">登录</button></div>
  </div>
  <div id="app" style="display:none">
    <div class="card">
      <div class="grid" id="kpis"></div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:14px">
        <input id="email" placeholder="邮箱 / 账号" style="min-width:220px">
        <input id="name" placeholder="名字（可选）">
        <input id="note" placeholder="备注（可选）">
        <button id="createBtn">开账号</button>
        <span class="mut" id="createMsg"></span>
      </div>
      <table><thead><tr><th>账号</th><th>状态</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">花费</th><th>模型 / tokens</th><th>桌面</th><th>最近使用</th><th></th></tr></thead><tbody id="rows"></tbody></table>
    </div>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
const API='/botcamp/api';
let $=s=>document.querySelector(s);
function toast(t){const el=$('#toast');el.textContent=t;el.style.display='block';clearTimeout(window._t);window._t=setTimeout(()=>el.style.display='none',3200)}
async function api(path,opts={}){const r=await fetch(API+path,{headers:{'content-type':'application/json'},credentials:'same-origin',...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d}
function fmt(n){return (n||0).toLocaleString()}
function money(n){n=n||0;return '¥'+(n>0&&n<0.01?n.toFixed(6):n.toFixed(2))}
async function load(){
  const [ov,us]=await Promise.all([api('/admin/overview'),api('/admin/users')]);
  $('#kpis').innerHTML=[['用户数',ov.users],['今日请求',fmt(ov.today_requests)],['今日 tokens',fmt(ov.today_tokens)],['7 日花费',money(ov.week_cost)]]
    .map(([k,v])=>`<div class="kpi"><span class="mut">${k}</span><b>${v}</b></div>`).join('');
  $('#rows').innerHTML=us.users.map(u=>`<tr>
    <td><b>${u.email}</b><div class="mut" style="font-size:12px">${u.name||''} ${u.note?'· '+u.note:''}</div></td>
    <td><span class="pill ${u.status==='active'?'on':'off'}">${u.status==='active'?'正常':'停用'}</span></td>
    <td class="num">${fmt(u.requests)}</td><td class="num">${fmt(u.prompt_tokens)}</td><td class="num">${fmt(u.completion_tokens)}</td>
    <td class="num">${money(u.cost)}</td><td><button class="ghost" data-desk="${u.id}" data-on="${u.can_desk?1:0}">${u.can_desk?'已开通':'未开通'}</button></td><td>${(u.models||[]).map(m=>`<span class="pill" title="${m.requests} 次请求 · 输入 ${fmt(m.prompt_tokens)} / 输出 ${fmt(m.completion_tokens)}">${m.model} · ${fmt(m.total_tokens)}</span>`).join(" ")||"<span class=mut>—</span>"}</td><td class="mut">${u.last_seen||'—'}</td>
    <td><button class="danger" data-toggle="${u.id}" data-status="${u.status}">${u.status==='active'?'停用':'启用'}</button></td></tr>`).join('');
  document.querySelectorAll('[data-desk]').forEach(b=>b.onclick=async()=>{
    await api('/admin/users/'+b.dataset.desk+'/desk',{method:'POST',body:JSON.stringify({enabled:b.dataset.on!=='1'})});
    toast('已更新');load();
  });
  document.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=async()=>{
    await api('/admin/users/'+b.dataset.toggle+'/status',{method:'POST',body:JSON.stringify({status:b.dataset.status==='active'?'disabled':'active'})});
    toast('已更新');load();
  });
}
$('#loginBtn').onclick=async()=>{try{await api('/admin/login',{method:'POST',body:JSON.stringify({password:$('#pw').value})});$('#loginCard').style.display='none';$('#app').style.display='block';load()}catch(e){toast('密码不对：'+e.message)}};
$('#logout').onclick=async()=>{await fetch(API+'/admin/logout',{method:'POST',credentials:'same-origin'});location.reload()};
$('#createBtn').onclick=async()=>{
  const email=$('#email').value.trim(); if(!email)return toast('先填账号');
  try{const d=await api('/admin/users',{method:'POST',body:JSON.stringify({email,name:$('#name').value,note:$('#note').value})});
    $('#createMsg').innerHTML=`已创建 · 初始密码 <code>${d.password}</code>（只显示一次）`;
    $('#email').value='';$('#name').value='';$('#note').value='';load();
  }catch(e){toast('创建失败：'+e.message)}
};
(async()=>{try{const me=await api('/admin/me');$('#who').textContent=me.admin?'管理员已登录':'';$('#ver').textContent=me.version?'v'+me.version:'');$('#loginCard').style.display='none';$('#app').style.display='block';load()}catch(e){}})();
</script></body></html>"""

def user_view(row, stats, models=()):
    cost = (stats["prompt_tokens"] or 0) / 1e6 * RATE_IN + (stats["completion_tokens"] or 0) / 1e6 * RATE_OUT
    return {
        "id": row["id"], "email": row["email"], "name": row["name"], "note": row["note"],
        "status": row["status"], "can_desk": row["can_desk"], "created_at": iso(row["created_at"]),
        "last_seen": iso(row["last_login_at"]) if row["last_login_at"] else None,
        "requests": stats["requests"] or 0, "prompt_tokens": stats["prompt_tokens"] or 0,
        "completion_tokens": stats["completion_tokens"] or 0,
        "total_tokens": stats["total_tokens"] or 0, "cost": round(cost, 6),
        "models": [{"model": m["model"] or "unknown", "requests": m["n"], "prompt_tokens": m["p"] or 0,
                    "completion_tokens": m["c"] or 0, "total_tokens": m["t"] or 0} for m in models],
    }

# ---------- http ----------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "BotCamp/1.0"

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    # -- response helpers --
    def send_json(self, obj, status=200, headers=None):
        body = json_bytes(obj)
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html, status=200):
        body = html.encode()
        self.send_response(status)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def cookies(self):
        raw = self.headers.get("cookie", "")
        out = {}
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                out[k] = v
        return out

    def is_admin(self):
        tok = self.cookies().get("botcamp_admin", "")
        data = unsign(tok) if tok else None
        return bool(data and data.get("role") == "admin" and data.get("exp", 0) > now())

    def user_from_token(self, token):
        if not token:
            return None
        h = token_hash(token)
        with db() as c:
            return c.execute("SELECT * FROM users WHERE token_hash=? AND status='active'", (h,)).fetchone()

    def body_json(self, limit=8_000_000):
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            return {}
        if length <= 0 or length > limit:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return {}

    # -- routing --
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/botcamp", "/botcamp/"):
            return self.send_response(302) or self.send_header("location", PREFIX + "/admin") or self.end_headers()
        if path == PREFIX + "/admin":
            return self.send_html(ADMIN_HTML)
        if path == PREFIX + "/healthz":
            return self.send_json({"ok": True, "version": VERSION})
        if path == PREFIX + "/api/relay/devices":
            tok = self.cookies().get("botcamp_relay", "")
            data = unsign(tok) if tok else None
            if not data:
                return self.send_json({"error": "login required"}, 401)
            with db() as c:
                rows = c.execute("SELECT slot, name, platform, updated_at FROM devices WHERE user_id=? ORDER BY slot", (data.get("uid"),)).fetchall()
            return self.send_json({"devices": [{"slot": f"d{r['slot']}", "name": r["name"], "platform": r["platform"],
                                                "online": now() - r["updated_at"] < 180, "last_seen": iso(r["updated_at"])} for r in rows]})
        if path == PREFIX + "/relay/devices":
            return self.send_html(RELAY_DEVICES_HTML)
        if path == PREFIX + "/relay":
            return self.send_html(RELAY_HTML)
        if path.startswith(PREFIX + "/api/relay/check/"):
            slot = path.rsplit("/", 1)[-1]
            tok = self.cookies().get("botcamp_relay", "")
            data = unsign(tok) if tok else None
            if not (data and data.get("role") == "relay" and data.get("exp", 0) > now()):
                return self.send_json({"ok": False, "error": "login required"}, 401)
            if not slot.startswith("d") or not slot[1:].isdigit():
                return self.send_json({"ok": False, "error": "unknown device"}, 404)
            with db() as c:
                u = c.execute("SELECT id, email, can_desk FROM users WHERE id=? AND status='active'", (data.get("uid"),)).fetchone()
                dev = c.execute("SELECT * FROM devices WHERE slot=?", (int(slot[1:]),)).fetchone()
            if u is None or not u["can_desk"]:
                return self.send_json({"ok": False, "error": "no device access"}, 403)
            if dev is None or dev["user_id"] != u["id"]:
                return self.send_json({"ok": False, "error": "device not yours"}, 403)
            if now() - dev["updated_at"] > 180:
                return self.send_json({"ok": False, "error": "device offline"}, 503)
            return self.send_json({"ok": True})
        if path == PREFIX + "/api/admin/me":
            return self.send_json({"admin": True, "version": VERSION}) if self.is_admin() else self.send_json({"error": "unauthorized"}, 401)
        if path == PREFIX + "/api/admin/users":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.admin_users()
        if path == PREFIX + "/api/admin/overview":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.admin_overview()
        if path == PREFIX + "/api/me":
            u = self.user_from_token(self.bearer())
            if not u:
                return self.send_json({"error": "unauthorized"}, 401)
            return self.send_json({"user": {"email": u["email"], "name": u["name"]}})
        if path == PREFIX + "/v1/models":
            return self.proxy_models()
        self.send_json({"error": "not found", "path": path}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == PREFIX + "/api/devices/register":
            auth = self.bearer()
            with db() as c:
                u = c.execute("SELECT id, email FROM users WHERE token_hash=? AND status='active'", (token_hash(auth),)).fetchone()
            if u is None:
                return self.send_json({"error": "unauthorized"}, 401)
            body = self.body_json()
            device_id = str(body.get("device_id") or "").strip()
            if not device_id:
                return self.send_json({"error": "device_id required"}, 400)
            secret = secrets.token_urlsafe(32)
            with db() as c:
                row = c.execute("SELECT slot FROM devices WHERE device_id=?", (device_id,)).fetchone()
                if row is None:
                    used = {r["slot"] for r in c.execute("SELECT slot FROM devices")}
                    slot = next((i for i in range(1, 11) if i not in used), None)
                    if slot is None:
                        return self.send_json({"error": "device slots exhausted"}, 507)
                    c.execute("INSERT INTO devices(slot,device_id,user_id,name,platform,secret_hash,updated_at) VALUES(?,?,?,?,?,?,?)",
                              (slot, device_id, u["id"], str(body.get("name") or "")[:60], str(body.get("platform") or "")[:30], token_hash(secret), now()))
                else:
                    slot = row["slot"]
                    c.execute("UPDATE devices SET user_id=?, name=?, platform=?, secret_hash=?, updated_at=? WHERE slot=?",
                              (u["id"], str(body.get("name") or "")[:60], str(body.get("platform") or "")[:30], token_hash(secret), now(), slot))
            return self.send_json({"ok": True, "slot": slot, "device_secret": secret, "path": f"/desk/d{slot}/"})
        if path == PREFIX + "/api/devices/heartbeat":
            auth = self.bearer()
            body = self.body_json()
            token = str(body.get("token") or "")
            with db() as c:
                dev = c.execute("SELECT slot FROM devices WHERE secret_hash=?", (token_hash(auth),)).fetchone()
                if dev is None:
                    return self.send_json({"error": "unknown device"}, 401)
                c.execute("UPDATE devices SET token=?, updated_at=?, online=1 WHERE slot=?", (token or None, now(), dev["slot"]))
            return self.send_json({"ok": True, "slot": dev["slot"]})
        if path == PREFIX + "/api/relay/register":
            return self.send_json({"error": "deprecated: devices register with a user login now"}, 410)
            body = self.body_json()
            owner = (body.get("owner") or "").strip().lower()
            device_id = str(body.get("device_id") or "").strip()
            if not owner or not device_id:
                return self.send_json({"error": "owner and device_id required"}, 400)
            with db() as c:
                u = c.execute("SELECT id FROM users WHERE email=?", (owner,)).fetchone()
                if u is None:
                    return self.send_json({"error": "unknown owner"}, 404)
                row = c.execute("SELECT slot FROM devices WHERE device_id=?", (device_id,)).fetchone()
                if row is None:
                    used = {r["slot"] for r in c.execute("SELECT slot FROM devices")}
                    slot = next((i for i in range(1, 11) if i not in used), None)
                    if slot is None:
                        return self.send_json({"error": "device slots exhausted"}, 507)
                    c.execute("INSERT INTO devices(slot,device_id,user_id,name,platform,updated_at) VALUES(?,?,?,?,?,?)",
                              (slot, device_id, u["id"], str(body.get("name") or "")[:60], str(body.get("platform") or "")[:30], now()))
                else:
                    slot = row["slot"]
                token = str(body.get("token") or "")
                c.execute("UPDATE devices SET user_id=?, name=?, platform=?, updated_at=?, online=1 WHERE slot=?",
                          (u["id"], str(body.get("name") or "")[:60], str(body.get("platform") or "")[:30], now(), slot))
                if token:
                    c.execute("UPDATE devices SET token=? WHERE slot=?", (token, slot))
            return self.send_json({"ok": True, "slot": slot, "path": f"/desk/d{slot}/"})
        if path == PREFIX + "/api/relay/token":
            if not RELAY_SECRET or not hmac.compare_digest(self.headers.get("x-relay-secret", ""), RELAY_SECRET):
                return self.send_json({"error": "unauthorized"}, 401)
            body = self.body_json()
            token = str(body.get("token") or "")
            if not token:
                return self.send_json({"error": "token required"}, 400)
            relay_write({"token": token, "at": now(), "owner": str(body.get("owner") or "")})
            return self.send_json({"ok": True})
        if path == PREFIX + "/api/relay/login":
            d = self.body_json()
            email = (d.get("email") or "").strip().lower()
            pw = d.get("password") or ""
            with db() as c:
                u = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if not u or u["status"] != "active" or not check_password(pw, u["pw_hash"]):
                return self.send_json({"error": "账号或密码错误"}, 401)
            if not u["can_desk"]:
                return self.send_json({"error": "该账号未开通桌面访问权限"}, 403)
            exp = now() + 7 * 86400
            cookie = "botcamp_relay=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (sign({"role": "relay", "uid": u["id"], "exp": exp}), 7 * 86400)
            return self.send_json({"ok": True, "redirect": PREFIX + "/relay/devices"}, headers={"set-cookie": cookie})
        if path == PREFIX + "/api/relay/go":
            tok = self.cookies().get("botcamp_relay", "")
            data = unsign(tok) if tok else None
            if not data:
                return self.send_json({"error": "login required"}, 401)
            body = self.body_json()
            wanted = str(body.get("dev") or "")
            with db() as c:
                if wanted.startswith("d") and wanted[1:].isdigit():
                    dev = c.execute("SELECT slot, token, updated_at FROM devices WHERE user_id=? AND slot=?",
                                    (data.get("uid"), int(wanted[1:]))).fetchone()
                    if dev is None:
                        return self.send_json({"error": "设备不存在或不属于你"}, 403)
                    if now() - dev["updated_at"] > 180 or not dev["token"]:
                        return self.send_json({"error": "该设备当前离线"}, 503)
                else:
                    dev = c.execute("SELECT slot, token, updated_at FROM devices WHERE user_id=? AND token!='' AND updated_at>? ORDER BY slot LIMIT 1",
                                    (data.get("uid"), now() - 180)).fetchone()
            if dev is None:
                return self.send_json({"error": "没有在线的设备，请先在电脑上打开客户端"}, 503)
            return self.send_json({"ok": True, "redirect": f"/desk/d{dev['slot']}/?token={dev['token']}"})
        if path == PREFIX + "/api/login":
            return self.login()
        if path == PREFIX + "/api/admin/login":
            return self.admin_login()
        if path == PREFIX + "/api/admin/logout":
            return self.send_json({"ok": True}, headers={"set-cookie": "botcamp_admin=; Path=/; Max-Age=0"})
        if path == PREFIX + "/api/admin/users":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.admin_create_user()
        m = re.fullmatch(PREFIX + r"/api/admin/users/(\d+)/desk", path)
        if m:
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            d = self.body_json()
            with db() as c:
                c.execute("UPDATE users SET can_desk=? WHERE id=?", (1 if d.get("enabled") else 0, int(m.group(1))))
            return self.send_json({"ok": True})
        m = re.fullmatch(PREFIX + r"/api/admin/users/(\d+)/status", path)
        if m:
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            d = self.body_json()
            with db() as c:
                c.execute("UPDATE users SET status=? WHERE id=?", ("active" if d.get("status") == "active" else "disabled", int(m.group(1))))
            return self.send_json({"ok": True})
        m = re.fullmatch(PREFIX + r"/api/admin/users/(\d+)/password", path)
        if m:
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            pw = secrets.token_urlsafe(9)
            with db() as c:
                c.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(pw), int(m.group(1))))
            return self.send_json({"ok": True, "password": pw})
        if path == PREFIX + "/v1/chat/completions":
            return self.chat()
        self.send_json({"error": "not found"}, 404)

    def bearer(self):
        a = self.headers.get("authorization", "")
        if a.lower().startswith("bearer "):
            return a[7:].strip()
        return self.headers.get("x-api-key", "").strip()

    # -- auth --
    def login(self):
        d = self.body_json()
        email = (d.get("email") or "").strip().lower()
        pw = d.get("password") or ""
        with db() as c:
            u = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if not u or u["status"] != "active" or not check_password(pw, u["pw_hash"]):
                return self.send_json({"error": "账号或密码错误"}, 401)
            token = secrets.token_urlsafe(32)
            c.execute("UPDATE users SET token_hash=?, last_login_at=? WHERE id=?", (token_hash(token), now(), u["id"]))
        return self.send_json({"token": token, "user": {"email": email, "name": u["name"]}})

    def admin_login(self):
        d = self.body_json()
        if not ADMIN_PASSWORD or not hmac.compare_digest(str(d.get("password", "")), ADMIN_PASSWORD):
            return self.send_json({"error": "密码错误"}, 401)
        exp = now() + 12 * 3600
        cookie = "botcamp_admin=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (sign({"role": "admin", "exp": exp}), 12 * 3600)
        return self.send_json({"ok": True}, headers={"set-cookie": cookie})

    # -- admin data --
    def admin_users(self):
        with db() as c:
            rows = c.execute("SELECT * FROM users ORDER BY id DESC").fetchall()
            out = []
            for r in rows:
                st = c.execute("SELECT COUNT(*) requests, SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens, SUM(total_tokens) total_tokens FROM usage WHERE user_id=?", (r["id"],)).fetchone()
                models = c.execute("SELECT model, COUNT(*) n, SUM(prompt_tokens) p, SUM(completion_tokens) c, SUM(total_tokens) t FROM usage WHERE user_id=? GROUP BY model ORDER BY n DESC", (r["id"],)).fetchall()
                out.append(user_view(r, st, models))
        return self.send_json({"users": out})

    def admin_overview(self):
        t0 = now() - 86400
        w0 = now() - 7 * 86400
        with db() as c:
            users = c.execute("SELECT COUNT(*) n FROM users").fetchone()["n"]
            today = c.execute("SELECT COUNT(*) r, COALESCE(SUM(total_tokens),0) t FROM usage WHERE ts>=?", (t0,)).fetchone()
            week = c.execute("SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) o FROM usage WHERE ts>=?", (w0,)).fetchone()
        cost = week["p"] / 1e6 * RATE_IN + week["o"] / 1e6 * RATE_OUT
        return self.send_json({"users": users, "today_requests": today["r"], "today_tokens": today["t"], "week_cost": round(cost, 6)})

    def admin_create_user(self):
        d = self.body_json()
        email = (d.get("email") or "").strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            return self.send_json({"error": "账号需要是邮箱格式"}, 400)
        pw = secrets.token_urlsafe(9)
        try:
            with db() as c:
                c.execute("INSERT INTO users(email,name,note,pw_hash,created_at) VALUES(?,?,?,?,?)",
                          (email, (d.get("name") or "").strip(), (d.get("note") or "").strip(), hash_password(pw), now()))
        except sqlite3.IntegrityError:
            return self.send_json({"error": "这个账号已存在"}, 409)
        return self.send_json({"ok": True, "email": email, "password": pw})

    # -- model gateway --
    def proxy_models(self):
        """Users never choose a model: the gateway always serves exactly one."""
        u = self.user_from_token(self.bearer())
        if not u:
            return self.send_json({"error": "unauthorized"}, 401)
        return self.send_json({"object": "list", "data": [{"id": PINNED_MODEL, "object": "model", "owned_by": "botcamp"}]})

    def chat(self):
        u = self.user_from_token(self.bearer())
        if not u:
            return self.send_json({"error": {"message": "invalid BotCamp token", "type": "auth"}}, 401)
        if not rate_ok(u["id"]):
            return self.send_json({"error": {"message": "请求过于频繁，请稍后再试", "type": "rate_limit"}}, 429)

        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        try:
            payload = json.loads(raw or b"{}")
        except Exception:
            return self.send_json({"error": {"message": "bad json"}}, 400)

        payload["model"] = PINNED_MODEL
        stream = bool(payload.get("stream"))
        if stream:
            payload.setdefault("stream_options", {})["include_usage"] = True

        started = time.time()
        req = urllib.request.Request(UPSTREAM + "/chat/completions", data=json_bytes(payload),
                                     headers={"authorization": "Bearer " + UPSTREAM_KEY, "content-type": "application/json"})
        try:
            upstream = urllib.request.urlopen(req, timeout=300)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.record(u["id"], payload.get("model"), {}, e.code, started, stream)
            self.send_response(e.code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        except Exception as e:
            self.record(u["id"], payload.get("model"), {}, 502, started, stream)
            return self.send_json({"error": {"message": "upstream unreachable: %s" % e}}, 502)

        status = upstream.status
        if not stream:
            body = upstream.read()
            usage = {}
            try:
                usage = json.loads(body).get("usage") or {}
            except Exception:
                pass
            self.record(u["id"], payload.get("model"), usage, status, started, stream)
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # streaming: relay bytes and sniff the usage chunk
        self.send_response(status)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        usage, model_used, buf = {}, payload.get("model"), b""
        try:
            while True:
                chunk = upstream.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    s = line.strip()
                    if s.startswith(b"data:") and b"[DONE]" not in s:
                        try:
                            j = json.loads(s[5:])
                            if j.get("usage"):
                                usage = j["usage"]
                            if j.get("model"):
                                model_used = j["model"]
                        except Exception:
                            pass
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()
            self.record(u["id"], model_used, usage, status, started, stream)

    def record(self, user_id, model, usage, status, started, stream):
        try:
            p = int(usage.get("prompt_tokens") or 0)
            c = int(usage.get("completion_tokens") or 0)
            cached = int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or usage.get("prompt_cache_hit_tokens") or 0)
            total = int(usage.get("total_tokens") or (p + c))
            with DB_LOCK, db() as conn:
                conn.execute("INSERT INTO usage(user_id,ts,model,prompt_tokens,cached_tokens,completion_tokens,total_tokens,status,latency_ms,stream) VALUES(?,?,?,?,?,?,?,?,?,?)",
                             (user_id, now(), model or "", p, cached, c, total, status, int((time.time() - started) * 1000), 1 if stream else 0))
        except Exception as e:
            print("record failed:", e, flush=True)


def main():
    init_db()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("BotCamp listening on 127.0.0.1:%d (db=%s, upstream=%s)" % (PORT, DB_PATH, UPSTREAM), flush=True)
    srv.serve_forever()

if __name__ == "__main__":
    main()
