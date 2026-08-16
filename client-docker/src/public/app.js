'use strict';

/**
 * app.js —— 管理 UI 前端逻辑（原生 JS，无框架）。
 *
 * 登录后访问 /api/*；未登录时界面显示登录页。状态区每 5s 轮询 /api/status，
 * 日志自动滚动到底部。配置保存 / 凭证保存 / 启动停止 / 退出登录均走对应接口。
 */

(function () {
  const $ = (id) => document.getElementById(id);

  const loginView = $('login-view');
  const mainView = $('main-view');
  const loginMsg = $('login-msg');

  const CRED_MODE = { key: 'key', ticket: 'ticket' };

  // —— 工具 ——
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

  function badge(text, cls) {
    return '<span class="badge ' + cls + '">' + escapeHtml(text) + '</span>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // —— 视图切换 ——
  function showLogin() {
    loginView.classList.remove('hidden');
    mainView.classList.add('hidden');
  }

  function showMain() {
    loginView.classList.add('hidden');
    mainView.classList.remove('hidden');
    refreshStatus();
    refreshConfigForm();
  }

  // —— 登录 / 退出 ——
  async function doLogin() {
    const password = $('login-password').value;
    loginMsg.textContent = '';
    if (!password) { loginMsg.textContent = '请输入密码'; return; }
    try {
      await post('/api/login', { password });
      showMain();
    } catch (e) {
      loginMsg.textContent = e.status === 429 ? '尝试过于频繁，请稍后再试' : e.message;
    }
  }

  async function doLogout() {
    try {
      await post('/api/logout', {});
    } catch (e) { /* 忽略 */ }
    location.reload();
  }

  // —— 状态轮询 ——
  function renderStatus(s) {
    const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };

    set('st-browser', s.running.browser ? badge('运行中', 'run') : badge('已停止', 'stop'));
    set('st-orchestrator', s.running.orchestrator ? badge('运行中', 'run') : badge('已停止', 'stop'));

    const acct = s.account;
    set('st-account', acct
      ? '<span class="val">' + escapeHtml(acct.displayName) + ' <span class="hint">(id=' + escapeHtml(acct.userId) + ')</span></span>'
      : badge('未绑定', 'blank'));

    if (s.task && (s.task.songName || s.task.jobId)) {
      const parts = [];
      if (s.task.songName) parts.push('<span class="task-name">' + escapeHtml(s.task.songName) + '</span>');
      if (s.task.jobId != null) parts.push('jobId=' + escapeHtml(s.task.jobId));
      if (s.task.progress != null) parts.push(escapeHtml(s.task.progress));
      set('st-task', parts.join(' · '));
    } else {
      set('st-task', badge('空闲', 'idle'));
    }

    set('st-helped', String(s.today && s.today.helped != null ? s.today.helped : 0));
    set('st-received', String(s.today && s.today.received != null ? s.today.received : 0));
    set('st-points', String(s.points != null ? s.points : 0));

    const modeMap = { key: '密钥（client key）', token: 'token（session）', unconfigured: '未配置' };
    set('st-cred-mode', s.credentialMode === 'unconfigured'
      ? badge('未配置', 'blank')
      : '<span class="val">' + (modeMap[s.credentialMode] || s.credentialMode) + '</span>'
        + (s.credentialPreview ? ' <span class="hint">' + escapeHtml(s.credentialPreview) + '…</span>' : ''));
  }

  function renderLogs(logs) {
    const panel = $('log-panel');
    if (!panel || !Array.isArray(logs)) return;
    panel.innerHTML = logs.map((l) => '<div class="log-line">' + escapeHtml(l) + '</div>').join('');
    panel.scrollTop = panel.scrollHeight;
  }

  async function refreshStatus() {
    try {
      const s = await api('/api/status');
      renderStatus(s);
      renderLogs(s.logs);
    } catch (e) {
      if (e.status === 401) { showLogin(); return; }
      // 网络/服务器错误：静默，下轮重试。
    }
  }

  // —— 配置表单 ——
  async function refreshConfigForm() {
    try {
      const s = await api('/api/status');
      // 凭证模式回填不足够（仅前缀），配置文本框保持空，仅同步偏好与窗口。
      if (s.activeWindow) {
        $('cfg-window-start').value = s.activeWindow.start || '';
        $('cfg-window-end').value = s.activeWindow.end || '';
      }
    } catch (e) { /* 忽略 */ }
  }

  function windowSpanHours(start, end) {
    if (!start || !end) return 0;
    const toMin = (t) => { const p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); };
    let span = toMin(end) - toMin(start);
    if (span <= 0) span += 24 * 60;
    return span / 60;
  }

  async function saveConfig() {
    const msg = $('cfg-msg');
    msg.textContent = '';
    msg.className = 'msg';

    const cookies = $('cfg-cookies').value;
    const credType = document.querySelector('input[name="cred-type"]:checked').value;
    const credential = $('cfg-credential').value;

    let preference = $('cfg-preference').value;
    if (!['short', 'long', 'random'].includes(preference)) preference = 'random';

    const windowStart = $('cfg-window-start').value;
    const windowEnd = $('cfg-window-end').value;

    // 前端预校验跨度（与后端 16h 上限一致）
    if (windowStart && windowEnd) {
      const span = windowSpanHours(windowStart, windowEnd);
      if (span > 16) {
        $('cfg-window-hint').textContent = '跨度超过 16 小时上限，不可保存';
        $('cfg-window-hint').className = 'hint err';
        msg.textContent = '保存失败：活跃窗口跨度超过 16 小时上限';
        msg.className = 'msg err';
        return;
      }
    }
    $('cfg-window-hint').textContent = '';
    $('cfg-window-hint').className = 'hint';

    // 凭证：key 需以 mh_ck_ 开头；ticket 直接送
    let toSend = {};
    if (credential && credential.trim()) {
      if (credType === 'key' && !credential.trim().startsWith('mh_ck_')) {
        msg.textContent = '保存失败：密钥必须以 mh_ck_ 开头';
        msg.className = 'msg err';
        return;
      }
      toSend.credential = credential.trim();
      if (credType === 'ticket') toSend.ticket = credential.trim();
    }

    toSend.cookies = cookies;
    toSend.preference = preference;
    toSend.windowStart = windowStart;
    toSend.windowEnd = windowEnd;

    try {
      const r = await post('/api/config', toSend);
      msg.textContent = '已保存';
      msg.className = 'msg ok';
      if (r.credentialMode) {
        const modeMap = { key: '密钥模式', token: 'token 模式', unconfigured: '未配置' };
        $('cfg-credential-hint').textContent = '当前凭证模式：' + (modeMap[r.credentialMode] || r.credentialMode);
      }
      $('cfg-credential').value = '';
    } catch (e) {
      msg.textContent = '保存失败：' + e.message;
      msg.className = 'msg err';
    }
  }

  // —— 控制 ——
  async function control(action) {
    const msg = $('ctl-msg');
    msg.textContent = '';
    msg.className = 'msg';
    try {
      await post('/api/control', { action });
      msg.textContent = action === 'start' ? '已发送启动指令' : '已发送停止指令';
      msg.className = 'msg ok';
      refreshStatus();
    } catch (e) {
      msg.textContent = '操作失败：' + e.message;
      msg.className = 'msg err';
    }
  }

  // —— 绑定事件 ——
  function bind() {
    $('login-btn').addEventListener('click', doLogin);
    $('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    $('logout-btn').addEventListener('click', doLogout);

    $('cfg-save-btn').addEventListener('click', saveConfig);
    $('ctl-start-btn').addEventListener('click', () => control('start'));
    $('ctl-stop-btn').addEventListener('click', () => control('stop'));

    document.querySelectorAll('input[name="cred-type"]').forEach((r) => {
      r.addEventListener('change', () => {
        const v = r.value;
        $('cfg-credential').placeholder = v === 'key'
          ? '粘贴密钥（mh_ck_ 开头）'
          : '粘贴 ticket';
      });
    });
  }

  // —— 启动 ——
  async function boot() {
    bind();
    // 默认选中 key 模式
    const keyRadio = document.querySelector('input[name="cred-type"][value="key"]');
    if (keyRadio) {
      keyRadio.checked = true;
      $('cfg-credential').placeholder = '粘贴密钥（mh_ck_ 开头）';
    }

    // 探测是否已登录：能访问 /api/status 即已登录
    let authed = false;
    try {
      await api('/api/status');
      authed = true;
    } catch (e) {
      authed = false;
    }

    if (authed) {
      showMain();
    } else {
      showLogin();
    }

    // 每 5s 轮询状态（仅登录后）
    setInterval(() => {
      if (!mainView.classList.contains('hidden')) refreshStatus();
    }, 5000);
  }

  boot();
})();
