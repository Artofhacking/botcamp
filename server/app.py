#!/usr/bin/env python3
"""BotCamp: account + login + metered model gateway + admin console."""
import base64, hashlib, hmac, http.cookiejar, json, os, re, secrets, sqlite3, threading, time, urllib.request, urllib.error, urllib.parse
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
SITE_ORIGIN = os.environ.get("BOTCAMP_SITE_ORIGIN", "https://botcamp.demox.site").rstrip("/")
ALLOWED_ORIGINS = {SITE_ORIGIN, "dsh-app://app", "http://127.0.0.1:8765", "http://localhost:8765", "null"}
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("BOTCAMP_ADMIN_EMAILS", "").split(",") if e.strip()}
PUBLIC_URL = os.environ.get("BOTCAMP_PUBLIC_URL", "https://camp.aigc.sx.cn").rstrip("/")

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
        CREATE TABLE IF NOT EXISTS pair_codes(
          code TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          name TEXT DEFAULT '',
          platform TEXT DEFAULT '',
          status TEXT DEFAULT 'pending',
          slot INTEGER,
          created_at INTEGER NOT NULL
        );
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
        CREATE TABLE IF NOT EXISTS admins(
          email TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings(
          key TEXT PRIMARY KEY,
          value TEXT
        );
        """)
        try:
            c.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'")
        except sqlite3.OperationalError:
            pass
        c.execute("UPDATE users SET role='user' WHERE role IS NULL OR role=''")
        c.execute("UPDATE users SET role='admin' WHERE email IN (SELECT email FROM admins)")
        seeded = c.execute("SELECT COUNT(*) n FROM admins").fetchone()["n"]
        if not seeded:
            for mail in sorted(ADMIN_EMAILS):
                c.execute("INSERT OR IGNORE INTO admins(email, created_at) VALUES(?,?)", (mail, now()))

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
:root{--bg:#f6f7f9;--card:#fff;--line:#e6e8ee;--tx:#14161a;--mut:#6b7280;--acc:#4d6bfe;--ok:#16a34a;--err:#dc2626}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;padding:24px}
.card{width:min(92vw,380px);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px rgba(16,24,40,.06)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.mark{width:24px;height:24px;border-radius:7px;background:linear-gradient(140deg,#6c8cff,#3b4fd8)}
h1{font-size:20px;margin:0}
p.sub{margin:6px 0 20px;color:var(--mut);font-size:13px}
label{display:block;font-size:12.5px;color:var(--mut);margin:14px 0 6px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--tx);font:inherit;outline:none}
input:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(77,107,254,.14)}
button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:10px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:#3f5cf0}
button:disabled{opacity:.55;cursor:default}
.err{color:var(--err);font-size:13px;min-height:18px;margin-top:12px}
</style></head><body>
<div class="card">
  <div class="brand"><span class="mark"></span><h1>BotCamp</h1></div>
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
:root{--bg:#f6f7f9;--card:#fff;--line:#e6e8ee;--tx:#14161a;--mut:#6b7280;--acc:#4d6bfe;--ok:#16a34a;--err:#dc2626}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;padding:24px}
.card{width:min(92vw,380px);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px rgba(16,24,40,.06)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.mark{width:24px;height:24px;border-radius:7px;background:linear-gradient(140deg,#6c8cff,#3b4fd8)}
h1{font-size:20px;margin:0}
p.sub{margin:6px 0 20px;color:var(--mut);font-size:13px}
label{display:block;font-size:12.5px;color:var(--mut);margin:14px 0 6px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--tx);font:inherit;outline:none}
input:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(77,107,254,.14)}
button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:10px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:#3f5cf0}
button:disabled{opacity:.55;cursor:default}
.err{color:var(--err);font-size:13px;min-height:18px;margin-top:12px}

.wrap{width:min(96vw,460px)}
.dev{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:10px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.dev .name{flex:1;font-size:14px}
.dev .meta{color:var(--mut);font-size:12px;margin-top:2px}
.dot{width:8px;height:8px;border-radius:50%;background:#c9ccd3}
.dot.on{background:var(--ok)}
.dev button{width:auto;margin:0;padding:8px 14px;font-size:13px;border-radius:9px}
.dev button:disabled{background:#eef0f4;color:#9aa0aa}
</style></head><body><div class="wrap">
<div class="brand"><span class="mark"></span><h1>选择设备</h1></div>
<p class="sub">这些是登录过 BotCamp 客户端的电脑</p>
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

PAIR_HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>绑定设备</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e6e8ee;--tx:#14161a;--mut:#6b7280;--acc:#4d6bfe;--ok:#16a34a;--err:#dc2626}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;padding:24px}
.card{width:min(92vw,380px);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px rgba(16,24,40,.06)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.mark{width:24px;height:24px;border-radius:7px;background:linear-gradient(140deg,#6c8cff,#3b4fd8)}
h1{font-size:20px;margin:0}
p.sub{margin:6px 0 20px;color:var(--mut);font-size:13px}
label{display:block;font-size:12.5px;color:var(--mut);margin:14px 0 6px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--tx);font:inherit;outline:none}
input:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(77,107,254,.14)}
button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:10px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:#3f5cf0}
button:disabled{opacity:.55;cursor:default}
.err{color:var(--err);font-size:13px;min-height:18px;margin-top:12px}

.card{text-align:center}
code{display:block;font:600 28px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px;margin:16px 0;color:var(--acc)}
</style></head><body>
<div class="card"><div class="brand" style="justify-content:center"><span class="mark"></span><h1>绑定这台电脑</h1></div>
<p class="sub">请在即将登录的电脑上确认下面这串码</p><code id="c"></code>
<p class="sub" id="hint">登录 BotCamp 账号后确认绑定</p>
<label>邮箱</label><input id="email" type="email" autocomplete="username" placeholder="you@example.com">
<label>密码</label><input id="password" type="password" autocomplete="current-password" placeholder="••••••••">
<button id="ok">登录并绑定</button><p id="m" class="sub" style="margin:14px 0 0"></p></div>
<script>
const code=new URLSearchParams(location.search).get('code')||''
document.querySelector('#c').textContent=code
const $ = (s) => document.querySelector(s)
async function login() {
  const r = await fetch('/botcamp/api/relay/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: $('#email').value.trim(), password: $('#password').value }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || '登录失败')
}
async function approve() {
  const r = await fetch('/botcamp/api/devices/pair/approve', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  })
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }
}
$('#ok').onclick = async () => {
  const button = $('#ok'); const message = $('#m'); button.disabled = true; message.textContent = ''
  try {
    let result = await approve()
    if (result.status === 401) {
      message.textContent = '请先登录 BotCamp 账号'
      await login()
      result = await approve()
    }
    if (!result.ok) throw new Error(result.data.error || '绑定失败')
    message.textContent = '已绑定，可以回到电脑上继续'
    button.textContent = '已绑定'
  } catch (error) {
    message.textContent = error.message || String(error)
    button.disabled = false
  }
}
</script></body></html>"""

ADMIN_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BotCamp 控制台</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e6e8ee;--tx:#14161a;--mut:#6b7280;--acc:#4d6bfe;--ok:#16a34a;--bad:#dc2626}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.55 system-ui,-apple-system,"PingFang SC",sans-serif}
header{display:flex;align-items:center;gap:16px;padding:16px 24px;border-bottom:1px solid var(--line);background:#fff}
h1{font-size:16px;margin:0;font-weight:600}main{max-width:1180px;margin:0 auto;padding:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:18px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
input,button{font:inherit;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--tx);padding:8px 12px}
button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#fff;transition:background .15s}
button:hover{background:#3f5cf0;border-color:#3f5cf0}
button.modal{position:fixed;inset:0;background:rgba(16,24,40,.28);display:flex;align-items:center;justify-content:center;z-index:20}
.modalbox{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;width:min(92vw,560px);max-height:70vh;overflow:auto}
.devrow{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
.devrow button{margin-left:auto}
.ghost{background:transparent;color:var(--mut);border-color:var(--line)}
button.danger{background:#fff;border-color:#f0c9c9;color:var(--bad)}
.brand{display:inline-flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;font-weight:700;font-size:14px;margin-right:6px}
.brand img{width:26px;height:26px;border-radius:8px;display:block}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mut);font-weight:500}td.num{text-align:right;font-variant-numeric:tabular-nums}
.mut{color:var(--mut)}.pill{padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.pill.on{color:var(--ok);border-color:#bfe6cd;background:#f0faf3}.pill.off{color:var(--bad);border-color:#f3caca;background:#fdf3f3}
.toast{position:fixed;right:20px;bottom:20px;background:#fff;border:1px solid var(--line);padding:12px 16px;border-radius:10px;display:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px}
.kpi b{display:block;font-size:22px;margin-top:4px}
</style></head><body>
<header><a class="brand" href="/"><img src="/icon.png" alt=""><span>BotCamp</span></a><span class="mut" id="who"></span><span class="mut" id="ver"></span><span style="flex:1"></span><button class="ghost" id="logout">退出</button></header>
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
      <table><thead><tr><th>账号</th><th>状态</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">花费</th><th>模型 / tokens</th><th>最近使用</th><th></th></tr></thead><tbody id="rows"></tbody></table>
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
    <td class="num">${money(u.cost)}</td><td><button class="ghost" data-devices="${u.id}" data-email="${u.email}">设备</button></td><td>${(u.models||[]).map(m=>`<span class="pill" title="${m.requests} 次请求 · 输入 ${fmt(m.prompt_tokens)} / 输出 ${fmt(m.completion_tokens)}">${m.model} · ${fmt(m.total_tokens)}</span>`).join(" ")||"<span class=mut>—</span>"}</td><td class="mut">${u.last_seen||'—'}</td>
    <td><button class="danger" data-toggle="${u.id}" data-status="${u.status}">${u.status==='active'?'停用':'启用'}</button></td></tr>`).join('');
  document.querySelectorAll('[data-devices]').forEach(b=>b.onclick=async()=>{
    const r=await fetch(API+'/admin/users/'+b.dataset.devices+'/devices');const d=await r.json();
    const rows=(d.devices||[]).map(x=>`<div class="devrow">${x.slot} · ${x.name||'-'} · ${x.platform||'-'} ·
      ${x.online?'<span style="color:#3fbf7f">在线</span>':'离线'} · ${x.last_seen}
      <button class="ghost" onclick="unbind(${b.dataset.devices},'${x.slot}')">解绑</button></div>`).join('')||'<p>没有设备</p>';
    modal(b.dataset.email, rows);
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
(async()=>{try{const me=await api('/admin/me');$('#who').textContent=me.admin?'管理员已登录':'';$('#ver').textContent=me.version?'v'+me.version:'';;$('#loginCard').style.display='none';$('#app').style.display='block';load()}catch(e){}})();
</script></body></html>"""

def user_view(row, stats, models=()):
    cost = (stats["prompt_tokens"] or 0) / 1e6 * RATE_IN + (stats["completion_tokens"] or 0) / 1e6 * RATE_OUT
    return {
        "id": row["id"], "email": row["email"], "name": row["name"], "note": row["note"],
        "status": row["status"], "role": (row["role"] if "role" in row.keys() and row["role"] else "user"), "created_at": iso(row["created_at"]),
        "last_seen": iso(row["last_login_at"]) if row["last_login_at"] else None,
        "requests": stats["requests"] or 0, "prompt_tokens": stats["prompt_tokens"] or 0,
        "completion_tokens": stats["completion_tokens"] or 0,
        "total_tokens": stats["total_tokens"] or 0, "cost": round(cost, 6),
        "models": [{"model": m["model"] or "unknown", "requests": m["n"], "prompt_tokens": m["p"] or 0,
                    "completion_tokens": m["c"] or 0, "total_tokens": m["t"] or 0} for m in models],
    }

def admin_email_set():
    with db() as c:
        rows = {r["email"] for r in c.execute("SELECT email FROM admins").fetchall()}
    return rows | set(ADMIN_EMAILS)

def current_model():
    with db() as c:
        row = c.execute("SELECT value FROM settings WHERE key='model'").fetchone()
    value = (row["value"] or "").strip() if row else ""
    return value or PINNED_MODEL

# ---------- http ----------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "BotCamp/1.0"

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    def end_headers(self):
        origin = ""
        try:
            origin = self.headers.get("Origin", "") or ""
        except Exception:
            origin = ""
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("content-length", "0")
        self.end_headers()

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

    def redirect(self, location, status=302):
        self.send_response(status)
        self.send_header("location", location)
        self.send_header("content-length", "0")
        self.end_headers()

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
        if data and data.get("role") == "admin" and data.get("exp", 0) > now():
            return True
        auth = self.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            data = unsign(auth[7:].strip())
            return bool(data and data.get("role") == "admin" and data.get("exp", 0) > now())
        return False

    def relay_identity(self):
        tok = self.cookies().get("botcamp_relay", "")
        data = unsign(tok) if tok else None
        if data and data.get("role") == "relay" and data.get("exp", 0) > now():
            return data
        auth = self.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            data = unsign(auth[7:].strip())
            if data and data.get("role") == "relay" and data.get("exp", 0) > now():
                return data
        return None

    def user_from_token(self, token):
        if not token:
            return None
        h = token_hash(token)
        with db() as c:
            row = c.execute("SELECT * FROM users WHERE token_hash=? AND status='active'", (h,)).fetchone()
            if row is not None:
                return row
            # Long-lived inference key used by a paired device.
            return c.execute("SELECT * FROM users WHERE llm_token=? AND status='active'", (token,)).fetchone()

    def ensure_llm_token(self, conn, uid):
        row = conn.execute("SELECT llm_token FROM users WHERE id=?", (uid,)).fetchone()
        if row is not None and row["llm_token"]:
            return row["llm_token"]
        token = "bc-" + secrets.token_urlsafe(24)
        conn.execute("UPDATE users SET llm_token=? WHERE id=?", (token, uid))
        return token

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
            return self.redirect(SITE_ORIGIN + "/")
        if path == PREFIX + "/admin":
            return self.redirect(SITE_ORIGIN + "/admin/")
        if path == PREFIX + "/healthz":
            return self.send_json({"ok": True, "version": VERSION})
        if path == PREFIX + "/api/relay/devices":
            data = self.relay_identity()
            if not data:
                return self.send_json({"error": "login required"}, 401)
            with db() as c:
                rows = c.execute("SELECT slot, name, platform, updated_at FROM devices WHERE user_id=? ORDER BY slot", (data.get("uid"),)).fetchall()
            return self.send_json({"devices": [{"slot": f"d{r['slot']}", "name": r["name"], "platform": r["platform"],
                                                "online": now() - r["updated_at"] < 180, "last_seen": iso(r["updated_at"])} for r in rows]})
        if path == PREFIX + "/pair":
            return self.send_html(PAIR_HTML)
        if path == PREFIX + "/enter":
            qs = parse_qs(urlparse(self.path).query)
            slot = (qs.get("slot") or [""])[0]
            token = (qs.get("token") or [""])[0]
            if not slot.startswith("d") or not slot[1:].isdigit() or not token:
                return self.send_json({"error": "bad device link"}, 400)
            with db() as c:
                dev = c.execute("SELECT d.slot, d.token, d.user_id, u.status FROM devices d JOIN users u ON u.id=d.user_id WHERE d.slot=?", (int(slot[1:]),)).fetchone()
            if dev is None or not dev["token"] or not hmac.compare_digest(str(dev["token"]), token):
                return self.send_json({"error": "设备链接无效或已过期"}, 403)
            if dev["status"] != "active":
                return self.send_json({"error": "该账号已停用"}, 403)
            cookie = "botcamp_relay=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (sign({"role": "relay", "uid": dev["user_id"], "exp": now() + 7 * 86400}), 7 * 86400)
            self.send_response(302)
            self.send_header("location", f"/desk/d{dev['slot']}/?token={urllib.parse.quote(str(dev['token']), safe='')}")
            self.send_header("set-cookie", cookie)
            self.send_header("cache-control", "no-store")
            self.end_headers()
            return
        if path == PREFIX + "/relay/devices":
            return self.redirect(SITE_ORIGIN + "/desk/")
        if path == PREFIX + "/relay":
            return self.redirect(SITE_ORIGIN + "/login/")
        if path.startswith(PREFIX + "/api/relay/check/"):
            slot = path.rsplit("/", 1)[-1]
            data = self.relay_identity()
            if not data:
                return self.send_json({"ok": False, "error": "login required"}, 401)
            if not slot.startswith("d") or not slot[1:].isdigit():
                return self.send_json({"ok": False, "error": "unknown device"}, 404)
            with db() as c:
                u = c.execute("SELECT id, email FROM users WHERE id=? AND status='active'", (data.get("uid"),)).fetchone()
                dev = c.execute("SELECT * FROM devices WHERE slot=?", (int(slot[1:]),)).fetchone()
            if u is None:
                return self.send_json({"ok": False, "error": "no device access"}, 403)
            if dev is None or dev["user_id"] != u["id"]:
                return self.send_json({"ok": False, "error": "device not yours"}, 403)
            if now() - dev["updated_at"] > 180:
                return self.send_json({"ok": False, "error": "device offline"}, 503)
            return self.send_json({"ok": True})
        if path == PREFIX + "/api/admin/me":
            return self.send_json({"admin": True, "version": VERSION}) if self.is_admin() else self.send_json({"error": "unauthorized"}, 401)
        mdev = re.fullmatch(PREFIX + r"/api/admin/users/(\d+)/devices", path)
        if mdev:
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            uid = int(mdev.group(1))
            with db() as c:
                rows = c.execute("SELECT * FROM devices WHERE user_id=? ORDER BY slot", (uid,)).fetchall()
            return self.send_json({"devices": [{"slot": f"d{r['slot']}", "name": r["name"], "platform": r["platform"],
                                                "online": now() - r["updated_at"] < 180,
                                                "last_seen": iso(r["updated_at"])} for r in rows]})
        if path == PREFIX + "/api/admin/users":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.admin_users()
        if path == PREFIX + "/api/admin/overview":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.admin_overview()
        if path == PREFIX + "/api/admin/dashboard":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.admin_dashboard()
        if path == PREFIX + "/api/admin/admins":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            with db() as c:
                rows = c.execute("SELECT email, created_at FROM admins ORDER BY created_at").fetchall()
            listed = {r["email"] for r in rows}
            return self.send_json({"admins": [{"email": r["email"], "created_at": iso(r["created_at"])} for r in rows] +
                                  [{"email": e, "created_at": None} for e in sorted(ADMIN_EMAILS - listed)]})
        if path == PREFIX + "/api/admin/models":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.admin_models()
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
                c.execute("UPDATE devices SET token=COALESCE(NULLIF(?, ''), token), updated_at=?, online=1 WHERE slot=?", (token, now(), dev["slot"]))
            return self.send_json({"ok": True, "slot": dev["slot"]})
        if path == PREFIX + "/api/devices/pair/start":
            body = self.body_json()
            device_id = str(body.get("device_id") or "").strip()
            if not device_id:
                return self.send_json({"error": "device_id required"}, 400)
            code = "-".join(secrets.token_hex(2).upper() for _ in range(2))
            with db() as c:
                c.execute("DELETE FROM pair_codes WHERE created_at < ?", (now() - 900,))
                c.execute("INSERT OR REPLACE INTO pair_codes(code,device_id,name,platform,status,created_at) VALUES(?,?,?,?,'pending',?)",
                          (code, device_id, str(body.get("name") or "")[:60], str(body.get("platform") or "")[:30], now()))
            return self.send_json({"ok": True, "code": code, "url": f"{PUBLIC_URL}/botcamp/pair?code={code}", "expires_in": 900, "interval": 2})
        if path == PREFIX + "/api/devices/pair/poll":
            body = self.body_json()
            code = str(body.get("code") or "").upper()
            with db() as c:
                row = c.execute("SELECT * FROM pair_codes WHERE code=?", (code,)).fetchone()
                if row is None or now() - row["created_at"] > 900:
                    return self.send_json({"status": "expired"}, 410)
                if row["status"] != "approved":
                    return self.send_json({"status": "pending"})
                dev = c.execute("SELECT slot, secret_hash, user_id FROM devices WHERE device_id=?", (row["device_id"],)).fetchone()
                c.execute("DELETE FROM pair_codes WHERE code=?", (code,))
            if dev is None:
                return self.send_json({"status": "expired"}, 410)
            secret = secrets.token_urlsafe(32)
            with db() as c:
                c.execute("UPDATE devices SET secret_hash=?, updated_at=? WHERE slot=?", (token_hash(secret), now(), dev["slot"]))
            with db() as c:
                llm_token = self.ensure_llm_token(c, dev["user_id"])
            return self.send_json({"status": "approved", "slot": f"d{dev['slot']}", "device_secret": secret, "llm_token": llm_token})
        if path == PREFIX + "/api/devices/pair/approve":
            tok = self.cookies().get("botcamp_relay", "")
            data = unsign(tok) if tok else None
            if not data:
                return self.send_json({"error": "login required"}, 401)
            body = self.body_json()
            code = str(body.get("code") or "").upper()
            with db() as c:
                user = c.execute("SELECT id FROM users WHERE id=? AND status='active'", (data.get("uid"),)).fetchone()
                row = c.execute("SELECT * FROM pair_codes WHERE code=?", (code,)).fetchone()
                if user is None:
                    return self.send_json({"error": "该账号已停用"}, 403)
                if row is None or now() - row["created_at"] > 900:
                    return self.send_json({"error": "配对码已过期"}, 410)
                existing = c.execute("SELECT slot, user_id FROM devices WHERE device_id=?", (row["device_id"],)).fetchone()
                if existing is None:
                    used = {r["slot"] for r in c.execute("SELECT slot FROM devices")}
                    slot = next((i for i in range(1, 11) if i not in used), None)
                    if slot is None:
                        return self.send_json({"error": "设备槽位已满"}, 507)
                    c.execute("INSERT INTO devices(slot,device_id,user_id,name,platform,updated_at) VALUES(?,?,?,?,?,?)",
                              (slot, row["device_id"], user["id"], row["name"], row["platform"], now()))
                else:
                    slot = existing["slot"]
                    c.execute("UPDATE devices SET user_id=?, name=?, platform=?, updated_at=? WHERE slot=?",
                              (user["id"], row["name"], row["platform"], now(), slot))
                self.ensure_llm_token(c, user["id"])
                c.execute("UPDATE pair_codes SET status='approved', slot=? WHERE code=?", (slot, code))
            return self.send_json({"ok": True, "slot": f"d{slot}"})
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
            exp = now() + 7 * 86400
            token = sign({"role": "relay", "uid": u["id"], "exp": exp})
            cookie = "botcamp_relay=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (token, 7 * 86400)
            admin = email in admin_email_set()
            payload = {"ok": True, "token": token, "is_admin": admin,
                       "redirect": SITE_ORIGIN + "/desk/"}
            if admin:
                payload["admin_token"] = sign({"role": "admin", "exp": now() + 12 * 3600})
            return self.send_json(payload, headers={"set-cookie": cookie})
        if path == PREFIX + "/api/relay/go":
            data = self.relay_identity()
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
            return self.send_json({
                "ok": True,
                "redirect": f"/desk/d{dev['slot']}/?token={dev['token']}",
                "site_redirect": f"{SITE_ORIGIN}/desk/d{dev['slot']}/",
            })
        if path == PREFIX + "/api/desk":
            auth = self.headers.get("authorization", "")
            data = unsign(auth[7:].strip()) if auth.lower().startswith("bearer ") else None
            if not data or data.get("role") != "relay" or data.get("exp", 0) <= now():
                return self.send_json({"error": "请先登录"}, 401)
            body = self.body_json()
            slot = str(body.get("slot") or "")
            if not slot.startswith("d") or not slot[1:].isdigit():
                return self.send_json({"error": "设备参数无效"}, 400)
            with db() as c:
                dev = c.execute("SELECT slot, token, updated_at FROM devices WHERE slot=? AND user_id=?", (int(slot[1:]), data.get("uid"))).fetchone()
            if dev is None:
                return self.send_json({"error": "设备不存在或不属于当前账号"}, 403)
            if now() - dev["updated_at"] > 180:
                return self.send_json({"error": "设备离线"}, 503)
            endpoint = str(body.get("endpoint") or "")
            if endpoint not in ("state", "chat", "send", "bots"):
                return self.send_json({"error": "unsupported endpoint"}, 400)
            port = 18765 + int(dev['slot']) - 1
            target = f"http://127.0.0.1:{port}/api/bot"
            try:
                # The device host authenticates browser sessions with its own
                # dsh-auth cookie. Exchange the one-time token carried by the
                # relay heartbeat for that cookie, then call the host API.
                jar = http.cookiejar.CookieJar()
                opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
                opener.open(f"http://127.0.0.1:{port}/?token={urllib.parse.quote(str(dev['token']), safe='')}", timeout=15).read()
                req = urllib.request.Request(target, data=json.dumps({"endpoint": endpoint, "payload": body.get("payload") or {}}).encode(), headers={"content-type": "application/json"}, method="POST")
                with opener.open(req, timeout=30) as r:
                    raw = r.read()
                return self.send_json(json.loads(raw or b"{}"))
            except urllib.error.HTTPError as e:
                raw = e.read()
                try:
                    return self.send_json(json.loads(raw or b"{}"), e.code)
                except Exception:
                    return self.send_json({"error": "设备接口错误"}, 502)
            except Exception as e:
                return self.send_json({"error": f"设备暂不可达: {e}"}, 502)
        if path == PREFIX + "/api/desk/library":
            auth = self.headers.get("authorization", "")
            data = unsign(auth[7:].strip()) if auth.lower().startswith("bearer ") else None
            if not data or data.get("role") != "relay" or data.get("exp", 0) <= now():
                return self.send_json({"error": "请先登录"}, 401)
            body = self.body_json()
            slot = str(body.get("slot") or "")
            if not slot.startswith("d") or not slot[1:].isdigit():
                return self.send_json({"error": "设备参数无效"}, 400)
            with db() as c:
                dev = c.execute("SELECT slot, token, updated_at FROM devices WHERE slot=? AND user_id=?", (int(slot[1:]), data.get("uid"))).fetchone()
            if dev is None or now() - dev["updated_at"] > 180:
                return self.send_json({"error": "设备离线"}, 503)
            port = 18765 + int(dev["slot"]) - 1
            try:
                jar = http.cookiejar.CookieJar()
                opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
                opener.open(f"http://127.0.0.1:{port}/?token={urllib.parse.quote(str(dev['token']), safe='')}", timeout=15).read()
                action = str(body.get("action") or "proxy")
                if action == "proxy":
                    rel = str(body.get("path") or "")
                    if not rel.startswith("/md-reader/") or rel.startswith("/md-reader/raw"):
                        return self.send_json({"error": "文档路径无效"}, 400)
                    method = str(body.get("method") or "GET").upper()
                    if method not in ("GET", "POST"):
                        return self.send_json({"error": "文档方法无效"}, 400)
                    payload = body.get("body")
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}{rel}",
                        data=(json.dumps(payload).encode() if method == "POST" else None),
                        headers={"content-type": "application/json"} if method == "POST" else {},
                        method=method,
                    )
                elif action == "tree":
                    req = urllib.request.Request(f"http://127.0.0.1:{port}/md-reader/tree", method="GET")
                elif action == "read":
                    target = str(body.get("path") or "")
                    req = urllib.request.Request(f"http://127.0.0.1:{port}/md-reader/read", data=json.dumps({"root": "library", "path": target}).encode(), headers={"content-type": "application/json"}, method="POST")
                else:
                    return self.send_json({"error": "unsupported library action"}, 400)
                with opener.open(req, timeout=30) as r:
                    raw = r.read()
                return self.send_json(json.loads(raw or b"{}"))
            except urllib.error.HTTPError as e:
                raw = e.read()
                try:
                    return self.send_json(json.loads(raw or b"{}"), e.code)
                except Exception:
                    return self.send_json({"error": "文档接口错误"}, 502)
            except Exception as e:
                return self.send_json({"error": f"设备暂不可达: {e}"}, 502)
        if path == PREFIX + "/api/account/password":
            d = self.body_json()
            email = (d.get("email") or "").strip().lower()
            current = d.get("current") or ""
            new = d.get("next") or ""
            if len(new) < 8:
                return self.send_json({"error": "新密码至少 8 位"}, 400)
            with db() as c:
                u = c.execute("SELECT id, pw_hash, status FROM users WHERE email=?", (email,)).fetchone()
            if not u or u["status"] != "active" or not check_password(current, u["pw_hash"]):
                return self.send_json({"error": "当前密码不对"}, 401)
            with db() as c:
                c.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(new), u["id"]))
            return self.send_json({"ok": True})
        if path == PREFIX + "/api/login":
            return self.login()
        if path == PREFIX + "/api/admin/admins":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            email = (self.body_json().get("email") or "").strip().lower()
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
                return self.send_json({"error": "需要邮箱格式"}, 400)
            with db() as c:
                u = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
                if u is None:
                    return self.send_json({"error": "先创建这个账号"}, 404)
                c.execute("INSERT OR IGNORE INTO admins(email, created_at) VALUES(?,?)", (email, now()))
            return self.send_json({"ok": True})
        if path == PREFIX + "/api/admin/admins/remove":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            email = (self.body_json().get("email") or "").strip().lower()
            if email in ADMIN_EMAILS:
                return self.send_json({"error": "这个管理员来自服务器环境变量，不能在这里移除"}, 400)
            with db() as c:
                total = c.execute("SELECT COUNT(*) n FROM admins").fetchone()["n"]
                if total <= 1:
                    return self.send_json({"error": "至少保留一个管理员"}, 400)
                c.execute("DELETE FROM admins WHERE email=?", (email,))
            return self.send_json({"ok": True})
        if path == PREFIX + "/api/admin/models":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            model = (self.body_json().get("model") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9._:/-]{2,80}", model):
                return self.send_json({"error": "模型名不合法"}, 400)
            with db() as c:
                c.execute("INSERT INTO settings(key, value) VALUES('model', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (model,))
            return self.send_json({"ok": True, "model": model})
        if path == PREFIX + "/api/admin/login":
            return self.admin_login()
        if path == PREFIX + "/api/admin/logout":
            return self.send_json({"ok": True}, headers={"set-cookie": "botcamp_admin=; Path=/; Max-Age=0"})
        if path == PREFIX + "/api/admin/users":
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.admin_create_user()
        m = re.fullmatch(PREFIX + r"/api/admin/users/(\d+)/role", path)
        if m:
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            body = self.body_json()
            role = str(body.get("role") or "user")
            if role not in ("test", "user", "admin"):
                return self.send_json({"error": "身份不合法"}, 400)
            with db() as c:
                row = c.execute("SELECT id, email FROM users WHERE id=?", (int(m.group(1)),)).fetchone()
                if row is None:
                    return self.send_json({"error": "用户不存在"}, 404)
                email = row["email"].lower()
                if email in ADMIN_EMAILS and role != "admin":
                    return self.send_json({"error": "该管理员来自服务器环境变量，不能在这里降级"}, 400)
                c.execute("UPDATE users SET role=? WHERE id=?", (role, row["id"]))
                if role == "admin":
                    c.execute("INSERT OR IGNORE INTO admins(email, created_at) VALUES(?,?)", (email, now()))
                else:
                    c.execute("DELETE FROM admins WHERE email=?", (email,))
            return self.send_json({"ok": True})
        m = re.fullmatch(PREFIX + r"/api/admin/users/(\d+)/status", path)
        if m:
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            d = self.body_json()
            with db() as c:
                c.execute("UPDATE users SET status=? WHERE id=?", ("active" if d.get("status") == "active" else "disabled", int(m.group(1))))
            return self.send_json({"ok": True})
        m = re.fullmatch(PREFIX + r"/api/admin/users/(\d+)/devices/(d\d+)", path)
        if m:
            if not self.is_admin():
                return self.send_json({"error": "unauthorized"}, 401)
            with db() as c:
                c.execute("DELETE FROM devices WHERE user_id=? AND slot=?", (int(m.group(1)), int(m.group(2)[1:])))
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
        with db() as c:
            llm_token = self.ensure_llm_token(c, u["id"])
        return self.send_json({"token": token, "llm_token": llm_token, "user": {"email": email, "name": u["name"]}})

    def admin_login(self):
        d = self.body_json()
        if not ADMIN_PASSWORD or not hmac.compare_digest(str(d.get("password", "")), ADMIN_PASSWORD):
            return self.send_json({"error": "密码错误"}, 401)
        exp = now() + 12 * 3600
        token = sign({"role": "admin", "exp": exp})
        cookie = "botcamp_admin=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (token, 12 * 3600)
        return self.send_json({"ok": True, "token": token}, headers={"set-cookie": cookie})

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

    def admin_dashboard(self):
        t0 = now() - 86400
        w0 = now() - 7 * 86400
        with db() as c:
            users = c.execute("SELECT COUNT(*) n FROM users").fetchone()["n"]
            today = c.execute("SELECT COUNT(*) r, COALESCE(SUM(total_tokens),0) t FROM usage WHERE ts>=?", (t0,)).fetchone()
            week = c.execute("SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) o FROM usage WHERE ts>=?", (w0,)).fetchone()
            devices = c.execute("SELECT COUNT(*) n FROM devices WHERE updated_at>=?", (now() - 180,)).fetchone()["n"]
            admins = c.execute("SELECT COUNT(*) n FROM admins").fetchone()["n"]
            daily = c.execute("SELECT date(ts,'unixepoch','localtime') d, COUNT(*) r, COALESCE(SUM(total_tokens),0) t FROM usage WHERE ts>=? GROUP BY d ORDER BY d", (now() - 6 * 86400,)).fetchall()
            recent = c.execute("SELECT email, created_at, status FROM users ORDER BY id DESC LIMIT 5").fetchall()
            top = c.execute("SELECT u.email, COUNT(*) r, COALESCE(SUM(x.total_tokens),0) t FROM usage x JOIN users u ON u.id=x.user_id WHERE x.ts>=? GROUP BY x.user_id ORDER BY t DESC LIMIT 5", (w0,)).fetchall()
        cost = week["p"] / 1e6 * RATE_IN + week["o"] / 1e6 * RATE_OUT
        return self.send_json({
            "users": users, "today_requests": today["r"], "today_tokens": today["t"], "week_cost": round(cost, 6),
            "online_devices": devices, "admins": admins, "model": current_model(),
            "daily": [{"day": r["d"], "requests": r["r"], "tokens": r["t"]} for r in daily],
            "recent": [{"email": r["email"], "created_at": iso(r["created_at"]), "status": r["status"]} for r in recent],
            "top": [{"email": r["email"], "requests": r["r"], "tokens": r["t"]} for r in top],
        })

    def admin_models(self):
        with db() as c:
            rows = c.execute("SELECT model, COUNT(*) n, COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) o, COALESCE(SUM(total_tokens),0) t FROM usage GROUP BY model ORDER BY n DESC").fetchall()
        stats = []
        for r in rows:
            cost = r["p"] / 1e6 * RATE_IN + r["o"] / 1e6 * RATE_OUT
            stats.append({"model": r["model"] or "unknown", "requests": r["n"], "prompt_tokens": r["p"],
                          "completion_tokens": r["o"], "total_tokens": r["t"], "cost": round(cost, 6)})
        return self.send_json({"model": current_model(), "default_model": PINNED_MODEL, "stats": stats})

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
                c.execute("INSERT INTO users(email,name,note,pw_hash,created_at,can_desk) VALUES(?,?,?,?,?,1)",
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
        return self.send_json({"object": "list", "data": [{"id": current_model(), "object": "model", "owned_by": "botcamp"}]})

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

        payload["model"] = current_model()
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
