'use strict';

/**
 * orchestrator.js —— 生命周期编排器。
 *
 * 职责（只做编排与状态，不碰 UI/HTTP 服务；状态只经 store 共享）：
 *   - start()：读 config/store → 启动 browser（失败重试 ≤3 次、间隔 10s）→ 启动 60s 轮询；
 *   - 绑定账号锁定：凭证就绪后 /api/me 拿 user id + 昵称存 store；之后每次轮询比对，
 *     user id 变化 → 置停止标记、日志 ALERT、UI 可见告警（runState/locked + log）；
 *   - 轮询：/api/me + /api/ledger 写「今日帮了/被助/积分」；同步活跃窗口与配置变更
 *     （cookie → 重载页面；preference → 写回 store，reload 生效）；
 *   - start/stop 意图：读 store.controlRequest（server.js 写入）→ start 启动浏览器 /
 *     stop 直接 closeBrowser 不再重启；
 *   - 进程级日志：全部关键动作写 store 日志（带时间戳，经 log 注入）。
 *
 * 与 server.js 接口约定详见 C2-NOTES.md。
 */

const config = require('./config');
const { Browser, parseCookieString, KEYS: BROWSER_KEYS } = require('./browser');
const { ApiClient, TOKEN_KEY } = require('./api-client');
const { isWithinWindow } = require('./active-window');

// —— 与 server.js KEYS / api-client 对齐的键名 ——
const KEYS = {
  control: 'controlRequest',        // 'start' | 'stop'
  cookies: 'cookies',
  cookiesDirty: 'cookiesDirty',
  pageReloadDirty: 'pageReloadDirty',
  preference: 'preference',         // short | long | random（store 层键）
  windowStart: 'activeWindowStart',
  windowEnd: 'activeWindowEnd',
  runState: 'runState',             // { browser:bool, orchestrator:bool }
  currentTask: 'currentTask',
  todayHelped: 'todayHelped',
  todayReceived: 'todayReceived',
  points: 'points',
  lockedAccount: 'lockedAccount',
};
exports.KEYS = KEYS;

const POLL_INTERVAL_MS = 60 * 1000;
const START_RETRY_MAX = 3;
const START_RETRY_DELAY_MS = 10 * 1000;

class Orchestrator {
  constructor(deps) {
    this.store = deps.store;
    this.log = deps.log || { push() {} };
    this.config = deps.config || config;

    this.browser = null;
    this.api = new ApiClient(this.store, {
      log: (level, msg) => this._log(level, msg),
      alarm: (msg) => this._alarm(msg),
    });
    this._pollTimer = null;
    this._stopRequested = false;
    this._reconnecting = false;     // 崩溃自动重连防抖标志（P23）
    this._reconnectTimer = null;    // P23 自动重连定时器句柄（stop/关闭时可取消）
    this._lockChecked = false;      // 是否已完成首次 /api/me 账号锁定
    this._lastPrefSnapshot = null;
    this._lastCookieSnapshot = null;
    this._lastTokenSnapshot = null;
    this._lastStatsSnap = '';
  }

  _log(level, msg) {
    // 统一带时间戳（level 由 log 层自行加 ts，这里补充语义标记）
    const line = '[' + level + '] ' + msg;
    try { this.log.push(level, msg); } catch (e) { /* 吞 */ }
    // 关键告警打 stderr（ALERT）
    if (level === 'error' || level === 'alert') {
      try { console.error('[orchestrator] ' + msg); } catch (e) { /* 吞 */ }
    }
  }

  _alarm(msg) {
    this._log('alert', 'ALERT: ' + msg);
    try { this.store.set('uiAlert', { ts: Date.now(), message: msg }); } catch (e) { /* 吞 */ }
  }

  async _setRunState(patch) {
    const cur = this.store.get(KEYS.runState, null) || {};
    if (typeof cur !== 'object' || Array.isArray(cur)) {
      await this.store.set(KEYS.runState, Object.assign({ browser: false, orchestrator: true }, patch));
    } else {
      await this.store.set(KEYS.runState, Object.assign({}, cur, patch));
    }
  }

