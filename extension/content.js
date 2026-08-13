/* ============================================================
 * 网易云音乐互助播放脚本 —— Chrome MV3 扩展 content script
 *
 * 本文件由 Tampermonkey 油猴脚本 music-help.user.js 移植而来。
 * 内容脚本运行于 MAIN world（见 manifest.json 中 "world": "MAIN"），
 * 以便访问网易云页面自身的播放器对象 window.player
 * （getSafePlayer() 依赖 window.player / uw.player）。
 *
 * 下面是与油猴脚本的 GM_* API 对应的浏览器原生替代实现（shim）。
 * 其余业务逻辑与油猴脚本逐行一致，未作任何改动。
 * ============================================================ */

/* GM_getValue(key, defaultVal) -> localStorage，取不到（null）时返回 defaultVal */
function GM_getValue(key, defaultVal) {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? defaultVal : raw;
    } catch (e) {
        return defaultVal;
    }
}

/* GM_setValue(key, val) -> localStorage.setItem(key, String(val)) */
function GM_setValue(key, val) {
    try {
        localStorage.setItem(key, String(val));
    } catch (e) {}
}

/* GM_addStyle(css) -> 新建 <style> 元素注入 <head> */
function GM_addStyle(css) {
    try {
        const style = document.createElement('style');
        style.setAttribute('type', 'text/css');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
        return style;
    } catch (e) {}
}

/* GM_xmlhttpRequest(options) -> 用 fetch 实现
 * 回调形状保持与油猴脚本一致：
 *   onload   -> onload({ responseText, status })
 *   onerror  -> 网络/解析失败时调用
 *   ontimeout-> 超时（options.timeout 毫秒）时调用
 *
 * 注意：这里没有设置 credentials:'include'。服务端 CORS 为
 * Access-Control-Allow-Origin: *，携带凭据会被浏览器拦截；接口为
 * Bearer Token 鉴权，不需要 Cookie。
 */
function GM_xmlhttpRequest(options) {
    const method = String((options && options.method) || 'GET').toUpperCase();
    const url = String((options && options.url) || '');
    const headers = (options && options.headers) || {};
    const rawData = (options && options.data != null) ? options.data : null;
    const timeoutMs = Number((options && options.timeout) || 0);

    let controller = null;
    let timer = null;
    if (timeoutMs > 0) {
        controller = new AbortController();
        timer = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs);
    }

    const requestInit = { method: method, headers: headers };
    if (rawData !== null) requestInit.body = String(rawData);
    if (controller) requestInit.signal = controller.signal;

    fetch(url, requestInit)
        .then(function (res) {
            if (timer) clearTimeout(timer);
            return res.text().then(function (responseText) {
                if (options && typeof options.onload === 'function') {
                    options.onload({ responseText: responseText, status: res.status });
                }
            });
        })
        .catch(function (err) {
            if (timer) clearTimeout(timer);
            if (err && err.name === 'AbortError') {
                if (options && typeof options.ontimeout === 'function') options.ontimeout();
            } else {
                if (options && typeof options.onerror === 'function') options.onerror(err);
            }
        });

    return {
        abort: function () {
            if (timer) clearTimeout(timer);
            if (controller) controller.abort();
        },
    };
}

