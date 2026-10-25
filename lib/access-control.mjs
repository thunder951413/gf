// Optional access token for running the service on another machine.
//
// With LIFE_ACCESS_TOKEN unset nothing changes: the service listens on
// 127.0.0.1 and trusts every request that reaches it. With a token set, a
// request that does not come from this machine's loopback interface must carry
// either `Authorization: Bearer <token>` (desktop app, scripts) or the session
// cookie set by /login (browsers). The cookie holds an HMAC of the token, never
// the token itself. A reverse proxy on the same machine would make every request
// look local, so put none in front of the service, or set LIFE_ACCESS_LOCAL=1 to
// require the token for loopback requests too.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'youjian_session';
const LOGIN_WINDOW_MS = 60_000, LOGIN_ATTEMPTS = 6;

export function sessionValue(token) {
  return createHmac('sha256', token).update('youjian-session-v1').digest('hex');
}

const same = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || ''));

function cookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function accessControl(env = process.env, options = {}) {
  const token = options.accessToken ?? env.LIFE_ACCESS_TOKEN ?? '';
  if (token && token.length < 24) throw new Error('LIFE_ACCESS_TOKEN 至少需要 24 个字符');
  const enabled = Boolean(token);
  const requireLocal = (options.accessLocal ?? env.LIFE_ACCESS_LOCAL) === '1' || options.accessLocal === true;
  const expected = enabled ? sessionValue(token) : null;
  const attempts = new Map();

  function authorized(req) {
    if (!enabled) return true;
    if (!requireLocal && loopback(req.socket?.remoteAddress)) return true;
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Bearer ') && same(header.slice(7).trim(), token)) return true;
    // The desktop app sends its own header: URLSession reserves Authorization.
    const desktop = req.headers['x-youjian-token'];
    if (typeof desktop === 'string' && same(desktop.trim(), token)) return true;
    const session = cookie(req.headers.cookie, SESSION_COOKIE);
    return Boolean(session) && same(session, expected);
  }

  function login(req, submitted) {
    const key = String(req.socket?.remoteAddress || 'unknown'), now = Date.now();
    const recent = (attempts.get(key) || []).filter(at => now - at < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_ATTEMPTS) return { ok: false, status: 429 };
    if (!enabled || typeof submitted !== 'string' || !same(submitted.trim(), token)) {
      attempts.set(key, [...recent, now]);
      return { ok: false, status: 401 };
    }
    attempts.delete(key);
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
    return { ok: true, cookie: `${SESSION_COOKIE}=${expected}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}` };
  }

  return { enabled, authorized, login, logoutCookie: `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` };
}

export const LOGIN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>有间 · 登录</title><style>
:root{color-scheme:light dark;--bg:#f6f0e9;--fg:#4b3d44;--muted:#8a7a80;--card:#fffaf4;--line:#e5d9cc;--accent:#9a805f}
@media (prefers-color-scheme:dark){:root{--bg:#1f1b1c;--fg:#eee4dc;--muted:#a99a92;--card:#2a2425;--line:#3b3233;--accent:#c9ab84}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif;padding:16px}
form{width:min(360px,100%);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted);font-size:14px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
output{display:block;min-height:1.6em;margin-top:10px;color:#c0504d;font-size:14px}</style></head>
<body><form id="f"><h1>有间</h1><p>这台服务器设置了访问口令。</p>
<input id="t" type="password" autocomplete="current-password" placeholder="访问口令" required autofocus>
<button>进入</button><output id="o"></output></form>
<script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const o=document.getElementById('o');o.textContent='';
try{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:document.getElementById('t').value})});
if(r.ok){const n=new URLSearchParams(location.search).get('next')||'/';location.replace(n.startsWith('/')&&!n.startsWith('//')?n:'/');return;}
o.textContent=r.status===429?'尝试次数太多，请一分钟后再试。':'口令不对。';}catch{o.textContent='连不上服务器。';}});</script></body></html>`;