  /**
   * start() 主入口（main.js 调用 orchestrator.start({ store, log })）。
   * @param {{store?:object, log?:object}} deps 可选，缺省用构造注入。
   */
  async start(deps) {
    if (deps) {
      if (deps.store) this.store = deps.store;
      if (deps.log) this.log = deps.log;
      this.api = new ApiClient(this.store, {
        log: (l, m) => this._log(l, m),
        alarm: (m) => this._alarm(m),
      });
    }
    this._stopRequested = false;
    await this._setRunState({ orchestrator: true, browser: false });

    // 消费遗留 stop 意图（幂等启动）
    const pending = this.store.get(KEYS.control, null);
    if (pending === 'stop') {
      this._stopRequested = true;
      await this.store.delete(KEYS.control);
      this._log('info', '存在遗留 stop 意图，本次不启动浏览器');
      await this._setRunState({ orchestrator: false, browser: false });
      this._startPolling(); // 仍轮询，等待后续 start 意图
      return;
    }
    if (pending === 'start') await this.store.delete(KEYS.control);

    // 记录初始快照，供轮询检测变更
    this._lastCookieSnapshot = String(this.store.get(KEYS.cookies, '') || '').trim();
    this._lastPrefSnapshot = String(this.store.get(KEYS.preference, this.config.preference) || '').trim();
    this._lastTokenSnapshot = String(this.store.get(TOKEN_KEY, '') || '').trim();

    await this._startBrowserWithRetry();
    this._startPolling();
  }

  async _startBrowserWithRetry() {
    if (this.browser && this.browser.browser) return; // 已在运行
    for (let attempt = 1; attempt <= START_RETRY_MAX; attempt++) {
      if (this._stopRequested) break;
      try {
        this.browser = new Browser({
          store: this.store,
          config: this.config,
          log: this.log,
          requestHook: (details) => this._activeWindowHook(details),
        });
        this.browser.onDisconnect = () => {
          this._log('error', '浏览器进程崩溃，标记浏览器未运行');
          this.browser = null; // P23：清掉死实例引用，允许后续 _startBrowserWithRetry 重建
          this._setRunState({ browser: false }).catch(() => {});
          this._scheduleReconnect();
        };
        await this.browser.launch();
        await this._setRunState({ browser: true });
        if (attempt > 1) this._log('info', 'Chromium 已启动（第 ' + attempt + ' 次尝试）');
        return;
      } catch (e) {
        this._log('warn', '浏览器启动失败（尝试 ' + attempt + '/' + START_RETRY_MAX + '）：' + (e && e.message ? e.message : e));
        if (attempt < START_RETRY_MAX && !this._stopRequested) {
          await new Promise((r) => setTimeout(r, START_RETRY_DELAY_MS));
        }
      }
    }
    await this._setRunState({ browser: false });
    this._alarm('浏览器启动连续失败 ' + START_RETRY_MAX + ' 次，已放弃');
  }

