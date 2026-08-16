'use strict';

/**
 * server.js —— 管理 UI HTTP 服务（纯 Node http 模块，零第三方依赖）。
 *
 * 职责：
 *   - 端口 / 监听地址取自 config（UI_PORT=3000 / UI_BIND=0.0.0.0）；
 *   - 会话鉴权：POST /api/login 校验 UI_PASSWORD，签发 httpOnly session cookie
 *     （48 hex 随机 id，内存 Map，24h 过期）；其余 /api/* 均需会话校验，
 *     登录页静态资源（/、/index.html、/app.js）登录前即可访问，
 *     页面内容渲染后由 app.js 拉 /api/* 数据。
 *   - 登录限速：同 IP 1 分钟最多 5 次失败尝试，超限返回 429。
 *   - 数据读写全部经由 store.js（KV）；server 不直接操作浏览器，
 *     启动/停止只写一个控制标记位，由 orchestrator 响应。
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const { validateWindow } = require('./active-window');

// —— store 引用由 main.js 通过 init() 注入 ——
let serverState = null; // { store, log }

function init(deps) {
  serverState = deps || { store: null, log: null };
}

// —— 会话存储（内存，48 hex id，24h 过期） ——
const sessions = new Map(); // id -> { expiresAt }
const SESSION_COOKIE = 'muid';
const SESSION_ID_BYTES = 24; // 24 字节 → 48 hex

// —— 登录限速（按 IP） ——
const loginAttempts = new Map(); // ip -> { count, windowStart }

// —— store 键名约定（与 orchestrator / api-client 对齐，详见 C3-NOTES.md） ——
const KEYS = {
  cookies: 'cookies',               // 网易云 Cookie（MUSIC_U / __csrf）
  credential: 'musicHelperToken',   // 凭证（session token 或 client key，前缀 mh_ck_）
  preference: 'preference',         // short | long | random
  windowStart: 'activeWindowStart',
  windowEnd: 'activeWindowEnd',
  control: 'controlRequest',        // 'start' | 'stop'；orchestrator 消费后清空
  cookiesDirty: 'cookiesDirty',     // true = cookie 变更，orchestrator 需重载页面
  lockedAccount: 'lockedAccount',   // { userId, displayName }
};

// —— 工具 ——
function nowMs() {
  return Date.now();
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : 'unknown';
}

function createSession() {
  const id = crypto.randomBytes(SESSION_ID_BYTES).toString('hex');
  sessions.set(id, { expiresAt: nowMs() + config.sessionTtlMs });
  return id;
}

function sessionFromCookie(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  let sid = null;
  for (const part of cookie.split(';')) {
    const kv = part.trim();
    if (kv.indexOf(SESSION_COOKIE + '=') === 0) {
      sid = kv.slice(SESSION_COOKIE.length + 1);
      break;
    }
  }
  if (!sid) return null;
  const rec = sessions.get(sid);
  if (!rec) return null;
  if (nowMs() > rec.expiresAt) {
    sessions.delete(sid);
    return null;
  }
  return sid;
}

function isAuthed(req) {
  return sessionFromCookie(req) !== null;
}

function destroySession(req, res) {
  const sid = sessionFromCookie(req);
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function rateLimited(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (nowMs() - rec.windowStart >= config.loginRateWindowMs) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= config.loginRateLimit;
}

function recordFailedLogin(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || nowMs() - rec.windowStart >= config.loginRateWindowMs) {
    loginAttempts.set(ip, { count: 1, windowStart: nowMs() });
  } else {
    rec.count += 1;
  }
}

function clearFailedLogin(ip) {
  loginAttempts.delete(ip);
}

// —— HTTP 响应工具 ——
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        overflow = true;
        raw = '';
      }
    });
    req.on('end', () => resolve(overflow ? null : raw));
    req.on('error', () => resolve(null));
  });
}

function parseJSON(raw) {
  if (raw === null || raw === '') return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) {
    return null;
  }
}

// —— 日志尾部 ——
function tailLogs(limit) {
  if (serverState && serverState.log && typeof serverState.log.tail === 'function') {
    return serverState.log.tail(limit);
  }
  return [];
}

function ensureNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCredentialMode(value) {
  const v = String(value || '').trim();
  if (!v) return 'unconfigured';
  return v.startsWith(config.clientKeyPrefix) ? 'key' : 'token';
}

function credentialPreview(value) {
  const v = String(value || '').trim();
  return v ? v.slice(0, 8) : '';
}

// —— 状态汇总（GET /api/status） ——
function buildStatus() {
  const store = serverState && serverState.store;
  if (!store) {
    return {
      running: { browser: false, orchestrator: false },
      account: null,
      task: null,
      today: { helped: 0, received: 0 },
      points: 0,
      credentialMode: 'unconfigured',
      credentialPreview: '',
      cookiePresent: false,
      logs: [],
      activeWindow: { start: '', end: '' },
    };
  }

  const credential = String(store.get(KEYS.credential, '') || '').trim();
  const locked = store.get(KEYS.lockedAccount, null);
  const task = store.get('currentTask', null);
  const runState = store.get('runState', null);

  const running = {
    browser: !!(runState && runState.browser),
    orchestrator: !(runState && runState.orchestrator === false),
  };

  return {
    running,
    account: locked && typeof locked === 'object'
      ? { userId: locked.userId, displayName: locked.displayName }
      : null,
    task: task && typeof task === 'object' && !Array.isArray(task) ? task : null,
    today: {
      helped: ensureNum(store.get('todayHelped', 0)),
      received: ensureNum(store.get('todayReceived', 0)),
    },
    points: ensureNum(store.get('points', 0)),
    credentialMode: normalizeCredentialMode(credential),
    credentialPreview: credentialPreview(credential),
    cookiePresent: !!(String(store.get(KEYS.cookies, '') || '').trim()),
    logs: tailLogs(100),
    activeWindow: {
      start: String(store.get(KEYS.windowStart, '') || '').trim(),
      end: String(store.get(KEYS.windowEnd, '') || '').trim(),
    },
  };
}

// —— POST /api/config ——
function outputOfError(msg) {
  return { status: 400, body: { error: msg } };
}

async function handleConfig(body) {
  if (!serverState || !serverState.store) {
    return { status: 500, body: { error: 'store 未初始化' } };
  }
  const store = serverState.store;
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(body, 'cookies')) {
    const cookies = String(body.cookies || '').trim();
    const prev = String(store.get(KEYS.cookies, '') || '').trim();
    updates[KEYS.cookies] = cookies;
    if (cookies !== prev) updates[KEYS.cookiesDirty] = true;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'credential')) {
    const credential = String(body.credential || '').trim();
    if (credential) {
      if (credential.startsWith(config.clientKeyPrefix)) {
        // key 模式：直接作为长期凭证（无需过期字段，清掉 token 模式残留）
        updates[KEYS.credential] = credential;
        updates.musicHelperAccessExpiresAt = '';
        updates.musicHelperRefreshExpiresAt = '';
      } else {
        // ticket → 走 /api/auth/claim 换 session token（一次性票据，2 分钟内有效）
        const { ApiClient } = require('./api-client');
        const api = new ApiClient(store);
        const result = await api.claimTicket(credential);
        if (!result || !result.ok) {
          return outputOfError('登录票据无效或已过期（ticket 仅 2 分钟内有效）');
        }
        updates[KEYS.credential] = api.credential();
        // claimTicket 内部已写入过期字段（setSessionExpiry）
      }
    } else {
      await store.delete(KEYS.credential);
      await store.delete('musicHelperAccessExpiresAt');
      await store.delete('musicHelperRefreshExpiresAt');
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'preference')) {
    const pref = String(body.preference || '').trim();
    if (!['short', 'long', 'random'].includes(pref)) {
      return outputOfError('preference 必须为 short | long | random');
    }
    updates[KEYS.preference] = pref;
  }

  const hasStart = Object.prototype.hasOwnProperty.call(body, 'windowStart');
  const hasEnd = Object.prototype.hasOwnProperty.call(body, 'windowEnd');
  if (hasStart || hasEnd) {
    const start = String(body.windowStart || '').trim();
    const end = String(body.windowEnd || '').trim();
    const check = validateWindow(start, end);
    if (!check.ok) {
      if (check.spanHours && check.spanHours > config.maxActiveSpanHours) {
        return outputOfError('超过 16 小时上限');
      }
      return outputOfError(check.reason || '活跃窗口配置非法');
    }
    updates[KEYS.windowStart] = start;
    updates[KEYS.windowEnd] = end;
  }

  if (Object.keys(updates).length > 0) {
    await store.setMany(updates);
  }

  return {
    status: 200,
    body: {
      ok: true,
      saved: Object.keys(updates),
      credentialMode: normalizeCredentialMode(
        String(store.get(KEYS.credential, '') || '').trim()
      ),
    },
  };
}

// —— POST /api/control ——
async function handleControl(body) {
  if (!serverState || !serverState.store) {
    return { status: 500, body: { error: 'store 未初始化' } };
  }
  await serverState.store.set(KEYS.control, body.action);
  return { status: 200, body: { ok: true, action: body.action } };
}

// —— POST /api/login ——
async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    sendError(res, 429, '尝试过于频繁，请稍后再试');
    return;
  }

  const raw = await readBody(req);
  const body = parseJSON(raw);
  const password = String((body && body.password) || '');

  if (!password || password !== config.uiPassword) {
    recordFailedLogin(ip);
    sendError(res, 401, '密码错误');
    return;
  }

  clearFailedLogin(ip);
  const sid = createSession();
  const maxAge = Math.floor(config.sessionTtlMs / 1000);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
  sendJSON(res, 200, { ok: true });
}

// —— 静态文件服务 ——
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, pathname) {
  const rel = STATIC_FILES[pathname];
  if (!rel) {
    sendError(res, 404, 'not_found');
    return;
  }
  const full = path.join(PUBLIC_DIR, rel);
  fs.readFile(full, (err, buf) => {
    if (err) {
      sendError(res, 404, 'not_found');
      return;
    }
    const ext = path.extname(rel).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// —— 主请求处理 ——
async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch (e) {
    sendError(res, 400, 'bad_request');
    return;
  }
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // 登录接口（无需会话）
  if (pathname === '/api/login' && method === 'POST') {
    await handleLogin(req, res);
    return;
  }

  // 退出登录（清除会话）
  if (pathname === '/api/logout' && method === 'POST') {
    destroySession(req, res);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // 其余 /api/* 均需会话
  if (pathname.startsWith('/api/')) {
    if (!isAuthed(req)) {
      sendError(res, 401, 'unauthorized');
      return;
    }
    if (pathname === '/api/status' && method === 'GET') {
      sendJSON(res, 200, buildStatus());
      return;
    }
    if (pathname === '/api/config' && method === 'POST') {
      const raw = await readBody(req);
      const body = parseJSON(raw);
      if (body === null) {
        sendError(res, 400, '请求体 JSON 解析失败');
        return;
      }
      const out = await handleConfig(body);
      if (out.body && out.body.error) {
        sendError(res, out.status, out.body.error);
      } else {
        sendJSON(res, out.status, out.body);
      }
      return;
    }
    if (pathname === '/api/control' && method === 'POST') {
      const raw = await readBody(req);
      const body = parseJSON(raw);
      if (body === null) {
        sendError(res, 400, '请求体 JSON 解析失败');
        return;
      }
      const action = String((body && body.action) || '').trim();
      if (action !== 'start' && action !== 'stop') {
        sendError(res, 400, 'action 必须为 start | stop');
        return;
      }
      const out = await handleControl({ action });
      sendJSON(res, out.status, out.body);
      return;
    }
    sendError(res, 404, 'not_found');
    return;
  }

  // 静态资源（登录前即可访问）
  serveStatic(res, pathname);
}

function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      if (!res.writableEnded) sendError(res, 500, 'internal_error');
    });
  });
}

module.exports = {
  init,
  createServer,
  createSession,
  isAuthed,
  buildStatus,
  KEYS,
};
