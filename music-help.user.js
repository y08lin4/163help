// ==UserScript==
// @name        网易云音乐互助
// @namespace   163help
// @version     5.1
// @description 互助播放（油猴端）
// @match       https://music.163.com/*
// @match       https://163music.linyu.qzz.io/*
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       unsafeWindow
// ==/UserScript==
"use strict";
(() => {
  // ../../packages/core/src/events.ts
  var EventBus = class {
    listeners = /* @__PURE__ */ new Map();
    on(event, fn) {
      let set = this.listeners.get(event);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        this.listeners.set(event, set);
      }
      set.add(fn);
      return () => this.off(event, fn);
    }
    off(event, fn) {
      this.listeners.get(event)?.delete(fn);
    }
    emit(event, payload) {
      const set = this.listeners.get(event);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch {
        }
      }
    }
    clear() {
      this.listeners.clear();
    }
  };

  // ../../packages/core/src/sign.ts
  async function buildSignHeaders(method, fullUrl, rawBody, token, hmacFn, nonceFn) {
    if (!token) return null;
    const ts = Math.floor(Date.now() / 1e3).toString();
    const nonce = nonceFn();
    const bodyHash = rawBody ? await hmacFn(token, rawBody) : "";
    const norm = `${method}
${fullUrl}
${ts}
${nonce}
${bodyHash}`;
    const secret = token.startsWith("mh_ck_") ? await hmacFn(token, "") : token;
    return { a: nonce, t: ts, s: await hmacFn(secret, norm) };
  }
  var hexBytes = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  async function subtleHmac(secret, data) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
    return hexBytes(new Uint8Array(sig));
  }
  function browserNonce() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return hexBytes(b);
  }

  // ../../packages/core/src/stats.ts
  function helpSecondsLimit(maxSongSec, coeff = 30, maxBaseSec = 300, noSongBaseSec = 61) {
    const base = maxSongSec > 0 ? Math.min(maxSongSec, maxBaseSec) : noSongBaseSec;
    return base * coeff;
  }

  // ../../packages/core/src/logger.ts
  var RING_SIZE = 200;
  var WARN_COOLDOWN_MS = 5 * 6e4;
  var BACKLOG_MAX = 20;
  var BACKLOG_FLUSH_MS = 10 * 6e4;
  var REDACT_RE = [
    /mh_ck_[A-Za-z0-9_-]+/g,
    /MUSIC_U=[^;&\s"'`]+/g,
    /[?&]token=[^&\s"'`]+/g
  ];
  function redact(text) {
    let out = text;
    for (const re of REDACT_RE) out = out.replace(re, "***");
    return out;
  }
  var ClientLogger = class {
    constructor(sink, opts = {}) {
      this.opts = opts;
      this.sink = sink;
    }
    ring = [];
    backlog = [];
    lastWarnAt = /* @__PURE__ */ new Map();
    lastFlushAt = 0;
    sink;
    push(level, event, msg, context) {
      const payload = {
        level,
        event,
        msg: redact(String(msg)),
        context: context ? Object.fromEntries(Object.entries(context).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v])) : void 0,
        clientVersion: "",
        // 由 adapter 填充
        clientType: "userscript"
      };
      this.ring.push(payload);
      const ringSize = this.opts.maxRing ?? RING_SIZE;
      if (this.ring.length > ringSize) this.ring.splice(0, this.ring.length - ringSize);
      this.opts.onAppend?.(payload);
      void this.schedule(payload);
    }
    async schedule(p) {
      if (p.level === "error") {
        await this.trySend(p);
      } else if (p.level === "warn") {
        const now = Date.now();
        const last = this.lastWarnAt.get(p.event) ?? 0;
        const cooldown = this.opts.warnCooldownMs ?? WARN_COOLDOWN_MS;
        if (now - last >= cooldown) {
          this.lastWarnAt.set(p.event, now);
          await this.trySend(p);
        }
      }
    }
    async trySend(p) {
      try {
        await this.sink(p);
      } catch {
        if (this.backlog.length < BACKLOG_MAX) this.backlog.push(p);
        this.maybeFlushBacklog();
      }
    }
    maybeFlushBacklog() {
      const now = Date.now();
      if (this.backlog.length === 0 || now - this.lastFlushAt < BACKLOG_FLUSH_MS) return;
      void (async () => {
        const batch = this.backlog.splice(0);
        for (const p of batch) {
          try {
            await this.sink(p);
          } catch {
            this.backlog.push(p);
            break;
          }
        }
        this.lastFlushAt = now;
      })();
    }
    /** 面板「复制诊断信息」：脱敏环形日志 + 概要 */
    dump() {
      const lines = this.ring.map((p) => `[${(/* @__PURE__ */ new Date()).toISOString()}] ${p.level.toUpperCase()} ${p.event} ${p.msg}`);
      return ["====== 163help client diagnostic ======", ...lines].join("\n");
    }
    clear() {
      this.ring = [];
    }
  };

  // ../../packages/core/src/auth.ts
  var REFRESH_SKEW_MS = 5e3;
  var RETRY_DELAY_MS = [1e3, 3e3, 8e3];
  var AuthManager = class {
    constructor(adapter2, api2, bus) {
      this.adapter = adapter2;
      this.api = api2;
      this.bus = bus;
    }
    status = "no_token";
    /** 已登录（有可用 token）？ */
    hasToken() {
      return this.adapter.storage.getToken() !== "";
    }
    setStatus(s) {
      if (this.status !== s) {
        this.status = s;
        this.bus.emit("auth:status", s);
      }
    }
    /** 存登录结果（oauth 回跳后由登录页调用） */
    acceptSession(p) {
      this.adapter.storage.setToken(p.token);
      this.adapter.storage.setExpires("access", Date.parse(p.access_expires_at));
      this.adapter.storage.setExpires("refresh", Date.parse(p.refresh_expires_at));
      this.setStatus("valid");
      void this.refreshUser();
    }
    clearSession() {
      this.adapter.storage.clearToken();
      this.setStatus("logged_out");
      this.bus.emit("auth:user", null);
    }
    tokenNeedsRefresh() {
      const at = this.adapter.storage.getExpires("access");
      return at > 0 && Date.now() >= at - REFRESH_SKEW_MS;
    }
    /** 确保新鲜：需要时先 refresh；返回真实 token（空=未登录） */
    async ensureToken() {
      const token = this.adapter.storage.getToken();
      if (!token) {
        this.setStatus("no_token");
        return "";
      }
      if (this.tokenNeedsRefresh() || this.status === "refreshing") {
        await this.refreshToken();
      }
      return this.adapter.storage.getToken();
    }
    refreshPromise = null;
    /** 刷新（并发去重；401→清态；网络/5xx→有限退避后仍失败则不清态保留旧凭证） */
    async refreshToken() {
      if (this.refreshPromise) return this.refreshPromise;
      this.refreshPromise = (async () => {
        this.setStatus("refreshing");
        const token = this.adapter.storage.getToken();
        if (!token) {
          this.setStatus("no_token");
          return false;
        }
        let ok = false;
        for (const delay of [...RETRY_DELAY_MS, null]) {
          const p = await this.api.refresh(token);
          if (p) {
            this.acceptSession(p);
            ok = true;
            break;
          }
          if (delay !== null) await sleep(delay);
        }
        if (!ok) {
          if (this.status === "refreshing") this.setStatus("valid");
        }
        this.refreshPromise = null;
        return ok;
      })();
      return this.refreshPromise;
    }
    async refreshUser() {
      const token = await this.ensureToken();
      if (!token) return;
      const r = await this.api.me();
      if (r.status === 200 && r.payload) {
        this.bus.emit("auth:user", { displayName: r.payload.displayName, credits: r.payload.credits });
        this.emitLimitsFrom(r.payload);
      } else if (r.status === 401) {
        const refreshed = await this.refreshToken();
        if (!refreshed) this.clearSession();
      }
    }
    /** B5：me() 成功回调后发射 limits:updated（仅在数值变化时）。me() 无限额字段则用 stats.ts 推算兜底 */
    lastLimitsKey = "";
    emitLimitsFrom(p) {
      const hasReal = [p.helpedToday, p.helpedLimit, p.receivedToday, p.receivedLimit].some((v) => typeof v === "number");
      const fallbackLimit = helpSecondsLimit(300);
      const limits = hasReal ? {
        helpedToday: p.helpedToday ?? 0,
        helpedLimit: p.helpedLimit ?? fallbackLimit,
        receivedToday: p.receivedToday ?? 0,
        receivedLimit: p.receivedLimit ?? 26
      } : {
        helpedToday: 0,
        helpedLimit: fallbackLimit,
        receivedToday: 0,
        receivedLimit: 26
      };
      const key = JSON.stringify(limits);
      if (key === this.lastLimitsKey) return;
      this.lastLimitsKey = key;
      this.bus.emit("limits:updated", limits);
    }
    /** 供 401 处理：refresh 重试；失败清态 */
    async onUnauthorized() {
      const ok = await this.refreshToken();
      if (!ok) this.clearSession();
      return ok;
    }
  };
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ../../packages/core/src/heartbeat.ts
  var HEARTBEAT_INTERVAL_MS = 1e4;
  var FIRST_HB_GRACE_MS = 3e4;
  var HB_STALL_MS = 45e3;
  var HeartbeatEngine = class {
    constructor(bus, api2, adapter2, events, opts = {}) {
      this.bus = bus;
      this.api = api2;
      this.adapter = adapter2;
      this.events = events;
      this.opts = {
        firstHbGraceMs: opts.firstHbGraceMs ?? FIRST_HB_GRACE_MS,
        hbStallMs: opts.hbStallMs ?? HB_STALL_MS,
        intervalMs: opts.intervalMs ?? HEARTBEAT_INTERVAL_MS
      };
      this.adapter.onLifecycle?.("freeze", () => {
        void this.flush().catch(() => {
        });
      });
      this.adapter.onLifecycle?.("resume", () => {
        void this.onResumeLifecycle();
      });
    }
    timer = null;
    graceTimer = null;
    lastAt = 0;
    jobId = "";
    stopped = true;
    opts;
    get job() {
      return this.jobId;
    }
    start(jobId) {
      this.stop();
      this.jobId = jobId;
      this.stopped = false;
      this.graceTimer = setTimeout(() => {
        if (!this.stopped && this.lastAt === 0) {
          this.events.onAbandon("play_start_fail", `\u9996\u5FC3\u8DF3 30s \u5185\u672A\u51FA\u73B0`);
        }
      }, this.opts.firstHbGraceMs);
      this.timer = setInterval(() => {
        void this.tick();
      }, this.opts.intervalMs);
    }
    /** 播放心跳（播放器回调） */
    async pulse(playedMs, positionMs, durationMs, monotonic) {
      if (this.stopped) return;
      this.lastAt = Date.now();
      await this.flush(playedMs, positionMs, durationMs, monotonic);
    }
    async flush(playedMs = 0, positionMs = 0, durationMs = 0, monotonic = true) {
      if (this.stopped || !this.jobId) return;
      const ok = await this.api.heartbeat({
        jobId: this.jobId,
        playedMs,
        positionMs,
        durationMs,
        monotonic
      });
      if (ok) {
        this.bus.emit("heartbeat:tick", { jobId: this.jobId, intervalMs: HEARTBEAT_INTERVAL_MS, lastAtMs: Date.now() });
      }
    }
    async tick() {
      if (this.stopped || !this.jobId) return;
      if (this.lastAt === 0) return;
      if (Date.now() - this.lastAt > this.opts.hbStallMs) {
        this.events.onAbandon("heartbeat_lost", `\u8DDD\u4E0A\u6B21\u5FC3\u8DF3 ${Math.round((Date.now() - this.lastAt) / 1e3)}s`);
        return;
      }
      await this.flush();
    }
    async onResumeLifecycle() {
      if (this.stopped || !this.jobId) return;
      this.bus.emit("heartbeat:tick", { jobId: this.jobId, intervalMs: 0, lastAtMs: Date.now() });
      this.events.onResume();
    }
    stop() {
      this.stopped = true;
      this.jobId = "";
      this.lastAt = 0;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
    }
  };

  // ../../packages/core/src/dispatch.ts
  var JobStateMachine = class {
    // 防重入
    constructor(deps, bus) {
      this.deps = deps;
      this.bus = bus;
    }
    phase = "idle";
    current = null;
    busy = false;
    setPhase(p) {
      this.phase = p;
      this.bus.emit("job:phase", p);
    }
    /** 领取下一单（空闲时调用；防并发） */
    async fetchNext() {
      if (this.busy || this.phase !== "idle") return null;
      this.busy = true;
      this.setPhase("fetching");
      try {
        const r = await this.deps.next();
        if (r.status === 200 && r.payload && r.payload.jobId && r.payload.musicId) {
          this.current = {
            jobId: r.payload.jobId,
            musicName: r.payload.owner?.displayName ? "" : String(r.payload.musicId),
            targetMs: r.payload.targetDurationMs ?? 0,
            playedMs: 0
          };
          this.setPhase("playing");
          this.bus.emit("job:current", this.current);
          this.deps.onPlaying(this.current);
          return r.payload;
        }
        this.setPhase("idle");
        return r.payload ?? null;
      } finally {
        this.busy = false;
      }
    }
    updateProgress(playedMs) {
      if (!this.current) return;
      this.current.playedMs = Math.max(this.current.playedMs, playedMs);
      this.bus.emit("job:progress", { jobId: this.current.jobId, playedMs, positionMs: playedMs });
    }
    /** 播放完成提交 */
    async submitFinish(input) {
      if (!this.current) return "error";
      try {
        const r = await this.deps.finish(input);
        if (r.status === 200 || r.payload?.settled) {
          this.clear();
          return "settled";
        }
        if (r.status === 403 || r.payload === null) {
          this.deps.onSettleFailed(String(r.payload && "error" in r.payload ? r.payload.error : "rejected"), String(r.error ?? ""));
        }
        this.clear();
        return r.status === 403 ? "rejected" : "error";
      } catch {
        this.clear();
        return "error";
      }
    }
    /** 主动放弃（30s 无首心跳 / 45s 心跳中断 / 播放器错误） */
    async abandon(reason, detail) {
      const job = this.current;
      this.setPhase("abandoning");
      try {
        if (job) await this.deps.abandon(reason, detail);
      } finally {
        this.clear();
      }
    }
    clear() {
      this.current = null;
      this.setPhase("idle");
      this.bus.emit("job:current", null);
    }
  };

  // ../../packages/core/src/runner.ts
  var ClientRuntime = class {
    constructor(deps) {
      this.deps = deps;
      this.log = new ClientLogger((p) => this.deps.transport.sendLog(p), {
        // B5：log:append 真正发射（每次 log.push → core bus → 面板 logCount）
        // 载荷保持 msg/ts 兼容既有端点，额外附 text/event 供新消费方
        onAppend: (p) => this.bus.emit("log:append", { level: p.level, ts: Date.now(), msg: p.msg, text: p.msg, event: p.event })
      });
      this.auth = new AuthManager(deps.adapter, {
        refresh: (t) => deps.transport.refresh(t),
        me: () => deps.transport.me(),
        login: async () => null
        // 登录走页面 oauth
      }, this.bus);
      this.job = new JobStateMachine({
        next: async () => {
          const token = await this.auth.ensureToken();
          if (!token) return { status: 401, payload: null, error: "no_token" };
          return this.deps.transport.next(token);
        },
        finish: async (input) => {
          const token = await this.auth.ensureToken();
          if (!token) return { status: 401, payload: null, error: "no_token" };
          return this.deps.transport.finish(token, input);
        },
        abandon: async (r, d) => {
          const token = await this.auth.ensureToken();
          if (token) {
            try {
              await this.deps.transport.abandon(token, r, d);
            } catch {
            }
          }
          this.log.push("warn", "job_abandon", r, { detail: d });
        },
        onPlaying: (job) => {
          this.heart.start(job.jobId);
          void this.deps.player.play(job.musicName, job.targetMs, "");
        },
        onSettleFailed: (code, msg) => {
          this.log.push("error", "settle_failed", msg, { code });
          this.bus.emit("job:phase", "settle_failed");
        }
      }, this.bus);
      this.heart = new HeartbeatEngine(this.bus, {
        heartbeat: async (input) => {
          const token = await this.auth.ensureToken();
          if (!token) return false;
          try {
            return await this.deps.transport.heartbeat(token, input);
          } catch {
            return false;
          }
        }
      }, deps.adapter, {
        onAbandon: (reason, detail) => {
          this.log.push("error", "heartbeat_abandon", reason, { detail });
          void this.job.abandon(reason, detail);
        },
        onResume: () => this.log.push("info", "hb_resume", "\u6062\u590D\u7EED\u542C")
      });
      deps.player.onProgress((playedMs, positionMs, durationMs) => {
        this.job.updateProgress(playedMs);
        void this.heart.pulse(playedMs, positionMs, durationMs, true);
      });
      this.bus.on("job:current", (j) => {
        if (j) this.log.push("info", "job_start", j.musicName);
      });
    }
    bus = new EventBus();
    auth;
    job;
    heart;
    log;
    async start(autostart) {
      await this.auth.refreshUser();
      if (autostart && this.auth.hasToken()) {
        void this.cycle();
      }
    }
    /** 主循环：领单 → 播 → 结束/失败 → 下一单（带 3s 间隔与退出） */
    async cycle() {
      while (true) {
        const p = await this.job.fetchNext();
        if (p && p.noTargetReason) {
          this.log.push("info", "no_target", String(p.noTargetReason));
          await sleep2(3e3);
          continue;
        }
        await sleep2(3e3);
      }
    }
    _sessionAccepted = false;
    /** 登录页回调（oauth 成功后） */
    acceptSession(p) {
      this.auth.acceptSession(p);
      this.log.push("info", "session", "\u4F1A\u8BDD\u5DF2\u5EFA\u7ACB");
      if (!this._sessionAccepted) {
        this._sessionAccepted = true;
        void this.cycle();
      }
    }
  };
  function sleep2(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ../../packages/ui/src/mh-panel.ts
  var SETTING_PREFIX = "mh_setting_";
  async function getSetting(key, fallback) {
    const k = SETTING_PREFIX + key;
    const g = globalThis;
    if (typeof g.GM_getValue === "function") {
      try {
        const v = g.GM_getValue(k);
        return v === void 0 ? fallback : v;
      } catch {
      }
    }
    if (typeof g.chrome?.storage?.local?.get === "function") {
      try {
        const o = await g.chrome.storage.local.get(k);
        return o?.[k] ?? fallback;
      } catch {
      }
    }
    try {
      const v = globalThis.localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
    }
    return fallback;
  }
  async function setSetting(key, value) {
    const k = SETTING_PREFIX + key;
    const g = globalThis;
    if (typeof g.GM_setValue === "function") {
      try {
        g.GM_setValue(k, value);
        return;
      } catch {
      }
    }
    if (typeof g.chrome?.storage?.local?.set === "function") {
      try {
        await g.chrome.storage.local.set({ [k]: value });
        return;
      } catch {
      }
    }
    try {
      globalThis.localStorage.setItem(k, JSON.stringify(value));
    } catch {
    }
  }
  function maskName(n) {
    if (!n) return "\u2014";
    if (n.length <= 1) return n + "***";
    return n[0] + "***";
  }
  function browserInfo(ua) {
    const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "\u672A\u77E5";
    let b = "\u6D4F\u89C8\u5668", v = "";
    const m = /(?:Chrome|Firefox|Edg|Safari)\/([0-9.]+)/.exec(ua);
    if (m) {
      b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : "Safari";
      v = m[1];
    }
    return `${v ? `${b} ${v}` : b} \xB7 ${os}`;
  }
  function detectClientType() {
    const g = globalThis;
    if (typeof g.GM_getValue === "function") return "userscript";
    if (typeof g.chrome?.storage?.local?.get === "function") return "extension";
    return "client";
  }
  var MhPanel = class _MhPanel extends HTMLElement {
    static define(tag = "mh-panel") {
      if (!customElements.get(tag)) customElements.define(tag, _MhPanel);
    }
    open = false;
    state = {};
    _toastTimer = 0;
    constructor(tokens = "") {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = TEMPLATE.replace("$TOKENS$", tokens);
      this.bind(root);
      requestAnimationFrame(() => this.toggle(true));
      this.attachDrag(root);
      this.restorePos(root);
      void this.hydrateSettings(root);
      this.armAutoCollapse();
      this.addEventListener("mh:diagnose", () => {
        void this.copyDiagnostic(this.buildDiagnostic());
      });
      this.addEventListener("mh:log-append", (e) => {
        const d = e.detail;
        this.pushLog(d?.level ?? "info", d?.text ?? String(d ?? ""));
      });
    }
    /* —— v4：拖动吸附（右上/右中/右下三档 + localStorage 记忆）—— */
    attachDrag(root) {
      const grip = root.querySelector("[data-grip]");
      const panel2 = root.querySelector(".panel");
      if (!grip || !panel2) return;
      grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const r = panel2.getBoundingClientRect();
        const move = (ev) => {
          panel2.style.right = "auto";
          panel2.style.top = "auto";
          panel2.style.left = `${Math.max(8, r.left + ev.clientX - startX)}px`;
          panel2.style.top = `${Math.max(8, r.top + ev.clientY - startY)}px`;
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          const rect = panel2.getBoundingClientRect();
          const vh = window.innerHeight;
          const snappedTop = rect.top < vh * 0.38 ? 66 : rect.bottom > vh * 0.62 ? vh - rect.height - 12 : vh * 0.42;
          const right = Math.max(8, window.innerWidth - rect.right);
          panel2.style.left = "auto";
          panel2.style.top = "auto";
          panel2.style.right = `${right}px`;
          panel2.style.top = `${Math.round(snappedTop)}px`;
          localStorage.setItem("mh-panel-pos", JSON.stringify({ right, top: Math.round(snappedTop) }));
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
    }
    restorePos(root) {
      try {
        const p = JSON.parse(localStorage.getItem("mh-panel-pos") || "null");
        if (p && typeof p.right === "number") {
          const panel2 = root.querySelector(".panel");
          const ball = root.querySelector(".ball");
          for (const el of [panel2, ball]) {
            el.style.top = `${p.top}px`;
            el.style.right = `${p.right}px`;
          }
        }
      } catch {
      }
    }
    /* —— v4：5 分钟无操作自动收起（state.autoCollapse === false 时关闭）—— */
    armAutoCollapse() {
      const t = () => {
        if (this.state.autoCollapse !== false) this.toggle(false);
        this.poke();
      };
      this.poke();
      setInterval(t, 3e5);
    }
    lastPoke = 0;
    poke() {
      this.lastPoke = Date.now();
    }
    /* —— B2：从存储恢复设置到 state，并同步设置 UI —— */
    async hydrateSettings(root) {
      const [songIds, autoStart, onlyHelp, autoCollapse, logReport] = await Promise.all([
        getSetting("songIds", ""),
        getSetting("autoStart", true),
        getSetting("onlyHelp", false),
        getSetting("autoCollapse", false),
        // 默认「始终展开」ON = 不自动收起 → autoCollapse=false
        getSetting("logReport", true)
      ]);
      this.state.songIds = songIds ?? "";
      this.state.autoStart = autoStart ?? true;
      this.state.onlyHelp = onlyHelp ?? false;
      this.state.autoCollapse = autoCollapse ?? false;
      this.state.logReport = logReport ?? true;
      this.syncSettingsUI(root);
    }
    /** 把 state 中的设置写到设置 UI（打开弹层时调用） */
    syncSettingsUI(root) {
      const q = (s) => root.querySelector(s);
      const ta = q("[data-songids]");
      if (ta) ta.value = String(this.state.songIds ?? "");
      const map = [
        ["[data-onlyhelp]", "onlyHelp"],
        ["[data-autostart]", "autoStart"],
        ["[data-autocollapse]", "autoCollapse"],
        ["[data-logreport]", "logReport"]
      ];
      for (const [sel, key] of map) {
        const sw = q(sel);
        if (!sw) continue;
        const on = key === "autoCollapse" ? !Boolean(this.state[key]) : Boolean(this.state[key]);
        sw.classList.toggle("on", on);
      }
    }
    /** 切换设置弹层显示/隐藏 */
    toggleSettings(root, show) {
      const s = root.querySelector("[data-settings]");
      if (!s) return;
      const next = show !== void 0 ? show : s.classList.contains("hidden");
      s.classList.toggle("hidden", !next);
      if (next) this.syncSettingsUI(root);
    }
    /** B2：保存设置 → 持久存储 + 更新 state + toast + 关闭 */
    async saveSettings(root) {
      const q = (s2) => root.querySelector(s2);
      const ta = q("[data-songids]");
      const songIds = ta?.value ?? "";
      const read = (sel) => !!q(sel)?.classList.contains("on");
      const s = {
        songIds,
        autoStart: read("[data-autostart]"),
        onlyHelp: read("[data-onlyhelp]"),
        autoCollapse: !read("[data-autocollapse]"),
        // 开关 ON（始终展开）→ autoCollapse=false
        logReport: read("[data-logreport]")
      };
      await Promise.all([
        setSetting("songIds", s.songIds),
        setSetting("autoStart", s.autoStart),
        setSetting("onlyHelp", s.onlyHelp),
        setSetting("autoCollapse", s.autoCollapse),
        setSetting("logReport", s.logReport)
      ]);
      this.state.songIds = s.songIds;
      this.state.autoStart = s.autoStart;
      this.state.onlyHelp = s.onlyHelp;
      this.state.autoCollapse = s.autoCollapse;
      this.state.logReport = s.logReport;
      this.render();
      q("[data-settings]")?.classList.add("hidden");
      this.toast(root, "\u5DF2\u4FDD\u5B58");
    }
    /** 轻量 toast（面板内短暂提示） */
    toast(root, text) {
      const el = root.querySelector("[data-toast]");
      if (!el) return;
      el.textContent = text;
      el.classList.add("show");
      clearTimeout(this._toastTimer);
      this._toastTimer = window.setTimeout(() => el.classList.remove("show"), 1500);
    }
    /* —— B4：外部调用的日志追加入口（自增 logCount + 更新 [data-log]）—— */
    pushLog(_level, _text) {
      this.setState({ logCount: Math.min(999, Number(this.state.logCount ?? 0) + 1) });
    }
    /* —— B3：面板自身 state 组装脱敏诊断文本 —— */
    buildDiagnostic() {
      const st = this.state;
      const version = st.version ?? "5.1";
      const clientType = st.clientType ?? detectClientType();
      const server = st.server ?? "163music.linyu.qzz.io";
      let displayName = st.displayName;
      if (!displayName && typeof st.title === "string") {
        const m = /已登录\s*·\s*(.*)$/.exec(st.title);
        if (m) displayName = m[1];
      }
      const account = displayName ? `\u5DF2\u767B\u5F55 \xB7 \u6635\u79F0${maskName(String(displayName))}` : "\u672A\u767B\u5F55";
      const online = typeof st.dotOff === "boolean" ? !st.dotOff : true;
      const hb = st.hbText ? String(st.hbText) : "\u2014";
      const help = st.help ?? 0;
      const limit = st.limit ?? 0;
      const settings = `autoStart=${st.autoStart ? 1 : 0} onlyHelp=${st.onlyHelp ? 1 : 0} autoCollapse=${st.autoCollapse ? 1 : 0} logReport=${st.logReport ? 1 : 0}`;
      return [
        "\u{1F3A7} \u7F51\u6613\u4E91\u97F3\u4E50\u4E92\u52A9\u5BA2\u6237\u7AEF\u8BCA\u65AD",
        "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
        `\u7248\u672C    : ${version} (${clientType})`,
        `\u6D4F\u89C8\u5668  : ${browserInfo(typeof navigator !== "undefined" ? navigator.userAgent : "")}`,
        `\u8D26\u53F7    : ${account}`,
        `\u670D\u52A1\u5668  : ${server}`,
        `\u72B6\u6001    : ${online ? "\u5728\u7EBF" : "\u672A\u5728\u7EBF"}`,
        `\u5FC3\u8DF3    : ${hb}`,
        `\u4ECA\u65E5    : ${help}/${limit} \u79D2`,
        `\u8BBE\u7F6E    : ${settings}`,
        "\uFF08token / \u767B\u5F55\u6001\u5DF2\u8131\u654F\uFF09"
      ].join("\n");
    }
    /* —— B3：剪贴板写入优先级 GM.setClipboard → navigator.clipboard → prompt 兜底 —— */
    async copyDiagnostic(text) {
      const g = globalThis;
      if (typeof g.GM_setClipboard === "function") {
        try {
          g.GM_setClipboard(text);
          return true;
        } catch {
        }
      }
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
        }
      }
      try {
        window.prompt("\u590D\u5236\u4EE5\u4E0B\u5185\u5BB9", text);
        return true;
      } catch {
      }
      return false;
    }
    bind(root) {
      const q = (s) => root.querySelector(s);
      q(".ball")?.addEventListener("click", () => this.toggle(true));
      q("[data-min]")?.addEventListener("click", () => this.toggle(false));
      q("[data-log]")?.addEventListener("click", () => this.dispatchEvent(new CustomEvent("mh:log-open")));
      q("[data-diag]")?.addEventListener("click", () => this.dispatchEvent(new CustomEvent("mh:diagnose")));
      q("[data-exit]")?.addEventListener("click", () => this.dispatchEvent(new CustomEvent("mh:logout")));
      q("[data-abandon]")?.addEventListener("click", () => this.dispatchEvent(new CustomEvent("mh:abandon")));
      q("[data-settoggle]")?.addEventListener("click", () => this.toggleSettings(root));
      q("[data-close-settings]")?.addEventListener("click", () => this.toggleSettings(root, false));
      q("[data-goset]")?.addEventListener("click", () => this.toggleSettings(root, true));
      q("[data-save]")?.addEventListener("click", () => {
        void this.saveSettings(root);
      });
      root.querySelectorAll("[data-settings] .sw").forEach((sw) => {
        sw.addEventListener("click", () => sw.classList.toggle("on"));
      });
    }
    toggle(open) {
      this.open = open ?? !this.open;
      const panel2 = this.shadowRoot.querySelector(".panel");
      const ball = this.shadowRoot.querySelector(".ball");
      panel2.classList.toggle("open", this.open);
      ball.style.display = this.open ? "none" : "flex";
    }
    setState(s) {
      this.state = { ...this.state, ...s };
      this.render();
    }
    render() {
      const root = this.shadowRoot;
      const q = (s) => root.querySelector(s);
      const st = this.state;
      if (st.title !== void 0) q("[data-title]").textContent = String(st.title);
      if (st.subtitle !== void 0) q("[data-subtitle]").textContent = String(st.subtitle);
      if (st.dotOff !== void 0) q(".dot") && root.querySelector("[data-title]");
      const ratio = typeof st.ratio === "number" ? st.ratio : 0;
      const C = 2 * Math.PI * 36;
      const ring = root.querySelector("circle[data-ring]");
      if (ring) {
        ring.setAttribute("stroke-dasharray", String(C));
        ring.setAttribute("stroke-dashoffset", String(C * (1 - ratio)));
      }
      q("[data-ringpct]").textContent = `${Math.round(ratio * 100)}%`;
      if (st.help !== void 0) q("[data-help]").textContent = String(st.help);
      if (st.limit !== void 0) q("[data-limit]").textContent = String(st.limit);
      if (st.remaining !== void 0) q("[data-rem]").textContent = `\u5269\u4F59 ${st.remaining} \u79D2`;
      if (st.earned !== void 0) q("[data-earned]").textContent = String(st.earned);
      const taskBox = q("[data-taskbox]");
      if (st.task) {
        taskBox.style.display = "";
        q("[data-song]").textContent = `\u300A${st.task.name ?? "\u2014"}\u300B`;
        q("[data-songtime]").textContent = String(st.task.timeText ?? "0:00 / 0:00");
        if (typeof st.task.playRatio === "number") q("[data-taskbar]").style.width = `${Math.round(st.task.playRatio * 100)}%`;
        if (st.hbText !== void 0) q("[data-hb]").innerHTML = `<b>\u25CF ${st.hbText}</b> \u5FC3\u8DF3`;
      } else {
        taskBox.style.display = "none";
      }
      if (st.recv !== void 0 || st.rec !== void 0) {
        const recvVal = Number(st.recv ?? st.rec ?? 0);
        const recvLim = Number(st.recvLimit ?? st.recLimit ?? 26);
        q("[data-recv]").textContent = `${recvVal} / ${recvLim} \u6B21`;
        const pct = st.recvPct !== void 0 ? Number(st.recvPct) : st.recRatio !== void 0 ? Number(st.recRatio) : recvLim > 0 ? Math.round(recvVal / recvLim * 100) : 0;
        q("[data-recvbar]").style.width = `${Math.min(100, pct)}%`;
        q("[data-recvpct]").textContent = `${pct}%`;
      }
      const body = q("[data-body]");
      if (st.loading) body.classList.add("hidden");
      if (st.loading !== void 0) q("[data-skeleton]").classList.toggle("hidden", !st.loading);
      if (st.empty) {
        q("[data-empty]").classList.remove("hidden");
        body.classList.add("hidden");
      } else q("[data-empty]").classList.add("hidden");
      if (st.logCount !== void 0) q("[data-log]").textContent = `\u65E5\u5FD7 (${Number(st.logCount)})`;
      if (st.dotOff !== void 0) root.querySelector(".dot")?.classList.toggle("off", Boolean(st.dotOff));
    }
  };
  var TEMPLATE = `
<style>
$TOKENS$
  :host{--mh-r:16px;--mh-sh:0 2px 6px rgba(35,38,46,.05),0 12px 32px rgba(35,38,46,.08)}
  .panel{position:fixed;right:18px;top:66px;z-index:2147483000;width:330px;background:var(--mh-card);
    border-radius:var(--mh-r);box-shadow:var(--mh-sh);overflow:hidden;font-family:var(--mh-font);
    color:var(--mh-t1);font-size:13px;transform:translateX(370px);opacity:0;transition:all .22s ease}
  .panel.open{transform:none;opacity:1}
  .ball{position:fixed;right:18px;top:66px;z-index:2147483000;width:44px;height:44px;border-radius:50%;
    background:var(--mh-red);color:#fff;display:flex;align-items:center;justify-content:center;
    box-shadow:0 4px 12px rgba(236,65,65,.35);cursor:pointer;font-size:19px}
  .ic{width:26px;height:26px;border-radius:8px;background:var(--mh-red);display:flex;align-items:center;
    justify-content:center;color:#fff;font-size:14px;flex:none}
  .ic.soft{background:#FDF0F0;color:var(--mh-red);font-size:13px}
  .top{display:flex;align-items:center;gap:10px;padding:15px 17px 0}
  .name{font-weight:700;font-size:13.5px}
  .sub{font-size:11px;color:var(--mh-t2)}
  .sp{flex:1}
  .mini{cursor:pointer;color:var(--mh-t2);font-size:13px}
  .main{display:flex;align-items:center;gap:14px;padding:15px 17px}
  .ring{flex:none}
  .mnum{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.5px;line-height:1.1}
  .mnum .u{font-size:12px;color:var(--mh-t2);font-weight:500}
  .ml{font-size:11.5px;color:var(--mh-t2);margin-top:3px}
  .chip{font-size:11px;color:var(--mh-t2);margin-top:7px}
  .dv{height:1px;background:var(--mh-line);margin:0 17px}
  .row{display:flex;align-items:center;gap:10px;padding:11px 17px}
  .grow{flex:1}
  .sn{font-weight:600;font-size:13px}
  .tm{font-size:12px;color:var(--mh-t2);font-variant-numeric:tabular-nums}
  .bar{height:5px;border-radius:3px;background:var(--mh-track);overflow:hidden;margin:0 17px}
  .bar i{display:block;height:100%;background:var(--mh-red);border-radius:3px;transition:width .4s ease}
  .hbc{font-size:11px;color:var(--mh-t2)} .hbc b{color:var(--mh-ok);font-weight:600}
  .danger{font-size:11.5px;color:var(--mh-danger);cursor:pointer}
  .foot{display:flex;border-top:1px solid var(--mh-line);font-size:12px;color:var(--mh-t2)}
  .foot span{flex:1;text-align:center;padding:11px 0;cursor:pointer}
  .foot span:hover{color:var(--mh-red);background:#FFFBFB}
  .hidden{display:none!important}
  .sk{height:12px;border-radius:6px;background:linear-gradient(90deg,#F1F2F6 25%,#E8EAF0 50%,#F1F2F6 75%);background-size:200% 100%;animation:ld 1.2s infinite}
  @keyframes ld{0%{background-position:200% 0}100%{background-position:-200% 0}}
  .empty{padding:26px 20px;text-align:center}
  .empty .ic{font-size:34px;background:none;color:var(--mh-t2)}
  .empty .t{font-weight:700;margin:10px 0 6px}
  .empty .d{font-size:12px;color:var(--mh-t2);margin-bottom:14px}
  .go{display:inline-block;padding:9px 26px;border-radius:8px;background:var(--mh-red);color:#fff;font-weight:600;cursor:pointer;font-size:12.5px}
  /* \u2014\u2014 B1\uFF1A\u8BBE\u7F6E\u5F39\u5C42 \u2014\u2014 */
  .settings{background:#FBFBFC;border-top:1px solid var(--mh-line);padding:2px 17px 14px;font-size:12px}
  .set-head{display:flex;align-items:center;gap:8px;padding:10px 0 4px;font-weight:700;color:var(--mh-t1);font-size:12.5px}
  .set-x{cursor:pointer;color:var(--mh-t2)}
  .set-title{font-size:11px;color:var(--mh-t2);margin:7px 0 3px}
  .set-songids{width:100%;box-sizing:border-box;border:1px solid var(--mh-line);border-radius:8px;background:var(--mh-card);color:var(--mh-t1);padding:7px 9px;font-family:inherit;font-size:12px;resize:vertical}
  .set-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px}
  .set-row small{color:var(--mh-t2)}
  .sw{width:36px;height:20px;border-radius:10px;background:#E3E4E8;position:relative;cursor:pointer;flex:none;transition:background .18s}
  .sw i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .18s}
  .sw.on{background:var(--mh-red)}
  .sw.on i{left:18px}
  .set-foot{display:flex;align-items:center;gap:10px;margin-top:13px}
  .btn-set{flex:1;text-align:center;padding:8px 0;border-radius:8px;background:#F1F2F6;color:var(--mh-danger);cursor:pointer;font-size:12.5px}
  .btn-save{flex:1;padding:8px 0;border-radius:8px;background:var(--mh-red);color:#fff;font-weight:600;cursor:pointer;font-size:12.5px;border:none}
  .toast{position:absolute;top:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.72);color:#fff;font-size:12px;padding:5px 14px;border-radius:14px;z-index:2;pointer-events:none;opacity:0;transition:opacity .2s}
  .toast.show{opacity:1}
</style>
<div class="ball" part="ball">\u266A</div>
<div class="panel" part="panel">
  <div class="toast" data-toast></div>
  <div class="top">
    <span class="ic">\u266A</span>
    <div><div class="name" data-title>\u5DF2\u767B\u5F55 \xB7 \u4E92\u52A9\u4E2D</div><div class="sub" data-subtitle>\u5728\u7EBF \xB7 \u9759\u9759\u6302\u673A\u4E2D</div></div>
    <div class="sp"></div>
    <span class="mini" data-min>\u2212</span>
  </div>
  <div data-body>
    <div class="main">
      <svg class="ring" width="86" height="86" viewBox="0 0 86 86">
        <circle cx="43" cy="43" r="36" fill="none" stroke="var(--mh-track)" stroke-width="8"/>
        <circle data-ring cx="43" cy="43" r="36" fill="none" stroke="var(--mh-red)" stroke-width="8"
          stroke-linecap="round" transform="rotate(-90 43 43)"/>
        <text data-ringpct x="43" y="47" text-anchor="middle" font-size="15" font-weight="800"
          fill="currentColor" font-family="system-ui">0%</text>
      </svg>
      <div>
        <div class="mnum"><span data-help>0</span><span class="u"> / <span data-limit>9000</span> \u79D2</span></div>
        <div class="ml">\u4ECA\u65E5\u5E2E\u542C\u989D\u5EA6 \xB7 <span data-earned>0</span> \u5206\u949F\u6536\u76CA</div>
        <div class="chip" data-rem>\u5269\u4F59 9000 \u79D2</div>
      </div>
    </div>
    <div class="dv"></div>
    <div data-taskbox style="display:none">
      <div class="row">
        <span class="ic soft">\u25B6</span>
        <div class="grow"><div class="sn" data-song>\u2014</div><div class="tm" data-songtime>0:00 / 0:00</div></div>
        <div class="hbc" data-hb><b>\u25CF \u2014</b> \u5FC3\u8DF3</div><span class="danger" data-abandon>\u653E\u5F03</span>
      </div>
      <div class="bar"><i data-taskbar style="width:0"></i></div>
    </div>
    <div class="dv" style="margin-top:13px"></div>
    <div class="row">
      <span class="ic soft">\u{1F6E1}</span>
      <div class="grow"><div class="sn">\u6211\u88AB\u5E2E\u52A9</div><div class="tm"><span data-recv>0 / 26 \u6B21</span> \xB7 \u4ECA\u665A 21:00 \u6EE1\u989D</div></div>
      <div class="chip" style="font-size:12px"><b data-recvpct>0%</b></div>
    </div>
    <div class="bar"><i data-recvbar style="width:0"></i></div>
  </div>
  <div class="settings hidden" data-settings>
    <div class="set-head">\u9762\u677F\u8BBE\u7F6E<span class="sp"></span><span class="set-x" data-close-settings>\u2715</span></div>
    <div class="set-body">
      <div class="set-title">\u{1F3B5} \u6B4C\u66F2 ID\uFF08\u591A\u4E2A\u56DE\u8F66\u5206\u9694\uFF09</div>
      <textarea class="set-songids" data-songids rows="3" placeholder="1885811597&#10;1599963012"></textarea>
      <div class="set-row"><span>\u53EA\u5E2E\u4E0D\u52A9<small> \u53EA\u6302\u6B4C\u4E0D\u8BF7\u6C42\u5E2E\u52A9</small></span><span class="sw" data-onlyhelp role="switch"><i></i></span></div>
      <div class="set-row"><span>\u81EA\u52A8\u5F00\u542F<small> \u9875\u9762\u52A0\u8F7D\u5373\u81EA\u52A8\u5F00\u59CB</small></span><span class="sw on" data-autostart role="switch"><i></i></span></div>
      <div class="set-row"><span>\u59CB\u7EC8\u5C55\u5F00<small> \u5F00\u542F=\u4E0D\u81EA\u52A8\u6536\u8D77\uFF1B\u5173\u95ED=5\u5206\u949F\u65E0\u64CD\u4F5C\u81EA\u52A8\u6536\u8D77</small></span><span class="sw on" data-autocollapse role="switch"><i></i></span></div>
      <div class="set-row"><span>\u9519\u8BEF\u81EA\u52A8\u4E0A\u62A5<small> \u533F\u540D\u8131\u654F\u540E\u53D1\u670D\u52A1\u7AEF</small></span><span class="sw on" data-logreport role="switch"><i></i></span></div>
    </div>
    <div class="set-foot">
      <span class="btn-set" data-exit>\u9000\u51FA\u767B\u5F55</span>
      <button class="btn-save" data-save>\u4FDD\u5B58</button>
    </div>
  </div>
  <div class="skeleton hidden" data-skeleton>
    <div class="main"><div class="sk" style="width:86px;height:86px;border-radius:50%"></div>
      <div style="flex:1"><div class="sk" style="width:70%"></div><div class="sk" style="width:45%;margin-top:8px"></div></div></div>
    <div class="dv"></div>
    <div class="main"><div class="sk" style="width:88%"></div></div>
  </div>
  <div class="empty hidden" data-empty>
    <div class="ic">\u{1F3A7}</div>
    <div class="t">\u8FD8\u6CA1\u6709\u6B4C\u5728\u542C</div>
    <div class="d">\u53BB\u300C\u8BBE\u7F6E\u300D\u7C98\u8D34\u6B4C\u66F2 ID \u6216\u767B\u5F55\uFF0C\u7ACB\u5373\u5F00\u59CB\u4E92\u52A9</div>
    <span class="go" data-goset>\u53BB\u8BBE\u7F6E</span>
  </div>
  <div class="foot">
    <span data-log>\u65E5\u5FD7 (0)</span><span data-settoggle>\u8BBE\u7F6E</span><span data-diag>\u590D\u5236\u8BCA\u65AD</span>
  </div>
</div>
`;

  // ../../packages/ui/src/index.ts
  var TOKENS = String.raw$tokens;
  function mountPanel(el = document.body) {
    MhPanel.define();
    const panel2 = document.createElement("mh-panel");
    el.appendChild(panel2);
    return panel2;
  }

  // src/main.ts
  var GM = globalThis;
  var BASE = "https://163music.linyu.qzz.io";
  var storage = {
    getToken: () => String(GM.GM_getValue("musicHelperToken", "") || ""),
    setToken: (t) => GM.GM_setValue("musicHelperToken", t),
    clearToken: () => GM.GM_setValue("musicHelperToken", ""),
    getExpires: (k) => Number(GM.GM_getValue(`musicHelper${k === "access" ? "Access" : "Refresh"}ExpiresAt`, "") || 0) || 0,
    setExpires: (k, v) => GM.GM_setValue(`musicHelper${k === "access" ? "Access" : "Refresh"}ExpiresAt`, String(new Date(v).toISOString()))
  };
  var adapter = {
    clientType: "userscript",
    version: "5.1",
    storage,
    probeNetwork: async () => true,
    hasPage: true,
    onLifecycle: (h, cb) => {
      if (h === "freeze") {
        window.addEventListener("pagehide", cb, { capture: true });
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) cb();
        }, { capture: true });
      } else {
        const onVis = () => {
          if (!document.hidden) cb();
        };
        document.addEventListener("visibilitychange", onVis, { capture: true });
      }
    }
  };
  async function api(method, path, body, token = storage.getToken()) {
    const fullUrl = BASE + path;
    const rawBody = body === void 0 ? "" : JSON.stringify(body);
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const sign = token ? await buildSignHeaders(method, fullUrl, rawBody, token, subtleHmac, browserNonce) : null;
    if (sign) {
      headers["X-MH-Nonce"] = sign.a;
      headers["X-MH-Ts"] = sign.t;
      headers["X-MH-Sig"] = sign.s;
    }
    const res = await fetch(fullUrl, { method, headers: { ...headers, "X-Music-Helper-Version": "5.1" }, body: body === void 0 ? void 0 : rawBody });
    const payload = res.status === 200 ? await res.json().catch(() => null) : null;
    return { status: res.status, payload };
  }
  var transport = {
    next: async (token) => api("POST", "/api/next", {}, token),
    finish: async (token, input) => api("POST", "/api/play/finish", input, token),
    abandon: async (token, reason, detail) => {
      await api("POST", "/api/play/abandon", { reason, detail }, token);
    },
    heartbeat: async (token, input) => (await api("POST", "/api/play/heartbeat", input, token)).status === 200,
    refresh: async (token) => (await api("POST", "/auth/refresh", { token }, "")).payload,
    me: () => api("GET", "/api/me"),
    sendLog: async (p) => {
      await api("POST", "/api/client/log", p);
    }
  };
  var player = {
    async play(musicId, _durationMs) {
      const bad = musicId.replace(/^song:/, "");
      const anyWin = unsafeWindow;
      try {
        if (typeof anyWin.player === "object" && anyWin.player && typeof anyWin.player.playById === "function") {
          anyWin.player.playById({ id: Number(bad) });
          return true;
        }
        location.href = `https://music.163.com/#/song?id=${bad}`;
        return true;
      } catch {
        return false;
      }
    },
    stop() {
    },
    onProgress(cb) {
      setInterval(() => {
        const audio = document.querySelector("audio[src]") || document.querySelector("audio");
        if (!audio || !audio.currentTime) return;
        cb(Math.round(audio.currentTime * 1e3), Math.round(audio.currentTime * 1e3), Math.round((audio.duration || 0) * 1e3));
      }, 500);
    }
  };
  var runtime = new ClientRuntime({ adapter, transport, player });
  var panel = mountPanel();
  runtime.bus.on("auth:user", (u) => {
    panel.setState({ title: u ? `\u5DF2\u767B\u5F55 \xB7 ${u.displayName}` : "\u672A\u767B\u5F55", dotOff: !u });
  });
  runtime.bus.on("limits:updated", (s) => panel.setState({
    help: s.helpedToday,
    limit: s.helpedLimit,
    ratio: s.helpedLimit > 0 ? s.helpedToday / s.helpedLimit : 0,
    recv: s.receivedToday,
    recLimit: s.receivedLimit,
    recRatio: s.receivedLimit > 0 ? s.receivedToday / s.receivedLimit : 0
  }));
  runtime.bus.on("job:current", (j) => panel.setState({ task: j ? { name: j.musicName, timeText: "0:00 / 0:00", playRatio: 0 } : null }));
  runtime.bus.on("job:progress", (p) => panel.setState({ task: { name: panel.state.taskName ?? "\u2014", timeText: fmt(p.playedMs), playRatio: 0 } }));
  runtime.bus.on("log:append", () => panel.setState({ logCount: Math.min(99, Number(panel.state.logCount ?? 0) + 1) }));
  function fmt(ms) {
    const s = Math.floor(ms / 1e3);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  var BASE_HOST = new URL(BASE).host;
  var reportLast = {};
  function sanitize(m) {
    return String(m ?? "").replace(/MUSIC_U=[^;&\s"'`]+/gi, "MUSIC_U=***").replace(/mh_ck_[A-Za-z0-9_-]+/gi, "mh_ck_***").replace(/Bearer\s+\S+/gi, "Bearer ***").replace(/[?&]token=[^&\s"'`]+/gi, "token=***");
  }
  function looksOurs(t) {
    const s = String(t ?? "");
    return s.includes(BASE_HOST) || /mh_[a-z_]+/i.test(s) || s.includes("ClientRuntime") || s.includes("mh-panel") || s.includes("@163help/core");
  }
  function reportError(ev, err, trace) {
    const fromErr = err instanceof Error && looksOurs(err.message + " " + String(err.stack ?? ""));
    if (!looksOurs(trace) && !fromErr) return;
    let msg = "";
    if (err instanceof Error) msg = err.message || String(err);
    else if (typeof err === "string") msg = err;
    else if (err && typeof err === "object") msg = String(err.message ?? err);
    else msg = String(err);
    if (!msg) return;
    const now = Date.now();
    if (reportLast[ev] && now - reportLast[ev] < 5 * 6e4) return;
    reportLast[ev] = now;
    if (GM.GM_getValue("mh_setting_logReport", true) === false) return;
    void transport.sendLog({ level: "error", event: ev, msg: sanitize(msg), context: { page: location.href, rurl: location.pathname } }).catch(() => {
    });
  }
  window.addEventListener("error", (e) => reportError("client_error", e.error ?? e.message, `${String(e.filename ?? "")} ${String(e.message ?? "")}`));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (r instanceof Error) reportError("promise_reject", r, `${String(r.stack ?? "")} ${String(r.message ?? "")}`);
  });
  void runtime.start(true);
  unsafeWindow.__mhRuntime = runtime;
})();
