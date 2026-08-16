'use strict';

/**
 * browser.js —— 无头浏览器与 GM shim 桥接层。
 *
 * 职责（只做浏览器与桥接，不碰 UI/HTTP 服务、不直接写状态，只经 store 或回调）：
 *   - 用 Playwright 启动 Chromium（config.chromiumArgs，headless=new 等）；
 *   - 单 context 单页面，注入网易云 Cookie 后 navigate 到 config.musicHome；
 *   - addInitScript 预注入 GM API shim（GM_getValue / GM_setValue / GM_addStyle /
 *     GM_xmlhttpRequest / GM_deleteValue），把页面与 Node 侧 fetch 桥接起来；
 *   - 页面加载后注入 helper-core.js（先读文件内容 evaluate，再触发其自举）；
 *   - cookie / 配置变更重载（带 10 秒防抖）；进程崩溃检测（disconnected → 回调）。
 *
 * 依赖注入：构造时传入 { store, config, log }（log 形如 main.js 的 { push, tail }）。
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

// —— 与 helper-core.js / api-client.js / server.js 对齐的固化键名 ——
const KEYS = {
  TOKEN_KEY: 'musicHelperToken',                 // 凭证（session token 或 client key，mh_ck_ 前缀为 key 模式）
  LEGACY_TOKEN_KEY: 'linuxDoToken',              // 旧版凭证，helper-core 会置空
  ACCESS_EXPIRES_AT_KEY: 'musicHelperAccessExpiresAt',   // key 模式应设为空串
  REFRESH_EXPIRES_AT_KEY: 'musicHelperRefreshExpiresAt', // key 模式应设为空串
  RISK_ACCEPTED_KEY: 'musicHelperRiskAcceptedV1',        // '1' = 已接受风险声明
  ERROR_KEY: 'musicHelperLastError',
  MY_MUSIC_LIST: 'myMusicList',
  PREFERENCE: 'myPreference',                    // 页内偏好键（short|long|random）
  AUTO_START: 'autoStart',                       // '1' = 页面加载后自动开启
};
exports.KEYS = KEYS;

// 活跃窗口拦截的响应体（返回 429，与 helper-core 对 429 的处理对齐）。
const OUTSIDE_WINDOW_BODY = JSON.stringify({ error: 'outside_active_window' });

/**
 * 解析用户粘贴的网易云 Cookie 字符串（"MUSIC_U=...; __csrf=..."）为
 * Playwright context.addCookies 所需的数组。domain 统一落到 .163.com 与
 * music.163.com（同时写两者，兼容主 domain 与子域）。
 * @param {string} cookieStr
 * @returns {Array<{name:string,value:string,domain:string,path:string}>}
 */
function parseCookieString(cookieStr) {
  const raw = String(cookieStr || '').trim();
  if (!raw) return [];
  const out = [];
  const domains = ['.163.com', 'music.163.com'];
  for (const part of raw.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;                 // 无等号或空 name 跳过
    const name = seg.slice(0, eq).trim();
    let value = seg.slice(eq + 1).trim();
    // 去掉可能粘进来的引号
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }
    if (!name) continue;
    for (const domain of domains) {
      out.push({ name, value, domain, path: '/' });
    }
  }
  return out;
}

class Browser {
  /**
   * @param {{store: object, config?: object, log?: object, requestHook?: Function}} deps
   *   store: 具备 get/set/setMany/delete/all 的 Store 实例；
   *   config: config.js 导出（可选，缺省 require）；
   *   log: { push(level, msg) } 可选；
   *   requestHook: 可选，每笔 GM_xmlhttpRequest 转发前调用 (details) => truthy 表示拦截，
   *                返回 { status:number, responseText:string }（如活跃窗口 429 拦截）。
   */
  constructor(deps = {}) {
    this.store = deps.store;
    this.config = deps.config || require('./config');
    this.log = deps.log || { push() {} };
    this.requestHook = deps.requestHook || null;

    this.browser = null;
    this.context = null;
    this.page = null;
    this.onDisconnect = null;      // 进程崩溃回调（由 orchestrator 设置）
    this.onCookieChanged = null;   // 可选：页面内 GM 写回 cookie 不触发
    this._closed = false;
    this._reloadTimer = null;
    this._lastReloadAt = 0;
    this._helperCorePath = path.join(__dirname, 'helper-core.js');
    this._helperCoreSource = null; // 惰性读取并缓存
    this._reloadSeq = 0;           // 重载代次，用于丢弃过期快照写回
  }