  /** 浏览器崩溃后自动重连（P23）：延迟重试，受 stop 意图与并发保护。 */
  _scheduleReconnect() {
    if (this._stopRequested || this._reconnecting) return;
    this._reconnecting = true;
    this._log('info', '浏览器已崩溃，安排自动重连');
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      this._reconnecting = false;
      if (this._stopRequested) return;
      await this._startBrowserWithRetry();
    }, START_RETRY_DELAY_MS);
  }

  /** 取消待执行的自动重连（stop/关闭时调用，避免 stop 后定时器抢跑复活浏览器）。 */
  _cancelReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnecting = false;
  }

  /**
   * 活跃窗口拦截：仅拦截「领取新任务」的 /api/next（窗口外返回 429 语义）。
   * 返回 { status, responseText } 表示拦截；返回 null 表示放行。
   */
  _activeWindowHook(details) {
    try {
      const url = String(details.url || '');
      if (!/\/api\/next(\?|$)/.test(url)) return null;
      const start = String(this.store.get(KEYS.windowStart, '') || '').trim();
      const end = String(this.store.get(KEYS.windowEnd, '') || '').trim();
      if (isWithinWindow(start, end)) return null;
      return { status: 429, responseText: JSON.stringify({ error: 'outside_active_window' }) };
    } catch (e) {
      return null;
    }
  }

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      this._poll().catch((e) => {
        this._log('warn', '轮询异常：' + (e && e.message ? e.message : e));
      });
    }, POLL_INTERVAL_MS);
  }

  async _poll() {
    // 1) 消费 start/stop 意图（server.js 写入 controlRequest）
    const intent = this.store.get(KEYS.control, null);
    if (intent === 'stop') {
      await this.store.delete(KEYS.control);
      this._stopRequested = true;
      this._cancelReconnect();
      this._log('info', '收到 stop 意图：关闭浏览器并停止循环');
      await this._stopBrowser();
      await this._setRunState({ orchestrator: false, browser: false });
      return;
    }
    if (intent === 'start') {
      await this.store.delete(KEYS.control);
      this._stopRequested = false;
      if (!this.browser || !this.browser.browser) {
        this._log('info', '收到 start 意图：启动浏览器');
        await this._startBrowserWithRetry();
      }
      await this._setRunState({ orchestrator: true });
    }

    if (this._stopRequested) {
      // 已停止，但仍保留轮询等待后续 start；此处不再做业务。
      return;
    }

    // 2) 配置变更检测 → cookie / 偏好 / 凭证变更重载页面
    const cookieNow = String(this.store.get(KEYS.cookies, '') || '').trim();
    const prefNow = String(this.store.get(KEYS.preference, this.config.preference) || '').trim();
    const tokenNow = String(this.store.get(TOKEN_KEY, '') || '').trim();
    const reloadDirty = !!this.store.get(KEYS.pageReloadDirty, false);
    if (this.store.get(KEYS.cookiesDirty, false) || cookieNow !== this._lastCookieSnapshot) {
      await this.store.delete(KEYS.cookiesDirty);
      this._lastCookieSnapshot = cookieNow;
      this._log('info', '检测到 cookie 变更，安排重载页面');
      if (this.browser && this.browser.browser) this.browser.scheduleReload();
    }
    if (prefNow !== this._lastPrefSnapshot) {
      this._lastPrefSnapshot = prefNow;
      this._log('info', '检测到偏好变更（' + prefNow + '），安排重载页面生效');
      if (this.browser && this.browser.browser) this.browser.scheduleReload();
    }
    if (reloadDirty || tokenNow !== this._lastTokenSnapshot) {
      if (reloadDirty) await this.store.delete(KEYS.pageReloadDirty);
      this._lastTokenSnapshot = tokenNow;
      this._log('info', '检测到密钥/凭证变更，安排重载页面生效');
      if (this.browser && this.browser.browser) this.browser.scheduleReload();
    }

    // 3) 账号锁定与状态拉取
    if (this.api.hasCredential()) {
      await this._lockAccountCheck();
      await this._refreshStats();
    }
  }

  /** 首次 /api/me 锁定账号；仅 user_id 变化才停止。网络失败保持运行。 */
  async _lockAccountCheck() {
    const result = await this.api.verifyAndLockAccount();
    if (result && result.ok) {
      this._lockChecked = true;
      return;
    }
    if (result && result.reason === 'mismatch') {
      this._log('error', '账号校验失败（user_id 变化），停止循环');
      this._stopRequested = true;
      this._cancelReconnect();
      await this._stopBrowser();
      await this._setRunState({ orchestrator: false, browser: false });
      return;
    }
    this._log('warn', '账号校验暂时失败（网络或空响应），保持运行并下轮重试');
  }

  /** 拉取 /api/me，把今日帮了/被助/积分写入 store（字段与服务端 /api/me 对齐）。 */
  async _refreshStats() {
    try {
      const me = await this.api.me();
      if (me && me.user) {
        if (this.store.get(KEYS.lockedAccount, null) == null) {
          // 兜底写入锁定信息（me.user.id 为 Linux.do id，稳定且唯一）
          const uid = String(me.user.id != null ? me.user.id : '');
          const name = String(me.user.displayName || me.user.username || '');
          this.api.markAccountLocked(uid, name);
        }
        // 服务端字段：participant.today_helped_count / today_received_help_count /
        // available_credits（credits 兜底）；ledger 端点无 points 字段，不再用它。
        if (me.participant) {
          const upd = {};
          if (me.participant.today_helped_count != null) upd[KEYS.todayHelped] = Number(me.participant.today_helped_count) || 0;
          if (me.participant.today_received_help_count != null) upd[KEYS.todayReceived] = Number(me.participant.today_received_help_count) || 0;
          const credits = me.participant.available_credits != null ? me.participant.available_credits : me.participant.credits;
          if (credits != null) upd[KEYS.points] = Number(credits) || 0;
          if (Object.keys(upd).length) await this.store.setMany(upd);
          const helped = Number(me.participant.today_helped_count) || 0;
          const received = Number(me.participant.today_received_help_count) || 0;
          const pts = Number(credits) || 0;
          const snap = helped + '/' + received + '/' + pts;
          if (snap !== this._lastStatsSnap) {
            this._lastStatsSnap = snap;
            this._log('info', `状态 今日帮了 ${helped} · 被助 ${received} · 积分 ${pts}`);
          }
        }
      }
    } catch (e) {
      this._log('warn', '状态拉取失败：' + (e && e.message ? e.message : e));
    }
  }

  async _stopBrowser() {
    if (this.browser) {
      try { await this.browser.close(); } catch (e) { /* 吞 */ }
      this.browser = null;
    }
    await this._setRunState({ browser: false });
  }

  /** 停止编排（供外部/进程退出调用）。 */
  async stop() {
    this._stopRequested = true;
    this._cancelReconnect();
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    await this._stopBrowser();
    await this._setRunState({ orchestrator: false, browser: false });
    this._log('info', 'orchestrator 已停止');
  }
}

module.exports = {
  Orchestrator,
  KEYS,
  // 顶层 start：main.js 调用 orchestrator.start({ store, log })。
  start(deps) {
    const inst = module.exports._instance || (module.exports._instance = new Orchestrator(deps || {}));
    if (deps) {
      inst.store = deps.store || inst.store;
      inst.log = deps.log || inst.log;
    }
    return inst.start();
  },
};