(function() {
    'use strict';
    if (window.self !== window.top) return;

    const API_BASE = 'https://163music.linyu.qzz.io/api';
    const CURRENT_VERSION = '4.0.11';
    const UPDATE_FALLBACK_URL = 'https://163music.linyu.qzz.io/music-help.user.js';
    const TOKEN_KEY = 'musicHelperToken';
    const LEGACY_TOKEN_KEY = 'linuxDoToken';
    const ACCESS_EXPIRES_AT_KEY = 'musicHelperAccessExpiresAt';
    const REFRESH_EXPIRES_AT_KEY = 'musicHelperRefreshExpiresAt';
    const ERROR_KEY = 'musicHelperLastError';
    const TAB_LOCK_KEY = 'musicHelperActiveTabLock';
    const TAB_ID_KEY = 'musicHelperTabId';
    const RISK_ACCEPTED_KEY = 'musicHelperRiskAcceptedV1';
    const RISK_NOTICE_TEXT = [
        '使用前请确认：本脚本仅用于个人学习、研究与浏览器自动化实践，不提供音乐内容、不破解会员权益、不绕过版权或付费限制。',
        '请遵守网易云音乐、Linux.do、浏览器扩展平台及所在地区法律法规和服务条款。因使用脚本产生的账号、数据、版权、合规或其他风险由使用者自行承担。',
        '如果你不同意以上说明，请立即停用并删除本脚本。'
    ].join('\n');
    const JOIN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
    const TOKEN_REFRESH_SKEW_MS = 5000;
    const TAB_LOCK_HEARTBEAT_MS = 5000;
    const TAB_LOCK_STALE_MS = 15000;

    let isHelperRunning = false;
    let monitorTimer = null;
    let joinTimer = null;
    let authConfig = null;
    let isDragging = false;
    let activeJoinState = null;
    let upgradeRequired = false;
    let refreshPromise = null;
    let tabLockTimer = null;
    let tabLockOwned = false;
    let currentParticipantCredits = null;
    let currentEarnedHelpStats = null;
    let activityStats = null;
    let autoStartTriggered = false;

    const TAB_INSTANCE_ID = getOrCreateTabInstanceId();

    function safeJSON(text) { try { return JSON.parse(text); } catch (e) { return null; } }
    function getUnsafeWindow() { try { return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window; } catch(e) { return window; } }
    function getSafePlayer() { try { const uw = getUnsafeWindow(); return window.player || uw.player || null; } catch(e) { return null; } }

    function createLocalInstanceId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    function getOrCreateTabInstanceId() {
        try {
            const existing = sessionStorage.getItem(TAB_ID_KEY);
            if (existing) return existing;
            const created = createLocalInstanceId();
            sessionStorage.setItem(TAB_ID_KEY, created);
            return created;
        } catch (e) {
            return createLocalInstanceId();
        }
    }

    function readTabLock() {
        try {
            const raw = localStorage.getItem(TAB_LOCK_KEY);
            return raw ? safeJSON(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function isTabLockStale(lock) {
        const updatedAt = Number(lock && lock.updatedAt || 0);
        return !updatedAt || Date.now() - updatedAt > TAB_LOCK_STALE_MS;
    }

    function writeTabLock() {
        try {
            localStorage.setItem(TAB_LOCK_KEY, JSON.stringify({
                id: TAB_INSTANCE_ID,
                updatedAt: Date.now(),
            }));
        } catch (e) {}
    }

    function releaseTabLock() {
        if (tabLockTimer) {
            clearInterval(tabLockTimer);
            tabLockTimer = null;
        }
        try {
            const lock = readTabLock();
            if (lock && lock.id === TAB_INSTANCE_ID) {
                localStorage.removeItem(TAB_LOCK_KEY);
            }
        } catch (e) {}
        tabLockOwned = false;
    }

    function tryAcquireTabLock() {
        const current = readTabLock();
        if (!current || current.id === TAB_INSTANCE_ID || isTabLockStale(current)) {
            writeTabLock();
            const confirmed = readTabLock();
            tabLockOwned = !!(confirmed && confirmed.id === TAB_INSTANCE_ID);
            return tabLockOwned;
        }
        tabLockOwned = false;
        return false;
    }

    function startTabLockHeartbeat() {
        if (!tryAcquireTabLock()) return false;
        if (tabLockTimer) clearInterval(tabLockTimer);
        tabLockTimer = setInterval(() => {
            if (!tryAcquireTabLock()) {
                releaseTabLock();
                handleTabConflict();
            }
        }, TAB_LOCK_HEARTBEAT_MS);
        return true;
    }

    function ensureSingleTabLock() {
        const token = GM_getValue(TOKEN_KEY, '');
        if (!token) {
            releaseTabLock();
            return true;
        }
        if (tabLockOwned && tryAcquireTabLock()) return true;
        if (startTabLockHeartbeat()) return true;
        handleTabConflict();
        return false;
    }

    function triggerIframePlay() {
        try {
            const frame = document.getElementById('g_iframe');
            if (!frame || !frame.contentDocument) return false;
            const doc = frame.contentDocument;
            const playBtn = doc.querySelector('.u-btni-play') || doc.querySelector('[data-res-action="play"]') || doc.querySelector('#playall') || doc.querySelector('.u-btn2-2');
            if (playBtn) {
                ['mousedown', 'mouseup', 'click'].forEach(t => playBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, view: frame.contentWindow })));
                return true;
            }
        } catch (e) {}
        return false;
    }

    function getProgress() {
        let cur = 0, dur = 0, state = '';
        const p = getSafePlayer();
        try { if (p && typeof p.getDuration === 'function' && p.getDuration() > 0) return { cur: p.getPosition(), dur: p.getDuration(), state: p.getState ? p.getState() : '' }; } catch(e) {}
        try {
            const timeEl = document.querySelector('.g-btmbar .time');
            if (timeEl) {
                const parts = timeEl.innerText.split('/').map(s => s.trim());
                if (parts.length === 2) {
                    const toMs = (t) => { const [m, s] = t.split(':').map(Number); return (m * 60 + s) * 1000; };
                    cur = toMs(parts[0]); dur = toMs(parts[1]);
                }
            }
            const playBtn = document.querySelector('.g-btmbar .ply');
            state = (playBtn && playBtn.classList.contains('pas')) ? 'play' : 'stop';
        } catch(e) {}
        return { cur, dur, state };
    }

    function getPlaybackRate() {
        try {
            const p = getSafePlayer();
            if (p && p.audio && Number.isFinite(Number(p.audio.playbackRate))) {
                return Number(p.audio.playbackRate);
            }
        } catch (e) {}
        try {
            const audio = document.querySelector('audio');
            if (audio && Number.isFinite(Number(audio.playbackRate))) {
                return Number(audio.playbackRate);
            }
        } catch (e) {}
        return 1;
    }

    function getCurrentPlayingSongId() {
        try {
            const selectors = [
                '.m-playbar .words .name a[href*="song?id="]',
                '.m-playbar .words a.name[href*="song?id="]',
                '.m-playbar .words a[href*="song?id="]',
            ];
            for (const selector of selectors) {
                const currentLink = document.querySelector(selector);
                const songId = currentLink ? extractSongId(currentLink.getAttribute('href')) : '';
                if (songId) return songId;
            }
        } catch (e) {}
        return '';
    }

    function getQueueCount() {
        try {
            const panelBtn = document.querySelector('.m-playbar a[data-action="panel"]');
            const count = Number((panelBtn && panelBtn.textContent || '').trim());
            return Number.isFinite(count) ? count : 0;
        } catch (e) {}
        return 0;
    }

    async function ensurePlaybarExpanded() {
        try {
            const hand = document.querySelector('.g-btmbar .hand, .m-playbar .hand');
            if (!hand) return false;
            const title = String(hand.getAttribute('title') || '').trim();
            if (title.includes('展开播放条')) {
                hand.click();
                await wait(300);
                return true;
            }
        } catch (e) {}
        return false;
    }

    function getVisibleQueuePanelState() {
        const panelBtn = document.querySelector('.m-playbar a[data-action="panel"]');
        const clearButton = Array.from(document.querySelectorAll('.m-playbar a, .m-playbar button, .m-layer a, .m-layer button'))
            .find((node) => {
                const text = String(node.textContent || '').trim();
                const title = String(node.getAttribute('title') || '').trim();
                const aria = String(node.getAttribute('aria-label') || '').trim();
                return text === '清除' || title === '清除' || aria === '清除';
            });
        return {
            queueCount: getQueueCount(),
            panelButtonVisible: !!(panelBtn && panelBtn.offsetParent !== null),
            clearButton,
        };
    }

    async function openQueuePanelBestEffort() {
        const panelBtn = document.querySelector('.m-playbar a[data-action="panel"]');
        if (!panelBtn) return null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            panelBtn.click();
            await wait(350 + attempt * 150);
            const state = getVisibleQueuePanelState();
            if (state.clearButton) {
                return state;
            }
        }
        return getVisibleQueuePanelState();
    }

    function ensureTargetSong(targetSongId) {
        if (!targetSongId) return;
        const currentHashSongId = extractSongId(window.location.hash);
        if (currentHashSongId !== String(targetSongId)) {
            window.location.hash = `#/song?id=${targetSongId}`;
        }
    }

    async function forcePlayTargetSong(targetSongId) {
        if (!targetSongId) return false;
        ensureTargetSong(targetSongId);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const currentHashSongId = extractSongId(window.location.hash);
            if (currentHashSongId !== String(targetSongId)) {
                ensureTargetSong(targetSongId);
                await wait(400);
                continue;
            }

            const clicked = triggerIframePlay();
            await wait(clicked ? 1200 : 600);
            if (getCurrentPlayingSongId() === String(targetSongId)) {
                return true;
            }
        }
        return false;
    }

    function stopPlaybackBestEffort() {
        try {
            const p = getSafePlayer();
            if (p && typeof p.stop === 'function') {
                p.stop();
                return;
            }
            if (p && typeof p.pause === 'function') p.pause();
        } catch(e) {}
        try {
            const audio = document.querySelector('audio');
            if (audio && typeof audio.pause === 'function') audio.pause();
        } catch(e) {}
        try {
            const playBtn = document.querySelector('.g-btmbar .ply');
            if (playBtn && playBtn.classList.contains('pas')) playBtn.click();
        } catch(e) {}
    }

    async function clearPlayQueueBestEffort(options = {}) {
        await ensurePlaybarExpanded();
        const panelBtn = document.querySelector('.m-playbar a[data-action="panel"]');
        if (!panelBtn) return false;
        const queueCount = getQueueCount();
        const includeSingle = !!options.includeSingle;
        if (includeSingle ? queueCount <= 0 : queueCount <= 1) return false;

        const clearKeywords = ['清空', '清除', '删除全部', '清空列表', 'Clear'];
        const selectors = [
            '.m-playbar .listhdc a',
            '.m-playbar .listhdc .clear',
            '.m-playbar .listbd a',
            '.m-playbar .listlyric a',
            '.m-playbar a',
            '.m-playbar button',
            '.m-layer a',
            '.m-layer button',
        ];

        const findClearButton = () => {
            const exactMatches = [];
            for (const selector of selectors) {
                const nodes = document.querySelectorAll(selector);
                for (const node of nodes) {
                    const text = String(node.textContent || '').trim();
                    const title = String(node.getAttribute('title') || '').trim();
                    const aria = String(node.getAttribute('aria-label') || '').trim();
                    if (text === '清除' || title === '清除' || aria === '清除') {
                        exactMatches.push(node);
                        continue;
                    }
                    if (clearKeywords.some((keyword) => text.includes(keyword) || title.includes(keyword) || aria.includes(keyword))) {
                        exactMatches.push(node);
                    }
                }
            }
            return exactMatches[0] || null;
        };

        try {
            let state = await openQueuePanelBestEffort();
            let clearBtn = state && state.clearButton ? state.clearButton : findClearButton();
            if (!clearBtn) return false;

            clearBtn.click();
            await wait(500);

            const confirmBtn = Array.from(document.querySelectorAll('.m-layer a, .m-layer button, .z-show a, .z-show button'))
                .find((node) => {
                    const text = String(node.textContent || '').trim();
                    return /确定|确认|清空|是/.test(text);
                });
            if (confirmBtn) {
                confirmBtn.click();
                await wait(500);
            }
            const finalCount = getQueueCount();
            return includeSingle ? finalCount <= 0 : finalCount <= 1;
        } catch (e) {
            return false;
        } finally {
            try {
                panelBtn.click();
            } catch (e) {}
        }
    }

    async function idleCleanupPlaybackBestEffort() {
        stopPlaybackBestEffort();
        await clearPlayQueueBestEffort({ includeSingle: true });
        stopPlaybackBestEffort();
    }

    async function prepareTargetPlayback(targetSongId) {
        if (!targetSongId) return false;
        if (!await isPlayableSong(targetSongId)) return false;
        try { const p = getSafePlayer(); if(p && p.stop) p.stop(); } catch(e) {}
        ensureTargetSong(targetSongId);
        await wait(600);
        await clearPlayQueueBestEffort();
        const forcePlayed = await forcePlayTargetSong(targetSongId);
        await wait(600);
        await clearPlayQueueBestEffort();
        return forcePlayed;
    }

    function formatTime(ms) { if (isNaN(ms) || ms <= 0) return "00:00"; const s = Math.floor(ms / 1000); return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; }
    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
    function normalizeVersion(value) {
        const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
        return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
    }
    function compareVersions(left, right) {
        const a = normalizeVersion(left).split('.').map(n => Number(n || 0));
        const b = normalizeVersion(right).split('.').map(n => Number(n || 0));
        for (let i = 0; i < 3; i += 1) {
            const delta = (a[i] || 0) - (b[i] || 0);
            if (delta !== 0) return delta > 0 ? 1 : -1;
        }
        return 0;
    }
    function getUpdateUrl() {
        return (authConfig && authConfig.updateUrl) || UPDATE_FALLBACK_URL;
    }
    function getPortalUrl() {
        let base = '';
        if (authConfig) {
            if (authConfig.baseUrl) {
                base = String(authConfig.baseUrl);
            } else if (authConfig.loginUrl) {
                try { base = new URL(authConfig.loginUrl).origin; } catch (e) { base = ''; }
            }
        }
        if (!base) base = API_BASE.replace(/\/api$/, '');
        return base.replace(/\/+$/, '') + '/portal';
    }

    function showUpdateButton(label = '更新脚本') {
        const updateButton = document.getElementById('update-script-btn');
        const headerUpdateLink = document.getElementById('header-update-link');
        if (updateButton) {
            updateButton.innerText = label;
            updateButton.style.display = 'block';
        }
        if (headerUpdateLink) {
            headerUpdateLink.innerText = label;
            headerUpdateLink.style.display = 'block';
        }
    }
    function getErrorText(code) {
        if (code === 'banned') return '当前账号已被管理员封禁，互助与登录态已失效。';
        if (code === 'registration_required') return '当前账号尚未完成注册，请先完成开通流程。';
        if (code === 'invalid_or_expired_token') return '登录态已失效，请重新登录。';
        if (code === 'token_session_conflict') return '当前账号已在其他设备重新登录，当前页面登录态已失效。';
        if (code === 'tab_conflict') return '当前账号已经在另一个标签页运行，本页已停止服务。';
        if (code === 'client_upgrade_required') return '当前脚本版本过旧，请先更新到最新版本后再继续使用。';
        if (code === 'service_paused') return '北京时间每日 0:00-8:00 暂停互助，请 8:00 后再试。';
        if (code === 'service_d1_blocked') return '服务保护阈值已触发，已临时自动限流，请稍后再试。';
        if (code === 'service_manual_blocked') return '服务已被管理员临时暂停，请稍后再试。';
        if (code === 'service_window_closed') return '当前不在开放使用日期内，请在管理员设置的开放日期内使用。';
        return code ? `发生错误：${code}` : '';
    }

    function getPayloadErrorText(payload, fallbackCode = '') {
        const errorCode = (payload && payload.error) || fallbackCode;
        return (payload && payload.message) || getErrorText(errorCode) || '访问受限';
    }

    function isApiErrorPayload(payload) {
        return !!(payload && typeof payload === 'object' && payload.error);
    }

    function isServicePauseError(code) {
        return code === 'service_paused' || code === 'service_d1_blocked' || code === 'service_manual_blocked' || code === 'service_window_closed';
    }

    function handleAccessError(code, messageOverride = '') {
        const text = messageOverride || getErrorText(code);
        stopHelper();
        clearStoredToken(code || 'unknown');
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        const authSection = document.getElementById('auth-section');
        const helperForm = document.getElementById('helper-form');
        const logoutLink = document.getElementById('logout-link');
        if (loginStatus) loginStatus.innerText = text || '访问受限';
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = text || '访问受限';
            setHelperInfoStyle('warn');
        }
        if (authSection) authSection.style.display = 'block';
        if (helperForm) helperForm.style.display = 'none';
        if (logoutLink) logoutLink.style.display = 'none';
    }

    function handleTabConflict() {
        stopHelper();
        GM_setValue(ERROR_KEY, 'tab_conflict');
        const text = getErrorText('tab_conflict');
        const token = GM_getValue(TOKEN_KEY, '');
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        const authSection = document.getElementById('auth-section');
        const helperForm = document.getElementById('helper-form');
        const logoutLink = document.getElementById('logout-link');
        if (loginStatus) loginStatus.innerText = token ? `已登录，${text}` : text;
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = text;
            setHelperInfoStyle('warn');
        }
        if (authSection) authSection.style.display = token ? 'none' : 'block';
        if (helperForm) helperForm.style.display = token ? 'block' : 'none';
        if (logoutLink) logoutLink.style.display = token ? 'block' : 'none';
    }

    function handleServicePaused(payload = null) {
        const errorCode = (payload && payload.error) || 'service_paused';
        const text = (payload && payload.message) || getErrorText(errorCode);
        stopHelper();
        GM_setValue(ERROR_KEY, errorCode);
        const token = GM_getValue(TOKEN_KEY, '');
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        const authSection = document.getElementById('auth-section');
        const helperForm = document.getElementById('helper-form');
        const logoutLink = document.getElementById('logout-link');
        if (loginStatus) loginStatus.innerText = token ? `已登录，${text}` : text;
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = text;
            setHelperInfoStyle('warn');
        }
        if (authSection) authSection.style.display = token ? 'none' : 'block';
        if (helperForm) helperForm.style.display = token ? 'block' : 'none';
        if (logoutLink) logoutLink.style.display = token ? 'block' : 'none';
    }

    function handleClaimFailure(result) {
        const payload = result && result.payload ? result.payload : null;
        const status = Number(result && result.status || 0);
        if (payload && isServicePauseError(payload.error)) {
            handleServicePaused(payload);
            return;
        }
        if (payload && payload.error) {
            handleAccessError(payload.error, payload.message || '');
            return;
        }
        const message = status === 0 ? '服务器连接失败，请稍后重试。' : '登录失败，请稍后重试。';
        GM_setValue(ERROR_KEY, '');
        stopHelper();
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        if (loginStatus) loginStatus.innerText = message;
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = message;
            setHelperInfoStyle('warn');
        }
    }

    function showUpgradeRequired(requiredVersion, latestVersion) {
        upgradeRequired = true;
        stopHelper();
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        const authSection = document.getElementById('auth-section');
        const helperForm = document.getElementById('helper-form');
        const loginButton = document.getElementById('login-linuxdo');
        const updateButton = document.getElementById('update-script-btn');
        const requiredText = normalizeVersion(requiredVersion) || (authConfig && authConfig.minSupportedVersion) || '';
        const latestText = normalizeVersion(latestVersion) || (authConfig && authConfig.latestVersion) || '';
        const title = requiredText
            ? `脚本版本过旧，最低支持版本为 v${requiredText}`
            : '脚本版本过旧，请先更新';
        const detail = latestText && latestText !== requiredText
            ? `当前最新版本：v${latestText}`
            : '';
        if (loginStatus) loginStatus.innerText = title;
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = `${title}${detail ? `\n${detail}` : ''}\n点击下方按钮安装最新版脚本。`;
            setHelperInfoStyle('warn');
        }
        if (authSection) authSection.style.display = 'block';
        if (helperForm) helperForm.style.display = 'none';
        if (loginButton) loginButton.style.display = 'none';
        if (updateButton) {
            updateButton.innerText = '立即更新脚本';
            updateButton.style.display = 'block';
        }
    }

    async function fetchJSON(path) {
        try {
            const res = await fetch(path, { credentials: 'include' });
            return safeJSON(await res.text());
        } catch (e) {
            return null;
        }
    }

    async function fetchSongDetail(songId) {
        const normalizedSongId = String(songId || '').trim();
        if (!/^\d+$/.test(normalizedSongId)) return null;
        const data = await fetchJSON(`/api/song/detail/?ids=${encodeURIComponent(JSON.stringify([Number(normalizedSongId)]))}`);
        const songs = Array.isArray(data && data.songs) ? data.songs : [];
        return songs.find(item => String(item && item.id ? item.id : '') === normalizedSongId) || null;
    }

    async function fetchPlayableSongIds(songIds) {
        const normalized = Array.from(new Set((songIds || [])
            .map(id => String(id || '').trim())
            .filter(id => /^\d+$/.test(id))));
        const playable = new Set();
        for (let i = 0; i < normalized.length; i += 80) {
            const chunk = normalized.slice(i, i + 80);
            const numericIds = chunk.map(id => Number(id));
            const data = await fetchJSON(`/api/song/enhance/player/url?ids=${encodeURIComponent(JSON.stringify(numericIds))}&br=128000`);
            const rows = Array.isArray(data && data.data) ? data.data : [];
            rows.forEach(item => {
                const id = String(item && item.id ? item.id : '').trim();
                const url = String(item && item.url ? item.url : '').trim();
                const code = Number(item && item.code || 0);
                if (id && url && (!code || code === 200)) playable.add(id);
            });
        }
        return playable;
    }

    async function isPlayableSong(songId) {
        const detail = await fetchSongDetail(songId);
        const durationMs = Number(detail && (detail.dt || detail.duration || 0));
        if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
        const playable = await fetchPlayableSongIds([songId]);
        return playable.has(String(songId));
    }

    async function fetchSongDuration(songId) {
        const detail = await fetchSongDetail(songId);
        const durationMs = Number(detail && (detail.dt || detail.duration || 0));
        if (Number.isFinite(durationMs) && durationMs > 0) {
            const playable = await fetchPlayableSongIds([songId]);
            if (playable.has(String(songId))) return Math.floor(durationMs);
        }

        const currentSongId = extractSongId(window.location.hash);
        const { dur, state } = getProgress();
        if (currentSongId === String(songId) && dur > 0 && state === 'play') return dur;
        return 0;
    }

    async function fetchAlbumTracks(albumId) {
        try {
            const data = await fetchJSON(`/api/v1/album/${encodeURIComponent(String(albumId || '').trim())}`);
            const songs = Array.isArray(data && data.songs) ? data.songs : [];
            const tracks = songs
                .map(song => {
                    const id = String(song && song.id ? song.id : '').trim();
                    const durationMs = Number(song && (song.dt || song.duration || 0));
                    if (!/^\d+$/.test(id) || !Number.isFinite(durationMs) || durationMs <= 0) {
                        return null;
                    }
                    return { id, durationMs: Math.floor(durationMs) };
                })
                .filter(Boolean);
            if (tracks.length === 0) return [];
            const playable = await fetchPlayableSongIds(tracks.map(track => track.id));
            return tracks.filter(track => playable.has(track.id));
        } catch (e) {
            return [];
        }
    }

    async function fetchAlbumSongIds(albumId) {
        const tracks = await fetchAlbumTracks(albumId);
        return tracks.map(track => track.id);
    }

    function extractSongId(value) {
        const text = String(value || '');
        const match = text.match(/(?:song\?id=|\/song\?id=|id=)(\d+)/);
        return match ? match[1] : '';
    }

    function getAlbumSongIds() {
        const ids = new Set();
        try {
            const frame = document.getElementById('g_iframe');
            if (!frame || !frame.contentDocument) return [];
            const doc = frame.contentDocument;
            const selectors = [
                '.m-table a[href*="song?id="]',
                '.n-songtb a[href*="song?id="]',
                'a[href*="song?id="]',
                '[data-res-id][data-res-type="18"]'
            ];
            selectors.forEach(selector => {
                doc.querySelectorAll(selector).forEach(el => {
                    const fromHref = extractSongId(el.getAttribute('href'));
                    const fromData = /^\d+$/.test(String(el.getAttribute('data-res-id') || ''))
                        ? String(el.getAttribute('data-res-id'))
                        : '';
                    const songId = fromHref || fromData;
                    if (songId) ids.add(songId);
                });
            });
        } catch (e) {}
        return Array.from(ids);
    }

    async function resolveAlbumSongId(albumId) {
        const apiSongIds = await fetchAlbumSongIds(albumId);
        if (apiSongIds.length > 0) {
            return apiSongIds[Math.floor(Math.random() * apiSongIds.length)];
        }

        window.location.hash = `#/album?id=${albumId}`;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const songIds = getAlbumSongIds();
            if (songIds.length > 0) {
                const playable = Array.from(await fetchPlayableSongIds(songIds));
                if (playable.length > 0) return playable[Math.floor(Math.random() * playable.length)];
            }
            await wait(500);
        }
        return '';
    }

    async function resolveMusicMeta(musicId, musicType) {
        if (musicType === 'song') {
            const durationMs = await fetchSongDuration(musicId);
            return durationMs > 0 ? { durationMs } : null;
        }

        const tracks = await fetchAlbumTracks(musicId);
        return tracks.length > 0 ? { tracks } : null;
    }

    function parseMusicIds(text) {
        const result = [];
        String(text || '').split('\n').forEach(function (line) {
            const trimmed = line.trim();
            if (!trimmed) return;
            let type = 'song';
            let id = trimmed;
            if (trimmed.includes(':')) {
                const parts = trimmed.split(':');
                type = parts[0].trim();
                id = parts[1].trim();
            }
            if (!/^\d+$/.test(id)) return;
            if (type !== 'song' && type !== 'album') return;
            result.push({ type: type, id: id });
        });
        return result;
    }

    async function resolveMusics(musicIds) {
        const result = [];
        for (const m of musicIds) {
            if (m.type === 'song') {
                const durationMs = await fetchSongDuration(m.id);
                if (durationMs > 0) {
                    result.push({ musicId: `song:${m.id}`, musicMeta: { durationMs: durationMs } });
                } else {
                    // 单曲解析失败，尝试作为专辑
                    const tracks = await fetchAlbumTracks(m.id);
                    tracks.forEach(function (t) {
                        result.push({ musicId: `song:${t.id}`, musicMeta: { durationMs: t.durationMs } });
                    });
                }
            } else if (m.type === 'album') {
                const tracks = await fetchAlbumTracks(m.id);
                tracks.forEach(function (t) {
                    result.push({ musicId: `song:${t.id}`, musicMeta: { durationMs: t.durationMs } });
                });
            }
        }
        return result;
    }

    function initUI() {
        const token = GM_getValue(TOKEN_KEY, '');
        const params = new URLSearchParams(window.location.search);
        const hasPendingAuthRedirect = params.has('music_helper_ticket') || params.has('music_helper_error');
        const savedMusicList = GM_getValue('myMusicList', '');
        const savedPreference = GM_getValue('myPreference', 'random');
        const autoStart = GM_getValue('autoStart', '0');
        const riskAccepted = GM_getValue(RISK_ACCEPTED_KEY, '') === '1';
        const container = document.createElement('div');
        container.id = 'music-helper-container';
        container.innerHTML = `
            <div id="helper-toggle-btn">🎵</div>
            <div id="music-helper-panel">
                <div id="helper-header">
                    <span>🎵 互助面板 (${CURRENT_VERSION})</span>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <a id="header-update-link" style="display:none; font-size:10px; color:#d33; cursor:pointer;">更新脚本</a>
                        <a id="portal-link" href="${getPortalUrl()}" style="font-size:10px; color:#1890ff; text-decoration:underline;">个人中心</a>
                        <a id="logout-link" style="font-size:10px; color:#999; display:${token ? 'block' : 'none'}">退出</a>
                        <span id="min-btn" style="cursor:pointer; color:#999;">—</span>
                    </div>
                </div>
                <div id="helper-body">
                    <div id="risk-notice" style="${riskAccepted ? 'display:none' : 'display:block'}; white-space:pre-line; font-size:11px; margin-bottom:8px; padding:8px; border-radius:4px; background:#fff7e6; border:1px solid #ffd591; color:#874d00; line-height:1.5;"></div>
                    <button id="risk-accept-btn" style="${riskAccepted ? 'display:none' : 'display:block'}; width:100%; margin-bottom:8px; background:#176b5b; color:#fff; padding:8px; border:none; border-radius:6px; cursor:pointer;">我已阅读并确认</button>
                    <div id="login-status" style="font-size:12px; margin-bottom:8px; color:#666;">${token ? '检测登录中...' : '未登录'}</div>
                    <div id="auth-section" style="${token || !riskAccepted ? 'display:none' : 'display:block'}">
                        <button id="login-linuxdo" style="background:#000; color:#fff; width:100%; padding:8px; border:none; border-radius:6px; cursor:pointer;">登录 Linux.do</button>
                        <button id="update-script-btn" style="display:none; margin-top:8px; background:#d33; color:#fff; width:100%; padding:8px; border:none; border-radius:6px; cursor:pointer;">更新脚本</button>
                    </div>
                    <div id="helper-form" style="${token && riskAccepted ? 'display:block' : 'display:none'}">
                        <div style="margin-bottom:8px;">
                            <div style="font-size:11px; color:#999; margin-bottom:4px;">音乐 ID（每行一个，如 song:123 或 album:456，也可直接填数字；留空=只帮别人不加入被助队列）</div>
                            <textarea id="my-music-list" rows="3" style="width:100%; padding:4px; border:1px solid #ccc; border-radius:6px; box-sizing:border-box; font-size:12px;">${savedMusicList}</textarea>
                        </div>
                        <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
                            <select id="my-preference" style="flex:1; padding:4px; border:1px solid #ccc; border-radius:6px; background:#f9f9f9; font-size:12px;">
                                <option value="random" ${savedPreference === 'random' ? 'selected' : ''}>随机</option>
                                <option value="short" ${savedPreference === 'short' ? 'selected' : ''}>短歌优先</option>
                                <option value="long" ${savedPreference === 'long' ? 'selected' : ''}>长歌优先</option>
                            </select>
                            <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:#666; white-space:nowrap;">
                                <input type="checkbox" id="auto-start" ${autoStart === '1' ? 'checked' : ''}> 自动开启
                            </label>
                        </div>
                        <button id="toggle-helper" style="width:100%; padding:8px; background:#d33; color:#fff; border:none; border-radius:6px; cursor:pointer;">开启互助</button>
                    </div>
                    <div id="helper-info" style="display:none; white-space:pre-line; font-size:11px; margin-top:8px; padding:8px; border-radius:4px; background:#f7f8fa; border:1px solid #d9dce1; color:#4a5568; line-height:1.5;">就绪...</div>
                    <button id="manual-btn" style="display:none; width:100%; margin-top:8px; background:#d33; color:#fff; border:none; padding:8px; border-radius:6px; cursor:pointer; animation: blink 1s infinite;">点我激活播放</button>
                </div>
            </div>
        `;
        document.body.appendChild(container);
        GM_addStyle(`
            #music-helper-container { --brand:#d33; --ok:#14804a; --bad:#d93025; --warn:#9a6700; --panel:#fff; --line:#dfe5ee; position: fixed; top: 100px; right: 20px; z-index: 1000000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; user-select: none; }
            #music-helper-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); width: 220px; }
            #helper-header { background: #f5f5f5; padding: 10px; display: flex; justify-content: space-between; align-items: center; border-radius: 8px 8px 0 0; cursor: move; }
            #helper-body { padding: 12px; }
            #helper-toggle-btn { width: 44px; height: 44px; background: var(--brand); color: #fff; border-radius: 50%; display: none; align-items: center; justify-content: center; cursor: move; font-size: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
            @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.4} }
        `);

        const drag = (el, h) => {
            let p1=0,p2=0,p3=0,p4=0;
            h.onmousedown = (e) => {
                isDragging=false; e.preventDefault(); p3=e.clientX; p4=e.clientY;
                document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};
                document.onmousemove=(e)=>{isDragging=true; p1=p3-e.clientX; p2=p4-e.clientY; p3=e.clientX; p4=e.clientY;
                el.style.top=(el.offsetTop-p2)+"px"; el.style.right=(window.innerWidth-(el.offsetLeft+el.offsetWidth)+p1)+"px"; el.style.left="auto";};
            };
        };
        drag(container, document.getElementById('helper-header'));
        drag(container, document.getElementById('helper-toggle-btn'));

        const riskNotice = document.getElementById('risk-notice');
        if (riskNotice) riskNotice.innerText = RISK_NOTICE_TEXT;
        document.getElementById('risk-accept-btn').onclick = () => {
            GM_setValue(RISK_ACCEPTED_KEY, '1');
            document.getElementById('risk-notice').style.display = 'none';
            document.getElementById('risk-accept-btn').style.display = 'none';
            document.getElementById('auth-section').style.display = token ? 'none' : 'block';
            document.getElementById('helper-form').style.display = token ? 'block' : 'none';
        };
        document.getElementById('login-linuxdo').onclick = async () => {
            if (GM_getValue(RISK_ACCEPTED_KEY, '') !== '1') return;
            GM_setValue(ERROR_KEY, '');
            if(!authConfig) await fetchConfig();
            if(authConfig && authConfig.loginUrl) window.location.href = authConfig.loginUrl;
        };
        document.getElementById('update-script-btn').onclick = () => { window.location.href = getUpdateUrl(); };
        document.getElementById('header-update-link').onclick = () => { window.location.href = getUpdateUrl(); };
        document.getElementById('logout-link').onclick = async () => {
            await requestAPI('POST', '/auth/logout');
            releaseTabLock();
            clearStoredToken('');
            location.reload();
        };
        document.getElementById('toggle-helper').onclick = toggleHelper;
        document.getElementById('manual-btn').onclick = () => { triggerIframePlay(); document.getElementById('manual-btn').style.display='none'; };
        document.getElementById('min-btn').onclick = () => { document.getElementById('music-helper-panel').style.display='none'; document.getElementById('helper-toggle-btn').style.display='flex'; };
        document.getElementById('helper-toggle-btn').onclick = () => { if(!isDragging){ document.getElementById('music-helper-panel').style.display='block'; document.getElementById('helper-toggle-btn').style.display='none'; } };

        fetchConfig();
        if (token && ensureSingleTabLock()) refreshMe();
        const lastError = GM_getValue(ERROR_KEY, '');
        if (lastError && !hasPendingAuthRedirect) {
            if (isServicePauseError(lastError)) {
                handleServicePaused();
            } else if (lastError === 'tab_conflict') {
                handleTabConflict();
            } else {
                handleAccessError(lastError);
            }
        }
        if (autoStart === '1' && token && riskAccepted) {
            setTimeout(() => {
                if (!isHelperRunning && !upgradeRequired) {
                    autoStartTriggered = true;
                    startHelper(parseMusicIds(savedMusicList), savedPreference).catch(() => {});
                }
            }, 3000);
        }
    }

    async function fetchConfig() {
        return new Promise(r => GM_xmlhttpRequest({
            method:'GET',
            url:`${API_BASE}/auth-config`,
            headers:{'X-Music-Helper-Version': CURRENT_VERSION},
            onload:res=>{
                const d = safeJSON(res.responseText);
                renderAnnouncement(d && d.announcement);
                if(d && d.latestVersion && compareVersions(d.latestVersion, CURRENT_VERSION) > 0) {
                    const up = document.createElement('div');
                    up.innerHTML = `<div style="background:#fffbe6; border:1px solid #ffe58f; padding:8px; border-radius:4px; margin-bottom:8px; font-size:11px; color:#856404;">发现新版本 v${d.latestVersion}</div>`;
                    document.getElementById('helper-body').prepend(up);
                    showUpdateButton(`更新到 v${d.latestVersion}`);
                }
                authConfig = d;
                const portalLink = document.getElementById('portal-link');
                if (portalLink) portalLink.href = getPortalUrl();
                if (d && d.minSupportedVersion && compareVersions(CURRENT_VERSION, d.minSupportedVersion) < 0) {
                    showUpgradeRequired(d.minSupportedVersion, d.latestVersion);
                }
                r(d);
            },
            onerror:()=>r(null),
            ontimeout:()=>r(null)
        }));
    }

    function renderAnnouncement(message) {
        const body = document.getElementById('helper-body');
        if (!body) return;
        const existing = document.getElementById('helper-announcement');
        const text = String(message || '').trim();
        if (!text) {
            if (existing) existing.remove();
            return;
        }
        const box = existing || document.createElement('div');
        box.id = 'helper-announcement';
        box.style.cssText = 'white-space:pre-line;background:#fff7e6;border:1px solid #ffd591;padding:8px;border-radius:4px;margin-bottom:8px;font-size:11px;color:#874d00;line-height:1.5;';
        box.innerText = text;
        if (!existing) body.prepend(box);
    }

    function clearStoredToken(errorCode = '') {
        releaseTabLock();
        GM_setValue(TOKEN_KEY, '');
        GM_setValue(LEGACY_TOKEN_KEY, '');
        GM_setValue(ACCESS_EXPIRES_AT_KEY, '');
        GM_setValue(REFRESH_EXPIRES_AT_KEY, '');
        GM_setValue(ERROR_KEY, errorCode || '');
    }

    function storeSessionToken(payload) {
        if (!payload || !payload.token) return false;
        GM_setValue(TOKEN_KEY, payload.token);
        GM_setValue(LEGACY_TOKEN_KEY, '');
        GM_setValue(ACCESS_EXPIRES_AT_KEY, String(payload.access_expires_at || ''));
        GM_setValue(REFRESH_EXPIRES_AT_KEY, String(payload.refresh_expires_at || ''));
        GM_setValue(ERROR_KEY, '');
        startTabLockHeartbeat();
        return true;
    }

    function parseStoredTime(key) {
        const raw = String(GM_getValue(key, '') || '').trim();
        if (!raw) return 0;
        const unixMs = Date.parse(raw);
        return Number.isFinite(unixMs) ? unixMs : 0;
    }

    function tokenNeedsRefresh(force = false) {
        const token = GM_getValue(TOKEN_KEY, '');
        if (!token) return false;
        if (force) return true;
        const now = Date.now();
        const expiresAt = parseStoredTime(ACCESS_EXPIRES_AT_KEY);
        return expiresAt > 0 && now >= expiresAt - TOKEN_REFRESH_SKEW_MS;
    }

    async function requestAPI(method, path, body = null, token = GM_getValue(TOKEN_KEY, '')) {
        return new Promise(r => GM_xmlhttpRequest({
            method, url:`${API_BASE}${path}`, headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','X-Music-Helper-Version': CURRENT_VERSION},
            data: body?JSON.stringify(body):null,
            timeout: 15000,
            onload: res => r({ status: res.status, payload: safeJSON(res.responseText) }),
            onerror:()=>r({ status: 0, payload: null }),
            ontimeout:()=>r({ status: 0, payload: null })
        }));
    }

    async function refreshAccessToken(force = false) {
        const token = GM_getValue(TOKEN_KEY, '');
        if (!token) return false;
        const refreshExpiresAt = parseStoredTime(REFRESH_EXPIRES_AT_KEY);
        if (refreshExpiresAt > 0 && Date.now() >= refreshExpiresAt - TOKEN_REFRESH_SKEW_MS) {
            clearStoredToken('invalid_or_expired_token');
            location.reload();
            return false;
        }
        if (!force && !tokenNeedsRefresh()) return true;
        if (refreshPromise) return refreshPromise;

        refreshPromise = (async () => {
            const result = await requestAPI('POST', '/auth/refresh', { token }, '');
            if (result.status === 200 && result.payload && result.payload.token) {
                storeSessionToken(result.payload);
                return true;
            }
            if (result.status === 503 && result.payload && isServicePauseError(result.payload.error)) {
                handleServicePaused(result.payload);
                return false;
            }
            if (result.status === 403) {
                handleAccessError(
                    result.payload && result.payload.error ? result.payload.error : 'forbidden',
                    result.payload && result.payload.message ? result.payload.message : '',
                );
                return false;
            }
            clearStoredToken(result.payload && result.payload.error ? result.payload.error : 'invalid_or_expired_token');
            location.reload();
            return false;
        })();

        try {
            return await refreshPromise;
        } finally {
            refreshPromise = null;
        }
    }

    async function ensureFreshToken() {
        if (!ensureSingleTabLock()) return false;
        if (!tokenNeedsRefresh()) return true;
        return refreshAccessToken(true);
    }

    async function callAPI(method, path, body = null, allowRefreshRetry = true) {
        if (!await ensureFreshToken()) return null;
        const token = GM_getValue(TOKEN_KEY, '');
        const result = await requestAPI(method, path, body, token);
        const payload = result.payload;
        if(result.status===401){
            if (allowRefreshRetry && token && payload && payload.error === 'token_expired') {
                const refreshed = await refreshAccessToken(true);
                if (refreshed) {
                    return callAPI(method, path, body, false);
                }
                return null;
            }
            clearStoredToken(payload && payload.error ? payload.error : 'invalid_or_expired_token');
            location.reload();
            return null;
        }
        if(result.status===403){
            if (payload && payload.error === 'client_upgrade_required') {
                showUpgradeRequired(payload.minSupportedVersion, payload.latestVersion);
                return payload;
            }
            handleAccessError(
                payload && payload.error ? payload.error : 'forbidden',
                payload && payload.message ? payload.message : '',
            );
            return payload;
        }
        if (result.status === 503 && payload && isServicePauseError(payload.error)) {
            handleServicePaused(payload);
            return payload;
        }
        if (result.status === 0) {
            return null;
        }
        if (payload && payload.stats) updateActivityStats(payload.stats);
        GM_setValue(ERROR_KEY, '');
        return payload;
    }

    async function claimTicket(ticket) {
        return new Promise(r => GM_xmlhttpRequest({
            method:'POST',
            url:`${API_BASE}/auth/claim`,
            headers:{'Content-Type':'application/json','X-Music-Helper-Version': CURRENT_VERSION},
            data: JSON.stringify({ ticket }),
            onload: res => {
                const d = safeJSON(res.responseText);
                if (res.status === 403 && d && d.error === 'client_upgrade_required') {
                    showUpgradeRequired(d.minSupportedVersion, d.latestVersion);
                    r({ ok: false, status: res.status, payload: d });
                    return;
                }
                if (res.status === 200 && storeSessionToken(d)) {
                    r({ ok: true, status: res.status, payload: d });
                } else {
                    r({ ok: false, status: res.status, payload: d });
                }
            },
            onerror:()=>r({ ok: false, status: 0, payload: null }),
            ontimeout:()=>r({ ok: false, status: 0, payload: null })
        }));
    }

    async function refreshMe() {
        const d = await callAPI('GET', '/me');
        if (d && d.user) {
            document.getElementById('login-status').innerText = `已登录: ${d.user.displayName}`;
            updateParticipantInfo(d.participant);
            const listEl = document.getElementById('my-music-list');
            // 优先从云端歌曲草稿同步（门户保存的原始 ID）
            const songsRes = await callAPI('GET', '/songs');
            if (songsRes && songsRes.status === 'pending') {
                // 修改待审核：不应用，保留旧歌曲
                const infoEl = document.getElementById('helper-info');
                if (infoEl && !isHelperRunning) {
                    infoEl.style.display = 'block';
                    infoEl.innerText = '歌曲修改待管理员审核，通过后生效。';
                    setHelperInfoStyle('warn');
                }
            } else if (songsRes && songsRes.songs != null && String(songsRes.songs).trim()) {
                if (listEl) {
                    listEl.value = String(songsRes.songs);
                    GM_setValue('myMusicList', String(songsRes.songs));
                }
            } else if (listEl && Array.isArray(d.musics) && d.musics.length > 0 && !(GM_getValue('myMusicList', '') || '').trim()) {
                const lines = d.musics.map(function (m) { return m.musicId || ''; }).filter(Boolean);
                if (lines.length > 0) {
                    listEl.value = lines.join('\n');
                    GM_setValue('myMusicList', listEl.value);
                }
            }
        }
    }

    function updateParticipantInfo(participant) {
        if (!participant) return;
        const infoEl = document.getElementById('helper-info');
        const credits = Number(participant.credits || 0);
        currentParticipantCredits = credits;
        currentEarnedHelpStats = normalizeEarnedHelpStats(participant.earned_help_stats);
        const monthlyReceived = Number(participant.monthly_received_help_count || 0);
        const monthlyLimit = Number(participant.monthly_received_limit || 0);
        const monthlyLine = monthlyLimit > 0
            ? `本月被助: ${monthlyReceived} / ${monthlyLimit}${participant.monthly_cap_reached ? '（已封顶）' : ''}`
            : '';
        const todayHelped = Number(participant.today_helped_count || 0);
        const todayReceived = Number(participant.today_received_help_count || 0);
        const todayLimit = Number(participant.today_received_limit || 0);
        const todayHelpedLine = `今日帮了: ${todayHelped} 次`;
        const todayReceivedLine = todayLimit > 0
            ? `今日被助: ${todayReceived} / ${todayLimit}`
            : '';
        const earnedLine = earnedHelpStatsLine();
        if (infoEl && earnedLine) infoEl.title = earnedHelpStatsTooltip();
        if (!isHelperRunning) {
            infoEl.style.display = 'block';
            const statsLine = activityStatsLine();
            infoEl.innerText = `剩余可被互助额度: ${credits}${monthlyLine ? `\n${monthlyLine}` : ''}${todayHelpedLine ? `\n${todayHelpedLine}` : ''}${todayReceivedLine ? `\n${todayReceivedLine}` : ''}${earnedLine ? `\n${earnedLine}` : ''}${statsLine ? `\n${statsLine}` : ''}`;
        }
    }

    // helper-info 状态色分层：空闲/正常=中性，运行中=绿色，错误/待审核=黄色。只改颜色不改文字。
    function setHelperInfoStyle(kind) {
        const infoEl = document.getElementById('helper-info');
        if (!infoEl) return;
        if (kind === 'running') {
            infoEl.style.background = '#e8f5ee';
            infoEl.style.borderColor = '#bfe5cf';
            infoEl.style.color = '#14804a';
        } else if (kind === 'warn') {
            infoEl.style.background = '#fff7e6';
            infoEl.style.borderColor = '#ffd591';
            infoEl.style.color = '#874d00';
        } else {
            infoEl.style.background = '#f7f8fa';
            infoEl.style.borderColor = '#d9dce1';
            infoEl.style.color = '#4a5568';
        }
    }

    function normalizeEarnedHelpStats(stats) {
        if (!stats || typeof stats !== 'object') return null;
        return {
            today: Number(stats.today || 0),
            month: Number(stats.month || 0),
        };
    }

    function earnedHelpStatsLine() {
        if (!currentEarnedHelpStats) return '';
        return `获得互助(?)：今日 ${currentEarnedHelpStats.today}，本月 ${currentEarnedHelpStats.month}`;
    }

    function earnedHelpStatsTooltip() {
        return '统计不一定 100% 准确，仅供参考。按服务端额度流水中的成功互助记录估算。';
    }

    function updateActivityStats(stats) {
        if (!stats || typeof stats !== 'object') return;
        activityStats = {
            currentActiveUsers: Number(stats.currentActiveUsers || 0),
            currentActiveWindowMin: Number(stats.currentActiveWindowMin || 0),
            recentActiveUsers: Number(stats.recentActiveUsers || 0),
            recentActiveWindowMin: Number(stats.recentActiveWindowMin || 0),
            dailyActiveUsers: Number(stats.dailyActiveUsers || 0),
        };
    }

    function activityStatsLine() {
        if (!activityStats) return '';
        const recentWindow = activityStats.recentActiveWindowMin || 30;
        return `近${recentWindow}分钟活跃: ${activityStats.recentActiveUsers}\n今日活跃: ${activityStats.dailyActiveUsers}`;
    }

    function noTargetReasonText(summary) {
        if (!summary || typeof summary !== 'object') return '暂无可互助目标，30s 后重试';
        const reason = String(summary.reason || '');
        if (reason === 'resting') return '已连续播放较久，正在随机休息，稍后自动恢复...';
        if (reason === 'daily_limit') return '今日帮助次数已达上限，明天再来吧。';
        const participants = Number(summary.participants || 0);
        const notSelf = Number(summary.notSelf || 0);
        const active = Number(summary.active || 0);
        const withCredit = Number(summary.withAvailableCredit || 0);
        const underMonthly = Number(summary.underMonthlyLimit || 0);
        const underActiveJobs = Number(summary.underActiveJobLimit || 0);
        const notInCooldown = Number(summary.notInCooldown || 0);
        const detail = `入队用户: ${participants}，非本人: ${notSelf}，正常: ${active}，有可用额度: ${withCredit}，未到月上限: ${underMonthly}，未超并发: ${underActiveJobs}，非冷却: ${notInCooldown}`;
        const reasonMap = {
            no_participants: '当前没人加入互助队列',
            only_self: '当前队列里只有你自己，不能给自己互助',
            no_active_participants: '队列里没有正常状态的其他用户',
            no_participant_with_credit: '其他入队用户都没有可用额度',
            all_monthly_limit_reached: '其他入队用户都已达到本月被互助上限',
            all_active_job_limited: '其他入队用户当前派发任务数已满',
            all_in_cooldown: '其他候选都处于同账号冷却期',
            no_eligible_participant: '当前没有满足条件的互助目标',
        };
        return `${reasonMap[reason] || '暂无可互助目标'}，30s 后重试\n${detail}`;
    }

    async function toggleHelper() {
        if (GM_getValue(RISK_ACCEPTED_KEY, '') !== '1') return;
        if (upgradeRequired) return;
        const listText = document.getElementById('my-music-list').value.trim();
        const preference = document.getElementById('my-preference').value;
        const musicIds = parseMusicIds(listText);
        GM_setValue('myMusicList', listText);
        GM_setValue('myPreference', preference);
        GM_setValue('autoStart', document.getElementById('auto-start').checked ? '1' : '0');
        if (isHelperRunning) stopHelper(); else await startHelper(musicIds, preference);
    }

    function stopHelper() {
        isHelperRunning = false;
        activeJoinState = null;
        clearInterval(monitorTimer);
        clearInterval(joinTimer);
        idleCleanupPlaybackBestEffort().catch(() => {});
        const toggleButton = document.getElementById('toggle-helper');
        const helperInfo = document.getElementById('helper-info');
        if (toggleButton) {
            toggleButton.innerText = '开启互助';
            toggleButton.style.background = '#d33';
        }
        if (helperInfo) {
            helperInfo.innerText = '已停止本机互助播放；已保存的歌曲仍会按剩余额度被其他人互助。';
        }
        setHelperInfoStyle('neutral');
    }

    async function startHelper(musicIds, preference) {
        isHelperRunning = true;
        activeJoinState = { musicIds: musicIds, musics: null, preference: preference };
        document.getElementById('toggle-helper').innerText = '停止互助';
        document.getElementById('toggle-helper').style.background = '#666';
        document.getElementById('helper-info').style.display = 'block';
        setHelperInfoStyle('running');
        const startHint = autoStartTriggered ? '已自动开启互助\n' : '';
        autoStartTriggered = false;
        document.getElementById('helper-info').innerText = startHint + '正在加入互助队列...';

        const joined = await joinSelf(activeJoinState);
        if (!joined) {
            stopHelper();
            document.getElementById('helper-info').innerText = '服务器连接失败，未能加入互助队列';
            setHelperInfoStyle('warn');
            return;
        }
        if (!joined.ok) {
            stopHelper();
            if (isApiErrorPayload(joined)) {
                if (!isServicePauseError(joined.error)) {
                    document.getElementById('helper-info').innerText = getPayloadErrorText(joined, 'join_failed');
                }
            } else {
                document.getElementById('helper-info').innerText = '服务器连接失败，未能加入互助队列';
            }
            setHelperInfoStyle('warn');
            return;
        }

        joinTimer = setInterval(() => {
            if (activeJoinState) joinSelf(activeJoinState);
        }, JOIN_REFRESH_INTERVAL_MS);
        playNext();
    }

    async function joinSelf(state) {
        if (!state) return false;
        if (!state.musics) {
            state.musics = await resolveMusics(state.musicIds);
        }
        const payload = { musics: state.musics || [] };
        const d = await callAPI('POST', '/join', payload);
        if (d && d.loginUser) document.getElementById('login-status').innerText = `已登录: ${d.loginUser}`;
        if (d && d.participant) updateParticipantInfo(d.participant);
        return d;
    }

    async function finishCurrentJob(jobId, playedMs, positionMs, durationMs) {
        if (!jobId) return null;
        return callAPI('POST', '/play/finish', { jobId, playedMs, positionMs, durationMs });
    }

    async function playNext() {
        if (!isHelperRunning) return;
        clearInterval(monitorTimer);
        const infoEl = document.getElementById('helper-info');
        const preference = (activeJoinState && activeJoinState.preference) || 'random';
        const data = await callAPI('GET', '/next?preference=' + encodeURIComponent(preference));
        if (!isHelperRunning) {
            await idleCleanupPlaybackBestEffort();
            return;
        }
        if(!data) {
            await idleCleanupPlaybackBestEffort();
            infoEl.innerText = '服务器连接失败';
            return;
        }
        if (isApiErrorPayload(data)) {
            await idleCleanupPlaybackBestEffort();
            if (!isServicePauseError(data.error)) {
                infoEl.innerText = getPayloadErrorText(data, 'next_failed');
            }
            return;
        }
        if (data.participant) updateParticipantInfo(data.participant);

        if (data.musicId) {
            const sourceMusicId = data.sourceMusicId || data.musicId;
            let [type, id] = data.musicId.includes(':') ? data.musicId.split(':') : ['song', data.musicId];
            const jobId = data.jobId;
            const creditCost = Number(data.creditCost || 1);
            const expectedDurationMs = Number(data.targetDurationMs || 0);
            try { const p = getSafePlayer(); if(p && p.stop) p.stop(); } catch(e) {}
            if (type === 'album') {
                infoEl.innerText = `正在从专辑随机选歌...\n目标: ${data.owner && data.owner.displayName ? data.owner.displayName : '互助用户'}`;
                const randomSongId = await resolveAlbumSongId(id);
                if (!isHelperRunning) {
                    await idleCleanupPlaybackBestEffort();
                    return;
                }
                if (!randomSongId) {
                    infoEl.innerText = '专辑歌曲读取失败，稍后重试';
                    setTimeout(playNext, 5000);
                    return;
                }
                type = 'song';
                id = randomSongId;
                infoEl.innerText = `已从专辑中随机选中一首歌\n正在跳转...`;
            } else {
                infoEl.innerText = `正在跳转...\n目标: ${data.owner && data.owner.displayName ? data.owner.displayName : '互助用户'}`;
            }

            const expectedSongId = String(id);
            const forcePlayed = await prepareTargetPlayback(expectedSongId);
            if (!isHelperRunning) {
                await idleCleanupPlaybackBestEffort();
                return;
            }
            if (!forcePlayed) {
                infoEl.innerText = `目标歌曲加载失败，准备重试...\n目标歌曲: ${expectedSongId}`;
                setTimeout(playNext, 3000);
                return;
            }
            let startTime = Date.now(), hasTriggered = false, finished = false;
            let prevCur = 0, prevDur = 0, prevTickAt = 0, localListenedMs = 0, suspiciousJumps = 0, cleanTicks = 0;
            let mismatchTicks = 0, lastRetargetAt = 0, retargeting = false, recoveryAttempts = 0;
            let lastHeartbeatAt = 0;
            const resetPlaybackAccounting = () => {
                startTime = Date.now();
                hasTriggered = false;
                prevCur = 0;
                prevDur = 0;
                prevTickAt = 0;
                localListenedMs = 0;
                suspiciousJumps = 0;
                cleanTicks = 0;
                mismatchTicks = 0;
            };
            const recoverTargetPlayback = async (reason) => {
                if (retargeting || recoveryAttempts >= 3) return false;
                recoveryAttempts += 1;
                retargeting = true;
                clearInterval(monitorTimer);
                infoEl.innerText = `播放状态异常，正在重新初始化...\n原因: ${reason}\n目标歌曲: ${expectedSongId}`;
                const ok = await prepareTargetPlayback(expectedSongId);
                resetPlaybackAccounting();
                retargeting = false;
                if (!ok) {
                    finished = true;
                    setTimeout(playNext, 3000);
                    return false;
                }
                monitorTimer = setInterval(monitorTick, 1000);
                return true;
            };
            const completeCurrentJob = async (playedMs, positionMs, durationMs, requiredListenMs) => {
                finished = true;
                clearInterval(monitorTimer);
                try { const p = getSafePlayer(); if(p && p.stop) p.stop(); } catch(e) {}
                infoEl.innerText = `正在提交助力结果...\n有效播放: ${formatTime(playedMs)} / ${formatTime(requiredListenMs)}`;
                // 对同一个 jobId 的 /play/finish 做有限次重试（初始 1 次 + 最多 2 次重试），
                // 网络/服务端失败时不作废本次有效播放。finished=true 已在首个 await 前同步置位，
                // 重试期间 monitorTick 不会重复触发完成。
                let result = null;
                for (let attempt = 0; attempt <= 2; attempt += 1) {
                    result = await finishCurrentJob(jobId, playedMs, positionMs, durationMs);
                    if (result && result.ok) break;
                    if (attempt < 2) {
                        infoEl.innerText = `助力提交失败，正在重试 (${attempt + 1}/2)...\n有效播放: ${formatTime(playedMs)} / ${formatTime(requiredListenMs)}`;
                        await wait(1500);
                    }
                }
                if (result && result.ok) {
                    const credits = result.participant ? Number(result.participant.credits || 0) : null;
                    const credited = result.credited !== false;
                    const earnedCredits = Number(result.creditCost || creditCost || 0);
                    if (result.participant) updateParticipantInfo(result.participant);
                    infoEl.style.display = 'block';
                    const earnedLine = earnedHelpStatsLine();
                    if (earnedLine) infoEl.title = earnedHelpStatsTooltip();
                    infoEl.innerText = credited
                        ? `助力成功\n本次获得额度: ${earnedCredits}${credits === null ? '' : `\n当前剩余额度: ${credits}`}${earnedLine ? `\n${earnedLine}` : ''}`
                        : `任务已提交过\n本次未重复增加额度${credits === null ? '' : `\n当前剩余额度: ${credits}`}${earnedLine ? `\n${earnedLine}` : ''}`;
                    setTimeout(playNext, 2500);
                    return;
                }
                const errorText = getPayloadErrorText(result, 'finish_failed');
                infoEl.style.display = 'block';
                infoEl.innerText = `助力提交失败\n${errorText}`;
                setTimeout(playNext, 5000);
            };
            const monitorTick = async () => {
                if (!isHelperRunning || finished) return;
                const { cur, dur, state } = getProgress();
                const now = Date.now();
                const elapsed = now - startTime;
                // 任务超时保护：超过 15 分钟（与服务端 JobActiveSeconds 一致）仍未完成则放弃，避免无限上报心跳
                if (elapsed > 900000) {
                    finished = true;
                    clearInterval(monitorTimer);
                    try { const p = getSafePlayer(); if (p && p.stop) p.stop(); } catch (e) {}
                    infoEl.innerText = '任务超时未完成，已释放。';
                    setTimeout(playNext, 3000);
                    return;
                }
                // 每 10 秒上报一次进度（反作弊数据收集，纯记录不校验）
                if (now - lastHeartbeatAt >= 10000 && cur > 0) {
                    lastHeartbeatAt = now;
                    requestAPI('POST', '/play/heartbeat', { jobId: jobId, positionMs: Math.floor(cur) });
                }
                const playbackRate = getPlaybackRate();
                const playbackRateInvalid = state === 'play' && playbackRate > 1.05;
                const effectiveDur = dur > 0 ? dur : prevDur;
                const effectiveCur = cur > 0 ? cur : prevCur;
                const serverRequiredListenMs = Number(data.requiredListenMs || 0);
                const requiredListenRatio = Number(data.requiredListenRatio || 1.0);
                const earlyRequiredListenMs = effectiveDur > 0
                    ? (serverRequiredListenMs > 0 ? serverRequiredListenMs : Math.ceil(effectiveDur * requiredListenRatio))
                    : 0;
                const earlyDisplayListenedMs = effectiveDur > 0 ? Math.min(localListenedMs, effectiveDur) : localListenedMs;
                const earlyFinished = effectiveDur > 0
                    && earlyRequiredListenMs > 0
                    && (effectiveCur >= effectiveDur - 2000 || (state === 'stop' && effectiveCur > 0))
                    && earlyDisplayListenedMs + 5000 >= earlyRequiredListenMs
                    && suspiciousJumps <= 1
                    && !playbackRateInvalid;
                const currentHashSongId = extractSongId(window.location.hash);
                const currentPlayingSongId = getCurrentPlayingSongId();
                const durationMismatch = expectedDurationMs > 0
                    && dur > 0
                    && Math.abs(dur - expectedDurationMs) > Math.max(12000, expectedDurationMs * 0.12);
                const hashMismatch = currentHashSongId && currentHashSongId !== expectedSongId;
                const playingSongMismatch = currentPlayingSongId
                    && currentPlayingSongId !== expectedSongId
                    && (hashMismatch || durationMismatch);
                const progressListenDrift = effectiveCur > 0 ? effectiveCur - earlyDisplayListenedMs : 0;
                const queuePolluted = getQueueCount() > 1;
                const progressPolluted = state === 'play'
                    && effectiveCur > 30000
                    && progressListenDrift > 25000
                    && earlyDisplayListenedMs < effectiveCur * 0.65;

                if (playingSongMismatch || (elapsed > 8000 && durationMismatch)) {
                    if (earlyFinished) {
                        await completeCurrentJob(earlyDisplayListenedMs, effectiveCur, effectiveDur, earlyRequiredListenMs);
                        return;
                    }
                    mismatchTicks += 1;
                    infoEl.innerText = `当前加载歌曲与任务不一致，正在重新初始化...\n目标歌曲: ${expectedSongId}\n预期时长: ${expectedDurationMs > 0 ? formatTime(expectedDurationMs) : '未知'}`;
                    if (!retargeting && now - lastRetargetAt > 4000) {
                        lastRetargetAt = now;
                        await recoverTargetPlayback('任务歌曲不一致');
                        return;
                    }
                    if (mismatchTicks >= 12) {
                        finished = true;
                        clearInterval(monitorTimer);
                        setTimeout(playNext, 3000);
                    }
                    prevCur = 0;
                    prevDur = 0;
                    prevTickAt = 0;
                    localListenedMs = 0;
                    return;
                }

                if ((queuePolluted && progressPolluted) || (progressPolluted && elapsed < 90000)) {
                    await recoverTargetPlayback(queuePolluted ? '播放列表残留且进度异常' : '当前进度与有效播放差距异常');
                    return;
                }

                mismatchTicks = 0;

                const listenCeilingMs = Math.max(expectedDurationMs || 0, dur || 0);

                if (prevTickAt > 0) {
                    const wallDelta = Math.max(0, now - prevTickAt);
                    const allowedProgress = wallDelta * 1.5 + 3000;
                    let jumped = false;
                    if (cur >= prevCur) {
                        const progressDelta = cur - prevCur;
                        if (progressDelta > allowedProgress) {
                            suspiciousJumps += 1;
                            jumped = true;
                        } else if (state === 'play' && !playbackRateInvalid) {
                            const validListenDelta = Math.max(0, Math.min(wallDelta, progressDelta));
                            localListenedMs += validListenDelta;
                        }
                    } else if (prevCur - cur > 15000) {
                        suspiciousJumps += 1;
                        jumped = true;
                    }
                    // 正常连续播放（无跳变、进度推进、1x 速率）超过 10 个 tick 后衰减一次可疑跳变计数，
                    // 避免两次小抖动导致 suspiciousJumps 永久 >=2，从而锁死完成判定。
                    if (jumped) {
                        cleanTicks = 0;
                    } else if (state === 'play' && !playbackRateInvalid && cur > prevCur) {
                        cleanTicks += 1;
                        if (cleanTicks >= 10 && suspiciousJumps > 0) {
                            suspiciousJumps -= 1;
                            cleanTicks = 0;
                        }
                    }
                }

                if (listenCeilingMs > 0) {
                    localListenedMs = Math.min(localListenedMs, listenCeilingMs);
                }

                if (!hasTriggered && elapsed > 5000 && state !== 'play') hasTriggered = triggerIframePlay();
                if (dur > 0) {
                    document.getElementById('manual-btn').style.display = 'none';
                    const requiredListenMs = serverRequiredListenMs > 0 ? serverRequiredListenMs : Math.ceil(dur * requiredListenRatio);
                    const isAlbumSource = String(sourceMusicId).startsWith('album:');
                    const speedWarning = playbackRateInvalid ? '\n检测到倍速播放，请恢复 1x 后继续' : '';
                    const displayDurationMs = expectedDurationMs > 0 ? expectedDurationMs : dur;
                    const displayListenedMs = displayDurationMs > 0 ? Math.min(localListenedMs, displayDurationMs) : localListenedMs;
                    const currentCreditsLine = currentParticipantCredits === null ? '' : `\n当前剩余额度: ${currentParticipantCredits}`;
                    const earnedLine = earnedHelpStatsLine();
                    const statsLine = activityStatsLine();
                    if (earnedLine) infoEl.title = earnedHelpStatsTooltip();
                    infoEl.innerText = `正在互助 [${isAlbumSource ? '专辑随机单曲' : '单曲'}]\n歌曲时长: ${formatTime(displayDurationMs)}\n当前进度: ${formatTime(cur)}\n有效播放: ${formatTime(displayListenedMs)} / ${formatTime(requiredListenMs)}\n本次完成可得额度: ${creditCost}${currentCreditsLine}${earnedLine ? `\n${earnedLine}` : ''}${statsLine ? `\n${statsLine}` : ''}${speedWarning}`;

                    const listenFinishToleranceMs = 5000;
                    const enoughSongListen = displayListenedMs + listenFinishToleranceMs >= requiredListenMs;
                    const songFinished = (cur >= dur - 2000 || (state === 'stop' && cur > 0))
                        && enoughSongListen
                        && suspiciousJumps <= 1
                        && !playbackRateInvalid;
                    if (songFinished) {
                        await completeCurrentJob(displayListenedMs, cur, dur, requiredListenMs);
                    }
                } else {
                    infoEl.innerText = `正在努力加载...`;
                    if (elapsed > 20000) document.getElementById('manual-btn').style.display = 'block';
                }
                prevCur = cur;
                prevDur = dur;
                prevTickAt = now;
            };
            monitorTimer = setInterval(monitorTick, 1000);
        } else {
            await idleCleanupPlaybackBestEffort();
            infoEl.innerText = noTargetReasonText(data.noTargetReason);
            setTimeout(playNext, 30000);
        }
    }

    function cleanLoginParams() {
        const url = new URL(window.location.href);
        url.searchParams.delete('music_helper_ticket');
        url.searchParams.delete('music_helper_error');
        window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }

    setTimeout(async () => {
        initUI();
        window.addEventListener('storage', (event) => {
            if (event.key !== TAB_LOCK_KEY) return;
            const lock = readTabLock();
            if (lock && lock.id !== TAB_INSTANCE_ID && GM_getValue(TOKEN_KEY, '')) {
                releaseTabLock();
                handleTabConflict();
            }
        });
        window.addEventListener('beforeunload', () => releaseTabLock());
        const params = new URLSearchParams(window.location.search);
        const ticket = params.get('music_helper_ticket');
        const loginError = params.get('music_helper_error');
        if (ticket) {
            GM_setValue(ERROR_KEY, '');
            const claimResult = await claimTicket(ticket);
            cleanLoginParams();
            if (claimResult && claimResult.ok) {
                const authSection = document.getElementById('auth-section');
                const helperForm = document.getElementById('helper-form');
                const logoutLink = document.getElementById('logout-link');
                if (authSection) authSection.style.display = 'none';
                if (helperForm) helperForm.style.display = 'block';
                if (logoutLink) logoutLink.style.display = 'block';
                await refreshMe();
            } else {
                handleClaimFailure(claimResult);
            }
        } else if (loginError) {
            GM_setValue(ERROR_KEY, loginError);
            cleanLoginParams();
            handleAccessError(loginError);
        }
    }, 1500);
})();