  _log(level, msg) {
    try { this.log.push(level, msg); } catch (e) { /* 忽略 */ }
  }

  /** 读取并缓存 helper-core.js 源文本。 */
  _helperCore() {
    if (this._helperCoreSource == null) {
      try {
        this._helperCoreSource = fs.readFileSync(this._helperCorePath, 'utf8');
      } catch (e) {
        this._log('error', '读取 helper-core.js 失败：' + e.message);
        return null;
      }
    }
    return this._helperCoreSource;
  }

  /** 从 Node store 组装页内 __gmStore 预载快照（key 模式时 ACCESS/REFRESH 置空串）。 */
  _buildGmStore() {
    const store = this.store;
    const cred = String(store.get(KEYS.TOKEN_KEY, '') || '').trim();
    const isKey = cred.startsWith(this.config.clientKeyPrefix);
    const cfg = this.config;

    const snapshot = {};
    // 所有 GM 存储键都从 store 透传到页内
    const kv = store.all ? store.all() : {};
    for (const k of Object.keys(kv)) {
      if (kv[k] !== undefined && k !== 'cookies') {
        snapshot[k] = kv[k];
      }
    }
    // 凭证三件套：优先显式覆盖，保证 key 模式 ACCESS/REFRESH 为空串
    snapshot[KEYS.TOKEN_KEY] = cred;
    snapshot[KEYS.LEGACY_TOKEN_KEY] = '';
    if (isKey) {
      snapshot[KEYS.ACCESS_EXPIRES_AT_KEY] = '';
      snapshot[KEYS.REFRESH_EXPIRES_AT_KEY] = '';
    } else {
      snapshot[KEYS.ACCESS_EXPIRES_AT_KEY] = String(store.get(KEYS.ACCESS_EXPIRES_AT_KEY, '') || '');
      snapshot[KEYS.REFRESH_EXPIRES_AT_KEY] = String(store.get(KEYS.REFRESH_EXPIRES_AT_KEY, '') || '');
    }
    // 偏好：统一以 store 的 preference 为源，映射到页内 myPreference
    const pref = String(store.get('preference', cfg.preference) || cfg.preference).trim();
    snapshot[KEYS.PREFERENCE] = pref;
    // 自动开启 + 风险声明：常驻客户端恒开启
    snapshot[KEYS.AUTO_START] = '1';
    snapshot[KEYS.RISK_ACCEPTED_KEY] = '1';
    // 歌单：store 里可能存的是 JSON 字符串，原样透传（helper-core 自行 parse）
    if (store.get(KEYS.MY_MUSIC_LIST, null) != null) {
      snapshot[KEYS.MY_MUSIC_LIST] = String(store.get(KEYS.MY_MUSIC_LIST, ''));
    }
    return snapshot;
  }

