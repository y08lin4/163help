'use strict';

/**
 * api-client.js —— Node 侧互助平台 API 客户端。
 *
 * 职责（供 Node 侧 UI 与状态读取使用，页面核心逻辑仍走 GM_xmlhttpRequest shim 桥接）：
 *   - Bearer + HMAC 签名（复用 signing.js）；
 *   - 凭证模式：session token（含 /api/auth/refresh 30 天滚动续期） / client key（mh_ck_，不 refresh）；
 *   - ticket 领取（/api/auth/claim）；
 *   - /api/me 账号锁定：记录 user_id + 用户名，user_id 变化即报警并停止循环；
 *   - /api/join、/api/next、/api/play/*、/api/ledger 等端点透传。
 */

const config = require('./config');
const { buildSignHeaders, hmacKeyForCredential } = require('./signing');

const TOKEN_KEY = 'musicHelperToken';
const ACCESS_EXPIRES_AT_KEY = 'musicHelperAccessExpiresAt';
const REFRESH_EXPIRES_AT_KEY = 'musicHelperRefreshExpiresAt';
const TOKEN_REFRESH_SKEW_MS = 5000;

class ApiClient {
  /**
   * @param {import('./store').Store} store
   * @param {object} hooks 依赖注入（日志 / 报警 / 状态变更），便于 orchestrator 接线。
   */
  constructor(store, hooks = {}) {
    this.store = store;
    this.hooks = hooks || {};
    this._refreshPromise = null;
  }

  // —— 凭证（session token / client key 二选一） ——
  credential() {
    return String(this.store.get(TOKEN_KEY, '')).trim();
  }

  isKeyMode() {
    return this.credential().startsWith(config.clientKeyPrefix);
  }

  hasCredential() {
    return this.credential().length > 0;
  }

  setCredential(token) {
    this.store.set(TOKEN_KEY, String(token || '').trim());
  }

  clearCredential() {
    this.store.delete(TOKEN_KEY);
    this.store.delete(ACCESS_EXPIRES_AT_KEY);
    this.store.delete(REFRESH_EXPIRES_AT_KEY);
  }

  setSessionExpiry(payload) {
    if (payload && payload.access_expires_at) {
      this.store.set(ACCESS_EXPIRES_AT_KEY, String(payload.access_expires_at));
    }
    if (payload && payload.refresh_expires_at) {
      this.store.set(REFRESH_EXPIRES_AT_KEY, String(payload.refresh_expires_at));
    }
  }

  // —— 账号锁定 ——
  lockedAccount() {
    const locked = this.store.get('lockedAccount', null);
    return locked && typeof locked === 'object' ? locked : null;
  }

  markAccountLocked(userId, displayName) {
    this.store.set('lockedAccount', { userId: String(userId), displayName: String(displayName || '') });
  }

  // token 是否需要续期（key 模式恒 false）
  _tokenNeedsRefresh(force = false) {
    const token = this.credential();
    if (!token) return false;
    if (this.isKeyMode()) return false; // key 模式无需 refresh
    if (force) return true;
    const expiresAt = this._parseStoredTime(ACCESS_EXPIRES_AT_KEY);
    return expiresAt > 0 && Date.now() >= expiresAt - TOKEN_REFRESH_SKEW_MS;
  }

  _parseStoredTime(key) {
    const raw = String(this.store.get(key, '') || '').trim();
    if (!raw) return 0;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  }

  _log(level, message) {
    if (this.hooks.log) this.hooks.log(level, message);
  }

  _alarm(message) {
    if (this.hooks.alarm) this.hooks.alarm(message);
  }

