'use strict';

/**
 * app.js —— 管理 UI 前端逻辑（Vue 3 自托管，无构建、无网络依赖）。
 *
 * - 依赖 src/public/vue.global.js（Vue 3 全局构建版，本地引用，离线可用）。
 * - 登录后访问 /api/*；未登录时显示登录页。
 * - 状态区每 5s 轮询 /api/status；日志支持级别过滤 / 自动滚动 / 清屏。
 * - API 端点与旧版逐条对齐：/api/login、/api/logout、/api/status、
 *   /api/config、/api/control；请求/响应字段不变（详见 server.js）。
 */

(function () {
  if (typeof Vue === 'undefined') {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:sans-serif;color:#f87171;">Vue 运行库加载失败（/vue.global.js）</div>';
    return;
  }

  const { createApp } = Vue;

  // 与 package.json / config.js 对齐的前端展示版本号（仅展示，不参与接口）。
  const UI_VERSION = '4.0.18';
  // 状态轮询间隔（与旧版一致：5s）。
  const POLL_INTERVAL_MS = 5000;
  // 活跃窗口跨度硬上限（与 server.js / config.js 的 16h 一致）。
  const MAX_ACTIVE_SPAN_HOURS = 16;

  // —— 通用工具 ——
  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, opts || {}));
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = data && data.error ? data.error : ('请求失败 ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function post(path, body) {
    return api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  function clamp(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    return Math.max(0, Math.min(100, v));
  }

  function numOrNull() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (v == null || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function formatCountdown(sec) {
    const n = Number(sec);
    if (sec == null || !Number.isFinite(n) || n < 0) return null;
    const s = Math.round(n);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  // 日志行格式：[ISO时间] [level] message（由 main.js appendLog 生成）
  function parseLogLine(line) {
    const s = String(line == null ? '' : line);
    const m = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/.exec(s);
    if (!m) return { ts: '', level: 'info', text: s };
    return { ts: m[1], level: String(m[2]).toLowerCase(), text: m[3] };
  }

  // 级别归一：info → info；warn → warn；error/alert → error（红色）。
  function levelClass(level) {
    const l = String(level || '').toLowerCase();
    if (l === 'error' || l === 'alert') return 'error';
    if (l === 'warn') return 'warn';
    return 'info';
  }

  function windowSpanHours(start, end) {
    if (!start || !end) return 0;
    const toMin = (t) => { const p = String(t).split(':'); return Number(p[0]) * 60 + Number(p[1]); };
    let span = toMin(end) - toMin(start);
    if (span <= 0) span += 24 * 60;
    return span / 60;
  }

  // 将 /api/status 返回的 task（原始对象，当前后端尚未写入）归一为展示结构。
  function normalizeTask(t) {
    const empty = { active: false, title: '', artist: '', jobId: null, percent: null, remainingText: null, rawProgress: null };
    if (!t || typeof t !== 'object' || Array.isArray(t)) return empty;

    const title = t.songName || t.title || t.name || '';
    const artist = t.artist || t.artistName || t.singer || t.author || '';
    const jobId = t.jobId != null ? t.jobId : null;

    let percent = null;
    if (typeof t.progress === 'number') percent = clamp(t.progress);
    else if (typeof t.progressPercent === 'number') percent = clamp(t.progressPercent);
    else if (typeof t.percent === 'number') percent = clamp(t.percent);
    else if (typeof t.progress === 'string') {
      const m = /(\d+(?:\.\d+)?)\s*%/.exec(String(t.progress));
      if (m) percent = clamp(Number(m[1]));
    }

    const dur = numOrNull(t.durationMs, t.duration);
    const pos = numOrNull(t.positionMs, t.currentTime, t.elapsed);
    if (percent == null && dur != null && dur > 0 && pos != null) {
      percent = clamp(pos / dur * 100);
    }
    if (percent != null) percent = Math.round(percent);

    let remainingSec = null;
    if (t.remainingMs != null) remainingSec = Number(t.remainingMs) / 1000;
    else if (t.remaining != null) remainingSec = Number(t.remaining);
    else if (t.remainSeconds != null) remainingSec = Number(t.remainSeconds);
    else if (dur != null && pos != null) remainingSec = Math.max(0, (dur - pos) / 1000);

    return {
      active: !!(title || jobId != null || percent != null),
      title,
      artist,
      jobId,
      percent,
      remainingText: formatCountdown(remainingSec),
      rawProgress: t.progress != null ? String(t.progress) : null,
    };
  }

  // —— 组件：三色连接状态灯 ——
  const StatusLight = {
    name: 'StatusLight',
    props: {
      label: { type: String, required: true },
      state: { type: String, default: 'down' }, // ok | busy | down
      text: { type: String, default: '' },
    },
    template: [
      '<div class="status-light" :class="\'is-\' + state">',
      '  <span class="dot"></span>',
      '  <div class="sl-meta">',
      '    <span class="sl-label">{{ label }}</span>',
      '    <span class="sl-text">{{ text }}</span>',
      '  </div>',
      '</div>',
    ].join(''),
  };

  // —— 组件：今日帮听/被助 统计条形图（纯 CSS 条） ——
  const StatChart = {
    name: 'StatChart',
    props: {
      helped: { type: Number, default: 0 },
      received: { type: Number, default: 0 },
    },
    computed: {
      max() { return Math.max(this.helped, this.received, 1); },
    },
    template: [
      '<div class="stat-chart">',
      '  <div class="bar-row">',
      '    <span class="bar-label">今日帮听</span>',
      '    <div class="bar-track"><div class="bar-fill bar-helped" :style="{ width: (helped / max * 100) + \'%\' }"></div></div>',
      '    <span class="bar-value">{{ helped }}</span>',
      '  </div>',
      '  <div class="bar-row">',
      '    <span class="bar-label">今日被助</span>',
      '    <div class="bar-track"><div class="bar-fill bar-received" :style="{ width: (received / max * 100) + \'%\' }"></div></div>',
      '    <span class="bar-value">{{ received }}</span>',
      '  </div>',
      '</div>',
    ].join(''),
  };

  // —— 组件：当前任务卡片 ——
  const TaskCard = {
    name: 'TaskCard',
    props: { task: { type: Object, default: null } },
    computed: {
      view() { return normalizeTask(this.task); },
    },
    template: [
      '<div>',
      '  <div v-if="!view.active" class="task-idle">',
      '    <span class="idle-glyph">&#128564;</span><span>空闲</span>',
      '  </div>',
      '  <div v-else>',
      '    <div class="task-title">{{ view.title || \'任务进行中\' }}</div>',
      '    <div class="task-artist" v-if="view.artist">{{ view.artist }}</div>',
      '    <div class="task-progress" v-if="view.percent != null">',
      '      <div class="progress-track"><div class="progress-fill" :style="{ width: view.percent + \'%\' }"></div></div>',
      '      <span class="task-countdown" v-if="view.remainingText">{{ view.remainingText }}</span>',
      '      <span class="task-countdown" v-else>{{ view.percent }}%</span>',
      '    </div>',
      '    <div class="task-text-only" v-else-if="view.rawProgress">{{ view.rawProgress }}</div>',
      '    <div class="task-meta">',
      '      <span class="meta-item" v-if="view.jobId != null">任务 <b>{{ view.jobId }}</b></span>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join(''),
  };

  // —— 根组件 ——
  const App = {
    components: {
      'status-light': StatusLight,
      'stat-chart': StatChart,
      'task-card': TaskCard,
    },

    data() {
      return {
        authed: false,
        login: { password: '', loading: false, error: '' },
        status: null,
        connected: false,
        cfgSynced: false,
        cfg: {
          cookies: '',
          credential: '',
          preference: 'random',
          windowStart: '',
          windowEnd: '',
        },
        cfgSaving: false,
        ctlBusy: false,
        ctlAction: null,
        logFilter: 'all',
        autoScroll: true,
        clearedAfter: '',
        toasts: [],
        toastSeq: 0,
        bannerDismissed: false,
        version: UI_VERSION,
      };
    },

    computed: {
      browserLight() {
        const s = this.status;
        const running = !!(s && s.running && s.running.browser);
        if (!running) return { state: 'down', text: '已停止' };
        return this.taskView.active
          ? { state: 'busy', text: '忙 · 播放中' }
          : { state: 'ok', text: '运行中' };
      },
      orchestratorLight() {
        const s = this.status;
        const running = !!(s && s.running && s.running.orchestrator);
        return { state: running ? 'ok' : 'down', text: running ? '运行中' : '已停止' };
      },
      serverLight() {
        return { state: this.connected ? 'ok' : 'down', text: this.connected ? '已连接' : '连接断开' };
      },
      taskView() {
        return normalizeTask(this.status && this.status.task);
      },
      accountLabel() {
        const a = this.status && this.status.account;
        return a && a.displayName ? a.displayName : null;
      },
      accountSub() {
        const a = this.status && this.status.account;
        return a && a.userId != null ? 'id=' + a.userId : null;
      },
      credModeText() {
        const modeMap = { key: '密钥（client key）', token: 'token（session）', unconfigured: '未配置' };
        const m = this.status ? this.status.credentialMode : 'unconfigured';
        return modeMap[m] || m;
      },
      credPreview() {
        return this.status && this.status.credentialPreview ? this.status.credentialPreview : '';
      },
      cookiePresent() {
        return !!(this.status && this.status.cookiePresent);
      },
      helped() {
        return this.status && this.status.today ? (Number(this.status.today.helped) || 0) : 0;
      },
      received() {
        return this.status && this.status.today ? (Number(this.status.today.received) || 0) : 0;
      },
      points() {
        return this.status ? (Number(this.status.points) || 0) : 0;
      },
      // 首次配置引导：账号未绑定且配置不完整（缺 Cookie 或缺凭证）时显示。
      needsSetup() {
        const s = this.status;
        if (!s) return false;
        const hasAccount = !!(s.account && s.account.displayName);
        const hasCred = s.credentialMode !== 'unconfigured';
        return !hasAccount && (!s.cookiePresent || !hasCred);
      },
      filteredLogs() {
        const logs = (this.status && this.status.logs) || [];
        const out = [];
        for (let i = 0; i < logs.length; i++) {
          const p = parseLogLine(logs[i]);
          p.cls = levelClass(p.level);
          if (this.logFilter !== 'all' && p.cls !== this.logFilter) continue;
          if (this.clearedAfter && p.ts <= this.clearedAfter) continue;
          out.push(p);
        }
        return out;
      },
    },

    watch: {
      filteredLogs() { this.scrollLogs(); },
      autoScroll(v) { if (v) this.scrollLogs(); },
    },

    methods: {
      toast(message, type) {
        const id = ++this.toastSeq;
        this.toasts.push({ id, message, type: type || 'info' });
        setTimeout(() => {
          this.toasts = this.toasts.filter((t) => t.id !== id);
        }, 3200);
      },

      async doLogin() {
        if (this.login.loading) return;
        const password = this.login.password;
        this.login.error = '';
        if (!password) { this.login.error = '请输入密码'; return; }
        this.login.loading = true;
        try {
          await post('/api/login', { password });
          this.login.password = '';
          this.authed = true;
          await this.refreshStatus();
        } catch (e) {
          this.login.error = e.status === 429 ? '尝试过于频繁，请稍后再试' : e.message;
        } finally {
          this.login.loading = false;
        }
      },

      async doLogout() {
        try { await post('/api/logout', {}); } catch (e) { /* 忽略 */ }
        location.reload();
      },

      async refreshStatus() {
        try {
          const s = await api('/api/status');
          this.status = s;
          this.connected = true;
          if (!this.cfgSynced) { this.syncConfigForm(s); this.cfgSynced = true; }
        } catch (e) {
          if (e.status === 401) { this.authed = false; this.connected = false; return; }
          this.connected = false;
        }
      },

      syncConfigForm(s) {
        if (s && s.activeWindow) {
          this.cfg.windowStart = s.activeWindow.start || '';
          this.cfg.windowEnd = s.activeWindow.end || '';
        }
      },

      async saveConfig() {
        if (this.cfgSaving) return;
        const ws = this.cfg.windowStart;
        const we = this.cfg.windowEnd;

        // 前端预校验（与 server.js validateWindow 对齐：跨度 16h 上限 + 成对填写）。
        if (ws && we) {
          if (windowSpanHours(ws, we) > MAX_ACTIVE_SPAN_HOURS) {
            this.toast('活跃窗口跨度超过 16 小时上限，不可保存', 'error');
            return;
          }
        } else if ((ws && !we) || (!ws && we)) {
          this.toast('开始时间与结束时间必须同时填写或同时留空', 'error');
          return;
        }

        const credential = String(this.cfg.credential || '').trim();
        const toSend = {};
        if (credential) {
          if (!credential.startsWith('mh_ck_')) {
            this.toast('密钥必须以 mh_ck_ 开头', 'error');
            return;
          }
          toSend.credential = credential;
        }
        toSend.cookies = this.cfg.cookies;
        toSend.preference = this.cfg.preference;
        toSend.windowStart = ws;
        toSend.windowEnd = we;

        this.cfgSaving = true;
        try {
          await post('/api/config', toSend);
          this.cfg.credential = '';
          this.toast('配置已保存', 'ok');
          await this.refreshStatus();
        } catch (e) {
          this.toast('保存失败：' + e.message, 'error');
        } finally {
          this.cfgSaving = false;
        }
      },

      async control(action) {
        if (this.ctlBusy) return;
        this.ctlBusy = true;
        this.ctlAction = action;
        try {
          await post('/api/control', { action });
          this.toast(action === 'start' ? '已发送启动指令' : '已发送停止指令', 'ok');
          await this.refreshStatus();
        } catch (e) {
          this.toast('操作失败：' + e.message, 'error');
        } finally {
          this.ctlBusy = false;
          this.ctlAction = null;
        }
      },

      clearLogs() {
        // 无服务端清日志接口，这里为「清屏」：仅显示此后的新日志（以当前最新时间戳为水位）。
        const logs = (this.status && this.status.logs) || [];
        let maxTs = '';
        for (let i = 0; i < logs.length; i++) {
          const p = parseLogLine(logs[i]);
          if (p.ts > maxTs) maxTs = p.ts;
        }
        this.clearedAfter = maxTs;
        this.toast('已清屏：仅显示之后的新日志', 'info');
      },

      scrollLogs() {
        if (!this.autoScroll) return;
        this.$nextTick(() => {
          const el = this.$refs.logPanel;
          if (el) el.scrollTop = el.scrollHeight;
        });
      },

      async boot() {
        let ok = false;
        try { await api('/api/status'); ok = true; } catch (e) { ok = false; }
        if (ok) {
          this.authed = true;
          await this.refreshStatus();
        } else {
          this.authed = false;
        }
      },
    },

    mounted() {
      this.boot();
      this.timer = setInterval(() => {
        if (this.authed) this.refreshStatus();
      }, POLL_INTERVAL_MS);
    },

    beforeUnmount() {
      if (this.timer) clearInterval(this.timer);
    },

    template: [
      '<div class="app">',
      // —— 登录页 ——
      '  <div v-if="!authed" class="login-wrap">',
      '    <div class="login-card">',
      '      <div class="logo"><span class="glyph">&#9835;</span></div>',
      '      <h1>网易云互助 · 客户端</h1>',
      '      <p class="sub">请输入管理密码登录</p>',
      '      <input type="password" class="form-input" v-model="login.password" placeholder="管理密码" autocomplete="current-password" @keydown.enter="doLogin">',
      '      <button class="btn primary block" :disabled="login.loading" @click="doLogin">',
      '        <span v-if="login.loading" class="spinner"></span>{{ login.loading ? \'登录中…\' : \'登录\' }}',
      '      </button>',
      '      <div class="login-error">{{ login.error }}</div>',
      '    </div>',
      '  </div>',
      // —— 主界面 ——
      '  <div v-else class="wrap">',
      '    <header class="topbar">',
      '      <div class="brand">',
      '        <h1>网易云互助 · 客户端管理</h1>',
      '        <div class="sub">Docker 常驻客户端<span class="version">v{{ version }}</span></div>',
      '      </div>',
      '      <div class="lights">',
      '        <status-light label="浏览器" :state="browserLight.state" :text="browserLight.text"></status-light>',
      '        <status-light label="调度器" :state="orchestratorLight.state" :text="orchestratorLight.text"></status-light>',
      '        <status-light label="服务器" :state="serverLight.state" :text="serverLight.text"></status-light>',
      '      </div>',
      '      <button class="btn ghost" @click="doLogout">退出登录</button>',
      '    </header>',
      // 首次配置引导横幅
      '    <div v-if="needsSetup && !bannerDismissed" class="banner">',
      '      <div class="banner-body">',
      '        <div class="banner-title">三步完成配置</div>',
      '        <div class="banner-steps">① 粘贴 <b>Cookie</b>　② 粘贴<b>客户端密钥</b>（mh_ck_ 开头）　③ 点击 <b>保存配置</b></div>',
      '      </div>',
      '      <button class="btn ghost small" @click="bannerDismissed = true">知道了</button>',
      '    </div>',
      // 断线提示
      '    <div v-if="!connected" class="banner warn">',
      '      <div class="banner-body"><div class="banner-title">连接断开，正在重试…</div></div>',
      '    </div>',
      // 状态区
      '    <section class="card">',
      '      <h2>运行状态</h2>',
      '      <div class="stat-grid">',
      '        <div class="stat">',
      '          <div class="stat-label">绑定账号</div>',
      '          <div class="stat-value" v-if="accountLabel">{{ accountLabel }}<div class="stat-sub">{{ accountSub }}</div></div>',
      '          <div class="stat-value" v-else><span class="badge blank">未绑定</span></div>',
      '        </div>',
      '        <div class="stat accent">',
      '          <div class="stat-label">积分</div>',
      '          <div class="stat-value big">{{ points }}</div>',
      '        </div>',
      '        <div class="stat">',
      '          <div class="stat-label">今日帮听</div>',
      '          <div class="stat-value">{{ helped }}</div>',
      '        </div>',
      '        <div class="stat">',
      '          <div class="stat-label">今日被助</div>',
      '          <div class="stat-value">{{ received }}</div>',
      '        </div>',
      '        <div class="stat">',
      '          <div class="stat-label">凭证模式</div>',
      '          <div class="stat-value">{{ credModeText }}<div class="stat-sub" v-if="credPreview">{{ credPreview }}…</div></div>',
      '        </div>',
      '      </div>',
      '    </section>',
      // 当前任务
      '    <section class="card task-card">',
      '      <h2>当前任务</h2>',
      '      <task-card :task="status && status.task"></task-card>',
      '    </section>',
      // 今日统计
      '    <section class="card">',
      '      <h2>今日统计</h2>',
      '      <stat-chart :helped="helped" :received="received"></stat-chart>',
      '    </section>',
      // 配置
      '    <section class="card">',
      '      <h2>配置</h2>',
      '      <div class="config-block">',
      '        <div class="block-title"><span class="dot"></span>网易云账号</div>',
      '        <div class="field">',
      '          <label>Cookie（MUSIC_U=...; __csrf=... 形式）</label>',
      '          <textarea class="form-textarea" v-model="cfg.cookies" placeholder="MUSIC_U=...; __csrf=..."></textarea>',
      '          <div class="hint">保存后会自动标记「需要重载页面」，调度器将重新加载网易云页面以生效。</div>',
      '          <div class="hint ok" v-if="cookiePresent">已保存 Cookie（出于安全不回显）</div>',
      '        </div>',
      '      </div>',
      '      <div class="config-block">',
      '        <div class="block-title"><span class="dot"></span>平台凭证</div>',
      '        <div class="field">',
      '          <input class="form-input" type="text" v-model="cfg.credential" placeholder="粘贴密钥（mh_ck_ 开头）">',
      '          <div class="hint" v-if="credModeText !== \'未配置\'">当前凭证：{{ credModeText }}<span v-if="credPreview">（{{ credPreview }}…）</span></div>',
      '        </div>',
      '      </div>',
      '      <div class="config-block">',
      '        <div class="block-title"><span class="dot"></span>偏好</div>',
      '        <div class="field">',
      '          <select class="form-select" v-model="cfg.preference">',
      '            <option value="short">短歌</option>',
      '            <option value="long">长歌</option>',
      '            <option value="random">随机</option>',
      '          </select>',
      '        </div>',
      '      </div>',
      '      <div class="config-block">',
      '        <div class="block-title"><span class="dot"></span>活跃窗口</div>',
      '        <div class="field">',
      '          <div class="form-row">',
      '            <input class="form-input" type="time" v-model="cfg.windowStart">',
      '            <span class="muted">至</span>',
      '            <input class="form-input" type="time" v-model="cfg.windowEnd">',
      '          </div>',
      '          <div class="hint">留空 = 全天不限制；跨度上限 16 小时，支持跨零点。</div>',
      '        </div>',
      '      </div>',
      '      <div class="mt-16">',
      '        <button class="btn primary" :disabled="cfgSaving" @click="saveConfig">',
      '          <span v-if="cfgSaving" class="spinner"></span>{{ cfgSaving ? \'保存中…\' : \'保存配置\' }}',
      '        </button>',
      '      </div>',
      '    </section>',
      // 控制 + 日志
      '    <section class="card">',
      '      <h2>控制</h2>',
      '      <div class="controls">',
      '        <button class="btn" :disabled="ctlBusy" @click="control(\'start\')">',
      '          <span v-if="ctlBusy && ctlAction === \'start\'" class="spinner"></span>启动',
      '        </button>',
      '        <button class="btn danger" :disabled="ctlBusy" @click="control(\'stop\')">',
      '          <span v-if="ctlBusy && ctlAction === \'stop\'" class="spinner"></span>停止',
      '        </button>',
      '      </div>',
      '      <div class="log-toolbar">',
      '        <div class="filters">',
      '          <button class="filter-btn" :class="{ active: logFilter === \'all\' }" @click="logFilter = \'all\'">全部</button>',
      '          <button class="filter-btn" :class="{ active: logFilter === \'info\' }" @click="logFilter = \'info\'">信息</button>',
      '          <button class="filter-btn" :class="{ active: logFilter === \'warn\' }" @click="logFilter = \'warn\'">警告</button>',
      '          <button class="filter-btn" :class="{ active: logFilter === \'error\' }" @click="logFilter = \'error\'">错误</button>',
      '        </div>',
      '        <div class="spacer"></div>',
      '        <label class="toggle"><input type="checkbox" v-model="autoScroll"> 自动滚动</label>',
      '        <button class="btn ghost small" @click="clearLogs">清屏</button>',
      '      </div>',
      '      <div class="log-panel" ref="logPanel">',
      '        <div v-if="filteredLogs.length === 0" class="log-empty">暂无日志</div>',
      '        <div v-for="(l, i) in filteredLogs" :key="i" class="log-line" :class="l.cls">',
      '          <span class="log-ts">{{ l.ts }}</span>',
      '          <span class="log-level">{{ l.level }}</span>',
      '          <span class="log-msg">{{ l.text }}</span>',
      '        </div>',
      '      </div>',
      '    </section>',
      '  </div>',
      // —— Toast ——
      '  <div class="toast-stack">',
      '    <div v-for="t in toasts" :key="t.id" class="toast" :class="\'is-\' + t.type">',
      '      <span class="t-glyph">{{ t.type === \'ok\' ? \'✓\' : (t.type === \'error\' ? \'✕\' : \'ℹ\') }}</span>',
      '      <span>{{ t.message }}</span>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join(''),
  };

  createApp(App).mount('#app');
})();