  /**
   * addInitScript 注入的 GM shim 源文本。在浏览器内定义：
   *   window.__gmStore（预载快照）、GM_getValue/GM_setValue/GM_addStyle/GM_deleteValue、
   *   GM_xmlhttpRequest（桥接 window.__bridge.request）、可选 window.__bridge.log/status。
   * __bridge 通过 exposeFunction 由 Node 侧暴露。
   */
  _gmShimSource(snapshot) {
    // 序列化快照安全注入（避免 </script> 破坏，helper-core 非 html 上下文，但仍做转义）。
    const snapshotJson = JSON.stringify(snapshot || {}).replace(/</g, '\\u003c');
    return `(function(){
  'use strict';
  var __gmStore = window.__gmStore = ${snapshotJson};
  var __bridge = (typeof window.__bridge === 'object' && window.__bridge) ? window.__bridge : null;

  function GM_getValue(key, def) {
    var k = String(key);
    if (Object.prototype.hasOwnProperty.call(__gmStore, k) && __gmStore[k] !== undefined) {
      return __gmStore[k];
    }
    return (def === undefined ? undefined : def);
  }
  function GM_setValue(key, value) {
    var k = String(key);
    __gmStore[k] = value;
    if (__bridge && typeof __bridge.set === 'function') {
      try { __bridge.set(k, value); } catch (e) {}
    }
  }
  function GM_deleteValue(key) {
    var k = String(key);
    delete __gmStore[k];
    if (__bridge && typeof __bridge.set === 'function') {
      try { __bridge.set(k, null); } catch (e) {}
    }
  }
  function GM_addStyle(css) { /* 空操作：无头环境不需要注入样式 */ }

  // GM_xmlhttpRequest：details { method,url,headers,data,timeout,onload,onerror,ontimeout }
  function GM_xmlhttpRequest(details) {
    details = details || {};
    var bridge = (typeof window.__bridge === 'object' && window.__bridge) ? window.__bridge : null;
    if (!bridge || typeof bridge.request !== 'function') {
      // 无桥接时保守 fallback：走原生 fetch（受 CORS，但与禁用场景一致）
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to = details.timeout ? setTimeout(function(){ if(ctrl) ctrl.abort(); }, details.timeout) : null;
      var p = fetch(details.url, {
        method: details.method || 'GET',
        headers: details.headers || {},
        body: details.data || undefined,
        signal: ctrl ? ctrl.signal : undefined
      });
      if (to) { p = p.finally(function(){ clearTimeout(to); }); }
      return p.then(function(res){
        return res.text().then(function(txt){
          if (details.onload) {
            var hdrs = {};
            try { res.headers.forEach(function(v,k){ hdrs[k]=v; }); } catch(e){}
            details.onload({ status: res.status, statusText: res.statusText,
              responseText: txt, responseHeaders: hdrs, finalUrl: details.url });
          }
        });
      }).catch(function(err){
        if (to && err && err.name === 'AbortError') { if (details.ontimeout) details.ontimeout(); }
        else if (details.onerror) details.onerror();
      });
    }

    // 主路径：Node 侧 fetch 转发（无 CORS）。AbortController 由 Node 侧按 timeout 处理。
    var payload = {
      method: (details.method || 'GET').toUpperCase(),
      url: details.url,
      headers: details.headers || {},
      data: details.data || '',
      timeout: details.timeout || 0
    };
    return bridge.request(payload).then(function(result){
      var r = result || {};
      // Node 侧已按 status 归类：status>=200&&<600 视为 onload；超时/网络错误已映射到 ok:false + reason
      if (r.status !== undefined && r.status !== null && r.status >= 200 && r.status < 600) {
        if (details.onload) {
          details.onload({
            status: r.status,
            statusText: r.statusText || '',
            responseText: r.responseText || '',
            responseHeaders: r.responseHeaders || {},
            finalUrl: r.finalUrl || details.url
          });
        }
      } else if (r.reason === 'timeout') {
        if (details.ontimeout) details.ontimeout();
        else if (details.onerror) details.onerror();
      } else {
        if (details.onerror) details.onerror();
      }
    }).catch(function(){
      if (details.onerror) details.onerror();
    });
  }

  // 暴露到全局（helper-core 以全局变量方式引用，且在其 IIFE 内引用外部 GM_*）
  window.GM_getValue = GM_getValue;
  window.GM_setValue = GM_setValue;
  window.GM_deleteValue = GM_deleteValue;
  window.GM_addStyle = GM_addStyle;
  window.GM_xmlhttpRequest = GM_xmlhttpRequest;
})();`;
  }