  /**
   * 底层一次 HTTP 请求（带 Bearer + HMAC 签名）。
   * @returns {Promise<{status:number, payload:any}>}
   */
  async _request(method, path, body) {
    const rawBody = body === undefined || body === null ? '' : JSON.stringify(body);
    const url = `${config.apiBase}${path}`;
    const headers = {
      'Authorization': `Bearer ${this.credential()}`,
      'Content-Type': 'application/json',
    };
    Object.assign(headers, buildSignHeaders(method, url, rawBody, this.credential()));

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: rawBody !== '' ? rawBody : undefined,
      });
    } catch (e) {
      return { status: 0, payload: null };
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      payload = null;
    }
    return { status: res.status, payload };
  }

  /**
   * 业务请求：token 模式自动续期 + 401 重试；key 模式直接请求。
   * @returns {Promise<any|null>} 成功返回 payload，失败返回 null。
   */
  async callAPI(method, path, body = null, allowRefreshRetry = true) {
    const token = this.credential();
    if (!token) return null;

    // token 模式到期先续期（key 模式跳过）
    if (!this.isKeyMode() && this._tokenNeedsRefresh()) {
      const refreshed = await this.refreshAccessToken(true);
      if (!refreshed) {
        // 续期失败：永久失效时 refreshAccessToken 内部已 clearCredential + alarm；
        // 网络类临时失败则保留凭证，这里仅记录日志并跳过本次请求（与 401 重试路径告警行为一致）。
        this._log('warn', `token 续期失败，跳过请求 ${method} ${path}`);
        return null;
      }
    }

    const result = await this._request(method, path, body);
    const payload = result.payload;

    if (result.status === 401 && !this.isKeyMode() && allowRefreshRetry) {
      // token 过期：尝试 refresh 后重试一次
      const refreshed = await this.refreshAccessToken(true);
      if (refreshed) return this.callAPI(method, path, body, false);
      return null;
    }

    if (result.status === 401 || result.status === 403) {
      const code = payload && payload.error ? payload.error : (result.status === 401 ? 'invalid_or_expired_token' : 'forbidden');
      this._log('warn', `API ${method} ${path} -> ${result.status} (${code})`);
      this._alarm(`请求被拒绝（${code}）：${method} ${path}`);
      return null;
    }

    if (result.status === 0) return null;
    return payload;
  }

  // —— 认证流程 ——

  /** ticket 换 session token（/api/auth/claim） */
  async claimTicket(ticket) {
    const url = `${config.apiBase}/auth/claim`;
    const rawBody = JSON.stringify({ ticket: String(ticket || '') });
    const headers = {
      'Content-Type': 'application/json',
      'X-Music-Helper-Version': config.version,
      'X-Client-Type': 'docker',
    };
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: rawBody });
    } catch (e) {
      return { ok: false, status: 0, payload: null };
    }
    let payload = null;
    try { payload = await res.json(); } catch (e) { payload = null; }
    if (res.status === 200 && payload && payload.token) {
      this.setCredential(payload.token);
      this.setSessionExpiry(payload);
      return { ok: true, status: res.status, payload };
    }
    return { ok: false, status: res.status, payload };
  }

  /** /api/auth/refresh（仅 token 模式；key 模式直接返回 true） */
  async refreshAccessToken(force = false) {
    if (this.isKeyMode()) return true;
    const token = this.credential();
    if (!token) return false;
    if (!force && !this._tokenNeedsRefresh()) return true;
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = (async () => {
      // refresh 请求体携带原 token（沿用脚本核心逻辑 /auth/refresh 的入参语义）。
      // 网络类错误（status:0 / 5xx）做有限次指数退避重试且不清凭证；
      // 仅明确 401（凭证永久失效）或 403（封禁）才清凭证并告警（提示重新登录）。
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const result = await this._request('POST', '/auth/refresh', { token });
        if (result.status === 200 && result.payload && result.payload.token) {
          this.setCredential(result.payload.token);
          this.setSessionExpiry(result.payload);
          this._log('info', 'session token 已续期');
          return true;
        }
        if (result.status === 401 || result.status === 403) {
          const code = result.payload && result.payload.error
            ? result.payload.error
            : (result.status === 401 ? 'invalid_or_expired_token' : 'forbidden');
          this._log('warn', `续期失败（${result.status} ${code}）：凭证已失效`);
          this.clearCredential();
          this._alarm(`登录态已失效（${code}），请重新粘贴 ticket 或 client key`);
          return false;
        }
        // status:0（网络错误）/ 5xx（服务端临时故障）：保留旧凭证，退避后重试。
        this._log('warn', `续期失败（${result.status}）：网络/服务端临时故障，保留凭证退避重试 ${attempt}/${maxAttempts}`);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
        }
      }
      // 连续网络/5xx 失败：不清凭证，交由下次调用重试。
      return false;
    })();

    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  /**
   * 认证成功后的 /api/me 校验 + 账号锁定。
   * 首次记录 user_id + 用户名；之后 user_id 变化 → 报警并返回 false（调用方停止循环）。
   */
  async verifyAndLockAccount() {
    const me = await this.callAPI('GET', '/me');
    if (!me || !me.user) return false;
    const userId = String(me.user.id != null ? me.user.id : '');
    const displayName = String(me.user.displayName || me.user.username || '');
    const locked = this.lockedAccount();
    if (locked && locked.userId) {
      if (locked.userId !== userId) {
        this._alarm(`账号锁定：user_id 从 ${locked.userId} 变更为 ${userId}，已停止循环`);
        return false;
      }
    } else {
      this.markAccountLocked(userId, displayName);
      this._log('info', `账号已锁定：${displayName} (id=${userId})`);
    }
    return true;
  }

  // —— 状态读取端点（UI 展示） ——
  async me() {
    return this.callAPI('GET', '/me');
  }

  async ledger(params = {}) {
    const qs = new URLSearchParams();
    if (params.type) qs.set('type', params.type);
    if (params.page) qs.set('page', String(params.page));
    if (params.page_size) qs.set('page_size', String(params.page_size));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.callAPI('GET', `/ledger${suffix}`);
  }
}

module.exports = { ApiClient, TOKEN_KEY };