  /** 启动浏览器 + context + page，注入 shim 与 helper-core。 */
  async launch() {
    if (this._closed) throw new Error('browser 已关闭');
    this._log('info', '正在启动 Chromium…');
    this.browser = await chromium.launch({
      headless: true,
      args: this.config.chromiumArgs,
    });
    // disconnected = 浏览器进程崩溃/被关闭，通知 orchestrator。
    this.browser.on('disconnected', () => {
      this._log('error', '浏览器进程已断开（disconnected）');
      this.page = null;
      this.context = null;
      if (typeof this.onDisconnect === 'function') {
        try { this.onDisconnect(); } catch (e) { /* 忽略 */ }
      }
    });

    await this._openContextAndPage();
    return this;
  }

  async _openContextAndPage() {
    if (!this.browser) throw new Error('browser 未启动');
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();

    // headless 下页面可能弹出 confirm/alert（如 saveSongs 的 window.confirm），
    // 不接听会阻塞页面——统一自动 dismiss，避免互助主循环卡死。
    this.page.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); });

    // 1) 预注入 GM shim（每次 navigation 前都会注入，因 addInitScript 作用于此 context）
    const snapshot = this._buildGmStore();
    await this.context.addInitScript(this._gmShimSource(snapshot));

    // 2) exposeFunction 暴露 __bridge（Node 侧函数 → 页内 window.__bridge.*）
    await this._exposeBridge();

    // 3) 注入 Cookie 并 navigate
    await this.reload();
  }

  async _exposeBridge() {
    const self = this;
    // request(payload) -> Promise<{status,statusText,responseText,responseHeaders,finalUrl} | {reason:'timeout'} | {reason:'error'}>
    await this.context.exposeFunction('__gmBridgeRequest', async (payload) => {
      return self._handleRequest(payload || {});
    });
    await this.context.exposeFunction('__gmBridgeSet', (key, value) => {
      self._handleStoreWrite(key, value);
    });
    await this.context.exposeFunction('__gmBridgeLog', (msg) => {
      self._log('info', '[page] ' + String(msg));
    });
    await this.context.exposeFunction('__gmBridgeStatus', (obj) => {
      try {
        if (obj && typeof obj === 'object') {
          self.store.set('runStatus', obj);
        }
      } catch (e) { /* 忽略 */ }
    });
    // 页内 window.__bridge 对象（shim 通过 window.__bridge.set/request 访问；
    // 也可直接 window.__bridge.log/status）。
    await this.context.addInitScript(`(function(){
      window.__bridge = {
        request: function(p){ return window.__gmBridgeRequest(p); },
        set: function(k,v){ if (window.__gmBridgeSet) window.__gmBridgeSet(k,v); },
        log: function(m){ if (window.__gmBridgeLog) window.__gmBridgeLog(m); },
        status: function(o){ if (window.__gmBridgeStatus) window.__gmBridgeStatus(o); }
      };
    })();`);
  }

  /** Node 侧：GM_setValue 写回（fire-and-forget 持久化到 store，回写 __gmStore 由 shim 已做）。 */
  async _handleStoreWrite(key, value) {
    try {
      const k = String(key);
      if (value === null) {
        await this.store.delete(k);
      } else {
        await this.store.set(k, value);
      }
    } catch (e) {
      this._log('warn', 'GM_setValue 持久化失败：' + e.message);
    }
  }

  /** Node 侧：GM_xmlhttpRequest 的实际转发（fetch，无 CORS）。 */
  async _handleRequest(payload) {
    const method = String(payload.method || 'GET').toUpperCase();
    const url = String(payload.url || '');
    const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
    const data = payload.data != null ? String(payload.data) : '';
    const timeout = Number(payload.timeout) || 0;

    // 1) 可选拦截（活跃窗口：/api/next 且窗口外 → 429）
    if (typeof this.requestHook === 'function') {
      const intercepted = this.requestHook({ method, url, headers, data, timeout });
      if (intercepted) {
        return {
          status: intercepted.status != null ? intercepted.status : 429,
          statusText: '',
          responseText: intercepted.responseText != null ? String(intercepted.responseText) : OUTSIDE_WINDOW_BODY,
          responseHeaders: {},
          finalUrl: url,
        };
      }
    }

    // 2) fetch 转发 + AbortController 实现 timeout
    const controller = new AbortController();
    let timer = null;
    if (timeout > 0) {
      timer = setTimeout(() => controller.abort(), timeout);
    }
    try {
      const fetchHeaders = {};
      for (const k of Object.keys(headers)) {
        if (headers[k] !== undefined && headers[k] !== null) fetchHeaders[k] = String(headers[k]);
      }
      const init = {
        method,
        headers: fetchHeaders,
        signal: controller.signal,
      };
      if (method !== 'GET' && method !== 'HEAD' && data !== '') {
        init.body = data;
      }
      const res = await fetch(url, init);
      const text = await res.text();
      const respHeaders = {};
      if (res.headers && typeof res.headers.forEach === 'function') {
        res.headers.forEach((v, k) => { respHeaders[k] = v; });
      }
      return {
        status: res.status,
        statusText: res.statusText || '',
        responseText: text,
        responseHeaders: respHeaders,
        finalUrl: res.url || url,
      };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return { reason: 'timeout' };
      }
      return { reason: 'error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 注入 helper-core.js（读取文件内容 evaluate）。 */
  async injectHelperCore() {
    if (!this.page) throw new Error('页面未就绪');
    const src = this._helperCore();
    if (!src) return false;
    await this.page.evaluate((code) => {
      // 以 <script> 方式执行，贴近油猴脚本加载语义（helper-core 是 IIFE）。
      const script = document.createElement('script');
      script.textContent = code;
      (document.head || document.documentElement).appendChild(script);
    }, src);
    this._log('info', 'helper-core 已注入');
    return true;
  }

  /**
   * 注入 cookie 并导航/重载（首次 = navigate，之后 = reload）。
   * 带 10 秒防抖：连续调用只执行最后一次实际导航。
   * @param {boolean} [reload] 若为 true 则始终 reload（配置变更/显式重载）。
   */
  async reload(reload = false) {
    if (!this.page) throw new Error('页面未就绪');
    const cookies = this._currentCookies();
    this._reloadSeq += 1;
    const seq = this._reloadSeq;

    await this.context.clearCookies();
    if (cookies.length) {
      await this.context.addCookies(cookies);
    }

    if (reload) {
      await this.page.reload({ waitUntil: 'domcontentloaded' });
    } else {
      // 首次：navigate 到首页
      await this.page.goto(this.config.musicHome, { waitUntil: 'domcontentloaded' });
    }
    await this.injectHelperCore();
    this._lastReloadAt = Date.now();
  }

  /** 请求重载（带 10 秒防抖，供 orchestrator 在配置/cookie 变更时调用）。 */
  scheduleReload() {
    const now = Date.now();
    if (this._reloadTimer) return; // 已有待执行
    const wait = Math.max(0, 10000 - (now - this._lastReloadAt));
    this._reloadTimer = setTimeout(async () => {
      this._reloadTimer = null;
      if (this._closed || !this.page) return;
      try {
        await this.reload(true);
      } catch (e) {
        this._log('warn', '重载失败：' + e.message);
      }
    }, wait);
  }

  _currentCookies() {
    const raw = String(this.store.get('cookies', '') || '').trim();
    return parseCookieString(raw);
  }

  /** 优雅关闭。 */
  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    try {
      if (this.page) { await this.page.close().catch(() => {}); this.page = null; }
    } catch (e) { /* 忽略 */ }
    try {
      if (this.context) { await this.context.close().catch(() => {}); this.context = null; }
    } catch (e) { /* 忽略 */ }
    try {
      if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
    } catch (e) { /* 忽略 */ }
    this._log('info', '浏览器已关闭');
  }
}

module.exports = {
  Browser,
  parseCookieString,
};
