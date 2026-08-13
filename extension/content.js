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
    const CURRENT_VERSION = '4.0.13';
    const IS_EXTENSION = true;
    const EXTENSION_UPGRADE_PAGE_URL = 'https://163music.linyu.qzz.io/extension-upgrade.html';
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
    const SONG_META_CACHE_KEY = 'musicHelperSongMetaCache';
    const SONG_META_CACHE_TTL_MS = 60 * 60 * 1000; // 歌曲时长/可播状态解析结果缓存 1 小时
    const TOKEN_REFRESH_SKEW_MS = 5000;
    const TAB_LOCK_HEARTBEAT_MS = 5000;
    const TAB_LOCK_STALE_MS = 15000;
    const PLAYBACK_STALL_MS = 40000; // 播放中进度持续不动（VIP 试听卡死等）判定的阈值，40 秒
    let songSlotLimit = 3; // 当前用户可挂歌槽位数（动态，来自 /api/me 的 song_slot_limit，默认 3）
    let pendingSlotApplication = false; // 是否存在待审核的槽位申请

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
    let updateAvailable = false;
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
        if (!targetSongId) return 'load_failed';
        if (!await isPlayableSong(targetSongId)) return 'song_unplayable';
        try { const p = getSafePlayer(); if(p && p.stop) p.stop(); } catch(e) {}
        ensureTargetSong(targetSongId);
        await wait(600);
        await clearPlayQueueBestEffort();
        const forcePlayed = await forcePlayTargetSong(targetSongId);
        await wait(600);
        await clearPlayQueueBestEffort();
        // 返回空串表示播放准备成功；否则返回失败原因（song_unplayable / load_failed）
        return forcePlayed ? '' : 'load_failed';
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
        if (IS_EXTENSION) return EXTENSION_UPGRADE_PAGE_URL;
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

    function showUpdateButton(label = '更新扩展') {
        updateAvailable = true;
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
        updateMinButtonState();
    }
    function getErrorText(code) {
        if (code === 'banned') return '当前账号已被管理员封禁，互助与登录态已失效。';
        if (code === 'registration_required') return '当前账号尚未完成注册，请先完成开通流程。';
        if (code === 'invalid_or_expired_token') return '登录态已失效，请重新登录。';
        if (code === 'tab_conflict') return '当前账号已经在另一个标签页运行，本页已停止服务。';
        if (code === 'client_upgrade_required') return '当前脚本版本过旧，请先更新到最新版本后再继续使用。';
        if (code === 'service_paused') return '服务已暂停，请稍后再试。';
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
        const isBanned = code === 'banned';
        stopHelper();
        clearStoredToken(code || 'unknown');
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        const authSection = document.getElementById('auth-section');
        const helperForm = document.getElementById('helper-form');
        const logoutLink = document.getElementById('logout-link');
        const loginButton = document.getElementById('login-linuxdo');
        if (loginStatus) loginStatus.innerText = isBanned ? '账号已被封禁，如有疑问请联系管理员' : (text || '访问受限');
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = text || '访问受限';
            setHelperInfoStyle('warn');
        }
        if (authSection) authSection.style.display = 'block';
        // 封禁时隐藏「登录 Linux.do」按钮
        if (loginButton) loginButton.style.display = isBanned ? 'none' : 'block';
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
        const toggleButton = document.getElementById('toggle-helper');
        if (loginStatus) loginStatus.innerText = token ? `已登录，${text}` : text;
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = text;
            setHelperInfoStyle('warn');
        }
        if (authSection) authSection.style.display = token ? 'none' : 'block';
        if (helperForm) helperForm.style.display = token ? 'block' : 'none';
        if (logoutLink) logoutLink.style.display = token ? 'block' : 'none';
        // 标签页冲突态：禁用「开启互助」并改文案
        if (toggleButton) {
            toggleButton.innerText = '已在其他标签页运行';
            toggleButton.disabled = true;
            toggleButton.style.background = 'var(--disabled)';
        }
        updateMinButtonState();
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
        updateAvailable = true;
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
            helperInfo.innerText = `${title}${detail ? `\n${detail}` : ''}\n点击下方按钮查看更新方法。`;
            setHelperInfoStyle('warn');
        }
        if (authSection) authSection.style.display = 'block';
        if (helperForm) helperForm.style.display = 'none';
        if (loginButton) loginButton.style.display = 'none';
        if (updateButton) {
            updateButton.innerText = '立即更新扩展';
            updateButton.style.display = 'block';
        }
        updateMinButtonState();
    }

    async function fetchJSON(path) {
        try {
            const res = await fetch(path, { credentials: 'include' });
            return safeJSON(await res.text());
        } catch (e) {
            return null;
        }
    }

    // ---- 歌曲元数据缓存（localStorage，TTL 内避免重复请求网易云 song/detail、player/url）----
    function readSongMetaCache() {
        try {
            const raw = localStorage.getItem(SONG_META_CACHE_KEY);
            const data = safeJSON(raw);
            return data && typeof data === 'object' ? data : {};
        } catch (e) {
            return {};
        }
    }

    function writeSongMetaCache(data) {
        try {
            localStorage.setItem(SONG_META_CACHE_KEY, JSON.stringify(data));
        } catch (e) {}
    }

    function getCachedSongMeta(cacheKey) {
        const cache = readSongMetaCache();
        const entry = cache[cacheKey];
        if (!entry || typeof entry !== 'object') return null;
        if (!entry.updatedAt || Date.now() - entry.updatedAt > SONG_META_CACHE_TTL_MS) return null;
        return entry;
    }

    function setCachedSongMeta(cacheKey, meta) {
        const cache = readSongMetaCache();
        cache[cacheKey] = Object.assign({}, meta, { updatedAt: Date.now() });
        writeSongMetaCache(cache);
    }

    function invalidateSongMeta(cacheKey) {
        const cache = readSongMetaCache();
        if (cache[cacheKey]) {
            delete cache[cacheKey];
            writeSongMetaCache(cache);
        }
    }

    function invalidateSongMetaList(musicIds) {
        (musicIds || []).forEach(function (m) {
            if (!m || !m.id) return;
            const cacheKey = 'song:' + m.id;
            invalidateSongMeta(cacheKey);
        });
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
        // 优先复用已缓存的可播状态，未缓存/已过期的才去请求网易云 player/url
        const playable = new Set();
        const uncachedIds = [];
        normalized.forEach(function (id) {
            const cached = getCachedSongMeta('song:' + id);
            if (cached && typeof cached.playable === 'boolean') {
                if (cached.playable) playable.add(id);
            } else {
                uncachedIds.push(id);
            }
        });
        for (let i = 0; i < uncachedIds.length; i += 80) {
            const chunk = uncachedIds.slice(i, i + 80);
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
        const cacheKey = 'song:' + songId;
        const cached = getCachedSongMeta(cacheKey);
        if (cached && typeof cached.playable === 'boolean') return cached.playable;

        const detail = await fetchSongDetail(songId);
        const durationMs = Number(detail && (detail.dt || detail.duration || 0));
        const songName = detail && detail.name ? String(detail.name) : '';
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            setCachedSongMeta(cacheKey, { durationMs: 0, playable: false, name: songName });
            return false;
        }
        const playable = await fetchPlayableSongIds([songId]);
        const result = playable.has(String(songId));
        setCachedSongMeta(cacheKey, { durationMs: Math.floor(durationMs), playable: result, name: songName });
        return result;
    }

    async function fetchSongDuration(songId) {
        const cacheKey = 'song:' + songId;
        const cached = getCachedSongMeta(cacheKey);
        if (cached && typeof cached.playable === 'boolean') {
            if (cached.playable && cached.durationMs > 0) return cached.durationMs;
            // 已缓存为不可播/无时长：保留「当前正播放该歌」的实时进度兜底，不再重复请求网易云
            const currentSongId = extractSongId(window.location.hash);
            const { dur, state } = getProgress();
            if (currentSongId === String(songId) && dur > 0 && state === 'play') return dur;
            return 0;
        }

        const detail = await fetchSongDetail(songId);
        const durationMs = Number(detail && (detail.dt || detail.duration || 0));
        const songName = detail && detail.name ? String(detail.name) : '';
        if (Number.isFinite(durationMs) && durationMs > 0) {
            const playable = await fetchPlayableSongIds([songId]);
            const isPlayable = playable.has(String(songId));
            setCachedSongMeta(cacheKey, { durationMs: Math.floor(durationMs), playable: isPlayable, name: songName });
            if (isPlayable) return Math.floor(durationMs);
        }

        const currentSongId = extractSongId(window.location.hash);
        const { dur, state } = getProgress();
        if (currentSongId === String(songId) && dur > 0 && state === 'play') return dur;
        return 0;
    }

    function extractSongId(value) {
        const text = String(value || '');
        const match = text.match(/(?:song\?id=|\/song\?id=|id=)(\d+)/);
        return match ? match[1] : '';
    }

    async function resolveMusicMeta(musicId, musicType) {
        if (musicType !== 'song') return null;
        const durationMs = await fetchSongDuration(musicId);
        return durationMs > 0 ? { durationMs } : null;
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
            if (type !== 'song') return;
            result.push({ type: type, id: id });
        });
        return result;
    }

    // 保存歌曲用：逐行解析 → 规范化（song: 前缀）→ 去重 → 严格格式校验
    // 返回去重后的规范化 ID 数组；含非法行时返回 null（与服务端 musicIDRE 一致）
    function parseSaveSongs(text) {
        const seen = {};
        const ids = [];
        let hasInvalid = false;
        String(text || '').split('\n').forEach(function (line) {
            const trimmed = line.trim();
            if (!trimmed) return;
            let normalized = trimmed;
            if (normalized.indexOf(':') === -1) normalized = 'song:' + normalized;
            if (!/^(song):\d{1,32}$/.test(normalized)) {
                hasInvalid = true;
                return;
            }
            if (!seen[normalized]) {
                seen[normalized] = true;
                ids.push(normalized);
            }
        });
        return hasInvalid ? null : ids;
    }

    // ---- 槽位输入框读写：槽位数动态（songSlotLimit，来自 /api/me），后端仍是「每行一个 ID」的文本 ----
    function getSongSlots() {
        const values = [];
        for (let i = 1; i <= songSlotLimit; i += 1) {
            const el = document.getElementById('my-music-slot-' + i);
            values.push(el ? String(el.value || '').trim() : '');
        }
        return values;
    }

    function songSlotsToText() {
        return getSongSlots().filter(Boolean).join('\n');
    }

    function setSongSlots(text) {
        const lines = String(text || '').split('\n').map(function (s) { return s.trim(); });
        for (let i = 0; i < songSlotLimit; i += 1) {
            const el = document.getElementById('my-music-slot-' + (i + 1));
            if (el) el.value = lines[i] || '';
        }
    }

    // 按 songSlotLimit 重新渲染槽位输入框；保留用户已填写的值，新增槽位以已保存歌单补位
    function renderSongSlots() {
        const container = document.getElementById('my-music-slots');
        if (!container) return;
        const savedText = GM_getValue('myMusicList', '');
        const savedLines = String(savedText || '').split('\n').map(function (s) { return s.trim(); });
        const oldValues = {};
        for (let i = 1; i <= songSlotLimit; i += 1) {
            const el = document.getElementById('my-music-slot-' + i);
            oldValues[i] = el ? String(el.value || '').trim() : (savedLines[i - 1] || '');
        }
        container.innerHTML = '';
        for (let i = 1; i <= songSlotLimit; i += 1) {
            const input = document.createElement('input');
            input.id = 'my-music-slot-' + i;
            input.type = 'text';
            input.placeholder = '槽位 ' + i;
            input.value = oldValues[i] || '';
            input.style.cssText = 'margin-bottom:4px;';
            container.appendChild(input);
        }
    }

    // 规范化后比较（已保存文本与 3 槽位文本做语义对比，忽略 song: 前缀/空行差异）
    function normalizeSongsForCompare(text) {
        const ids = parseSaveSongs(text);
        return ids === null ? String(text || '').trim() : ids.join('\n');
    }

    async function resolveMusics(musicIds) {
        const result = [];
        for (const m of musicIds) {
            if (m.type !== 'song') continue;
            const durationMs = await fetchSongDuration(m.id);
            // fetchSongDuration 内部已通过 fetchSongDetail 拿到歌曲名并写入缓存，这里直接读取
            const cached = getCachedSongMeta('song:' + m.id);
            const name = cached && cached.name ? cached.name : '';
            if (durationMs > 0) {
                result.push({ musicId: `song:${m.id}`, musicMeta: { durationMs: durationMs }, name: name });
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
                        <a id="header-update-link" style="display:none; font-size:12px; color:var(--brand); cursor:pointer;">更新扩展</a>
                        <a id="portal-link" href="${getPortalUrl()}" target="_blank" rel="noopener noreferrer" style="font-size:12px; color:var(--link); text-decoration:underline;">个人中心</a>
                        <a id="logout-link" style="font-size:12px; color:var(--text-muted); display:${token ? 'block' : 'none'}">退出</a>
                        <span id="min-btn" style="cursor:pointer; color:var(--text-muted);">—</span>
                    </div>
                </div>
                <div id="helper-body">
                    <div id="risk-notice" style="${riskAccepted ? 'display:none' : 'display:block'}; white-space:pre-line; font-size:12px; margin-bottom:8px; padding:8px; border-radius:var(--radius); background:#fff7e6; border:1px solid #ffd591; color:var(--warn); line-height:1.5;"></div>
                    <button id="risk-accept-btn" class="btn-primary" style="${riskAccepted ? 'display:none' : 'display:block'}; width:100%; margin-bottom:8px; padding:8px;">我已阅读并确认</button>
                    <div id="login-status" style="font-size:12px; margin-bottom:8px; color:var(--text-secondary);">${token ? '检测登录中...' : '未登录'}</div>
                    <div id="auth-section" style="${token || !riskAccepted ? 'display:none' : 'display:block'}">
                        <button id="login-linuxdo" class="btn-primary" style="width:100%; padding:8px;">登录 Linux.do</button>
                        <button id="update-script-btn" class="btn-primary" style="display:none; margin-top:8px; width:100%; padding:8px;">更新扩展</button>
                    </div>
                    <div id="helper-form" style="${token && riskAccepted ? 'display:block' : 'display:none'}">
                        <div style="margin-bottom:8px;">
                            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">歌曲 ID（每槽一个，如 song:123 或纯数字；留空槽位=不挂载）</div>
                            <div id="my-music-slots" style="margin-bottom:4px;"></div>
                            <div id="slot-apply-section" style="margin-top:6px; font-size:12px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
                                <a id="slot-apply-link" style="color:var(--link); cursor:pointer; text-decoration:underline;">申请增加槽位</a>
                                <span id="slot-apply-pending" style="display:none; color:var(--warn);">槽位申请审核中</span>
                            </div>
                            <div id="slot-apply-form" style="display:none; margin-top:6px;">
                                <input id="slot-apply-count" type="number" min="1" max="10" placeholder="申请增加几个槽位（1~10）" style="margin-bottom:4px;">
                                <textarea id="slot-apply-reason" placeholder="理由（必填）" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:var(--radius); background:#fff; color:var(--text); font-size:12px; padding:5px 6px; margin-bottom:4px; resize:vertical;"></textarea>
                                <div style="display:flex; gap:8px;">
                                    <button id="slot-apply-submit" class="btn-primary" style="flex:1; padding:6px;">提交申请</button>
                                    <button id="slot-apply-cancel" style="flex:1; padding:6px; background:var(--bg-muted); color:var(--text-secondary);">取消</button>
                                </div>
                            </div>
                        </div>
                        <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
                            <select id="my-preference" style="flex:1; background:var(--bg-muted);">
                                <option value="random" ${savedPreference === 'random' ? 'selected' : ''}>随机</option>
                                <option value="short" ${savedPreference === 'short' ? 'selected' : ''}>短歌优先</option>
                                <option value="long" ${savedPreference === 'long' ? 'selected' : ''}>长歌优先</option>
                            </select>
                            <label style="display:flex; align-items:center; gap:4px; font-size:12px; color:var(--text-secondary); white-space:nowrap;">
                                <input type="checkbox" id="auto-start" ${autoStart === '1' ? 'checked' : ''}> 自动开启
                            </label>
                        </div>
                        <div style="display:flex; gap:8px;">
                            <button id="save-songs" class="btn-primary" style="flex:1; padding:8px;">保存</button>
                            <button id="toggle-helper" class="btn-primary" style="flex:1; padding:8px;">开启互助</button>
                        </div>
                    </div>
                    <div id="helper-stats" style="display:none; white-space:pre-line; font-size:12px; margin-top:8px; padding:8px; border-radius:var(--radius); background:var(--bg-soft); border:1px solid var(--line); color:var(--text-secondary); line-height:1.5;"></div>
                    <div id="helper-info" style="display:none; white-space:pre-line; font-size:12px; margin-top:8px; padding:8px; border-radius:var(--radius); background:var(--bg-soft); border:1px solid var(--line); color:var(--text-secondary); line-height:1.5;">就绪...</div>
                    <button id="manual-btn" class="btn-primary" style="display:none; width:100%; margin-top:8px; padding:8px; animation: blink 1s infinite;">点我激活播放</button>
                </div>
            </div>
        `;
        document.body.appendChild(container);
        renderSongSlots();
        GM_addStyle(`
            #music-helper-container {
                --brand:#c20c0c; --brand-hover:#9b0a0a; --ok:#14804a; --bad:#d93025; --warn:#9a6700;
                --disabled:#999999; --panel:#ffffff; --line:#e3e8ef; --text:#333333;
                --text-secondary:#666666; --text-muted:#999999; --link:#1890ff; --bg-muted:#f5f6f8; --bg-soft:#f7f8fa;
                --radius:6px; --radius-lg:10px;
                position: fixed; top: 100px; right: 20px; z-index: 1000000;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                font-size: 12px; user-select: none;
            }
            #music-helper-panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: 0 8px 24px rgba(0,0,0,0.2); width: 220px; overflow: hidden; }
            #helper-header { background: var(--bg-muted); padding: 10px; display: flex; justify-content: space-between; align-items: center; cursor: move; }
            #helper-body { padding: 12px; }
            #helper-toggle-btn { width: 44px; height: 44px; background: var(--brand); color: #fff; border-radius: 50%; display: none; align-items: center; justify-content: center; cursor: move; font-size: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
            #music-helper-container button { font-size: 12px; border: none; border-radius: var(--radius); cursor: pointer; transition: filter .15s ease, opacity .15s ease; }
            #music-helper-container button:hover { filter: brightness(0.92); }
            #music-helper-container button:active { filter: brightness(0.85); }
            #music-helper-container button:disabled { opacity: .6; cursor: not-allowed; }
            #music-helper-container .btn-primary { background: var(--brand); color: #fff; }
            #music-helper-container input[type="text"], #music-helper-container select {
                width: 100%; box-sizing: border-box; border: 1px solid var(--line); border-radius: var(--radius);
                background: #fff; color: var(--text); font-size: 12px; padding: 5px 6px;
            }
            #music-helper-container input[type="text"]:focus, #music-helper-container select:focus { outline: none; border-color: var(--brand); }
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
        document.getElementById('save-songs').onclick = saveSongs;
        document.getElementById('slot-apply-link').onclick = () => {
            if (pendingSlotApplication) return;
            document.getElementById('slot-apply-form').style.display = 'block';
        };
        document.getElementById('slot-apply-cancel').onclick = () => {
            document.getElementById('slot-apply-form').style.display = 'none';
        };
        document.getElementById('slot-apply-submit').onclick = submitSlotApplication;
        document.getElementById('manual-btn').onclick = async () => {
            const btn = document.getElementById('manual-btn');
            btn.innerText = '正在尝试激活播放...';
            btn.disabled = true;
            triggerIframePlay();
            await wait(1500);
            btn.disabled = false;
            const { cur, state } = getProgress();
            if (state === 'play' && cur > 0) {
                btn.style.display = 'none';
            } else {
                btn.innerText = '激活失败，点击重试';
            }
        };
        document.getElementById('min-btn').onclick = () => {
            document.getElementById('music-helper-panel').style.display='none';
            document.getElementById('helper-toggle-btn').style.display='flex';
            updateMinButtonState();
        };
        document.getElementById('helper-toggle-btn').onclick = () => { if(!isDragging){ document.getElementById('music-helper-panel').style.display='block'; document.getElementById('helper-toggle-btn').style.display='none'; } };
        updateMinButtonState();

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
                    up.innerHTML = `<div style="background:#fffbe6; border:1px solid #ffe58f; padding:8px; border-radius:var(--radius); margin-bottom:8px; font-size:12px; color:var(--warn);">发现新版本 v${d.latestVersion}</div>`;
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
        box.style.cssText = 'white-space:pre-line;background:#fff7e6;border:1px solid #ffd591;padding:8px;border-radius:var(--radius);margin-bottom:8px;font-size:12px;color:var(--warn);line-height:1.5;';
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
            if (allowRefreshRetry && token && payload && (payload.error === 'token_expired' || payload.error === 'invalid_or_expired_token')) {
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
        const loginStatus = document.getElementById('login-status');
        const d = await callAPI('GET', '/me');
        if (d && d.user) {
            if (loginStatus) {
                loginStatus.innerText = `已登录: ${d.user.displayName}`;
                loginStatus.style.cursor = '';
                loginStatus.style.color = '';
                loginStatus.onclick = null;
            }
            updateParticipantInfo(d.participant);
            // 动态槽位上限：优先取 /api/me 下发的 song_slot_limit（user 或 participant 里都有），
            // 变化时重新渲染槽位输入框（保留已填内容）。旧后端不下发时保持默认 3。
            const newLimit = Number(
                (d.user && d.user.song_slot_limit) ||
                (d.participant && d.participant.song_slot_limit) ||
                3,
            );
            if (newLimit >= 1 && newLimit !== songSlotLimit) {
                songSlotLimit = newLimit;
                renderSongSlots();
            }
            // 是否有待审核的槽位申请：有则隐藏「申请」入口，展示「槽位申请审核中」
            pendingSlotApplication = !!d.pending_slot_application;
            const pendingEl = document.getElementById('slot-apply-pending');
            const linkEl = document.getElementById('slot-apply-link');
            if (pendingEl) pendingEl.style.display = pendingSlotApplication ? 'block' : 'none';
            if (linkEl) linkEl.style.display = pendingSlotApplication ? 'none' : 'block';
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
                setSongSlots(String(songsRes.songs));
                GM_setValue('myMusicList', String(songsRes.songs));
            } else if (Array.isArray(d.musics) && d.musics.length > 0 && !(GM_getValue('myMusicList', '') || '').trim()) {
                const lines = d.musics.map(function (m) { return m.musicId || ''; }).filter(Boolean);
                if (lines.length > 0) {
                    setSongSlots(lines.join('\n'));
                    GM_setValue('myMusicList', lines.join('\n'));
                }
            }
            return;
        }
        // 登录态获取失败（网络异常等），且无其他错误提示覆盖时：可点击重试
        if (loginStatus && !d && loginStatus.innerText === '检测登录中...') {
            loginStatus.innerText = '登录状态获取失败，点击重试';
            loginStatus.style.cursor = 'pointer';
            loginStatus.style.color = 'var(--bad)';
            loginStatus.onclick = function () {
                loginStatus.innerText = '检测登录中...';
                loginStatus.style.cursor = '';
                loginStatus.style.color = '';
                refreshMe();
            };
        }
    }

    function updateParticipantInfo(participant) {
        if (!participant) return;
        const statsEl = document.getElementById('helper-stats');
        const credits = Number(participant.available_credits != null ? participant.available_credits : participant.credits || 0);
        currentParticipantCredits = credits;
        const todayReceived = Number(participant.today_received_help_count || 0);
        const todayReceivedLimit = Number(participant.today_received_limit || 0);
        const todayHelped = Number(participant.today_helped_count || 0);
        const todayHelpedLimit = Number(participant.today_helped_limit || 200);
        const monthlyReceived = Number(participant.monthly_received_help_count || 0);
        const monthlyLimit = Number(participant.monthly_received_limit || 0);
        const lines = [];
        if (todayReceivedLimit > 0) lines.push(`今日被助: ${todayReceived} / ${todayReceivedLimit}`);
        lines.push(`今日助力: ${todayHelped} / ${todayHelpedLimit}`);
        if (monthlyLimit > 0) lines.push(`本月被助: ${monthlyReceived} / ${monthlyLimit}`);
        lines.push(`可用额度: ${credits}`);
        // 数据区常驻可见，运行时也不被「正在互助」文本覆盖
        if (statsEl) {
            statsEl.style.display = 'block';
            statsEl.innerText = lines.join('\n');
        }
    }

    // helper-info 状态色分层：空闲/正常=中性，运行中=绿色，保存成功=绿色，错误/待审核=黄色。只改颜色不改文字。
    function setHelperInfoStyle(kind) {
        const infoEl = document.getElementById('helper-info');
        if (!infoEl) return;
        if (kind === 'running' || kind === 'success') {
            infoEl.style.background = '#e8f5ee';
            infoEl.style.borderColor = '#bfe5cf';
            infoEl.style.color = 'var(--ok)';
        } else if (kind === 'warn') {
            infoEl.style.background = '#fff7e6';
            infoEl.style.borderColor = '#ffd591';
            infoEl.style.color = 'var(--warn)';
        } else {
            infoEl.style.background = 'var(--bg-soft)';
            infoEl.style.borderColor = 'var(--line)';
            infoEl.style.color = 'var(--text-secondary)';
        }
    }

    // 在 helper-info 中显示一条状态文案（kind 同 setHelperInfoStyle）
    function showHelperInfo(text, kind) {
        const infoEl = document.getElementById('helper-info');
        if (!infoEl) return;
        infoEl.style.display = 'block';
        infoEl.innerText = text;
        setHelperInfoStyle(kind || 'neutral');
    }

    // 最小化圆点按钮状态色：有新版本=黄，运行中=绿，否则=红（品牌色）
    function updateMinButtonState() {
        const btn = document.getElementById('helper-toggle-btn');
        if (!btn) return;
        let color = 'var(--brand)';
        if (updateAvailable) color = 'var(--warn)';
        else if (isHelperRunning) color = 'var(--ok)';
        btn.style.background = color;
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

    // 「申请增加槽位」：弹简易表单（数字 + 理由必填）→ POST /api/slot-applications → 提示「已提交，待管理员审核」
    async function submitSlotApplication() {
        if (GM_getValue(RISK_ACCEPTED_KEY, '') !== '1') return;
        if (upgradeRequired) return;
        if (pendingSlotApplication) {
            showHelperInfo('已有待审核的槽位申请，请等待管理员处理。', 'warn');
            return;
        }
        const countInput = document.getElementById('slot-apply-count');
        const reasonInput = document.getElementById('slot-apply-reason');
        const requestedSlots = Number(countInput ? countInput.value : 0);
        const reason = String(reasonInput ? reasonInput.value || '' : '').trim();
        if (!Number.isInteger(requestedSlots) || requestedSlots < 1 || requestedSlots > 10) {
            showHelperInfo('请填写申请增加的槽位数（1~10）。', 'warn');
            return;
        }
        if (!reason) {
            showHelperInfo('请填写申请理由。', 'warn');
            return;
        }
        const d = await callAPI('POST', '/slot-applications', { requested_slots: requestedSlots, reason: reason });
        if (!d) {
            showHelperInfo('提交失败，请检查网络后重试。', 'warn');
            return;
        }
        if (d.error) {
            showHelperInfo(d.message || getPayloadErrorText(d, 'submit_failed'), 'warn');
            return;
        }
        pendingSlotApplication = true;
        const form = document.getElementById('slot-apply-form');
        const pendingEl = document.getElementById('slot-apply-pending');
        const linkEl = document.getElementById('slot-apply-link');
        if (form) form.style.display = 'none';
        if (pendingEl) pendingEl.style.display = 'block';
        if (linkEl) linkEl.style.display = 'none';
        showHelperInfo(d.message || '已提交，待管理员审核。', 'warn');
    }

    // 「保存歌曲」：本地校验（去重 / 数量 ≤ songSlotLimit / 格式）→ 删歌确认 → POST /songs
    // 按服务端返回的 status 提示：approved=已保存；pending=已提交审核，待管理员审核
    // 返回 null 表示未保存成功（校验失败/删歌取消/网络或服务端错误）；成功时返回规范化文本
    async function saveSongs() {
        if (GM_getValue(RISK_ACCEPTED_KEY, '') !== '1') return null;
        if (upgradeRequired) return null;
        const rawText = songSlotsToText();
        const slotLines = rawText.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        if (slotLines.some(function (line) { return line.indexOf('album:') === 0; })) {
            showHelperInfo('暂不支持专辑，仅支持单曲。', 'warn');
            return null;
        }
        const ids = parseSaveSongs(rawText);
        if (ids === null) {
            showHelperInfo('歌曲 ID 格式不正确，应为 song:数字 或纯数字，每槽一个。', 'warn');
            return null;
        }
        if (ids.length > songSlotLimit) {
            showHelperInfo('最多只能保存 ' + songSlotLimit + ' 首歌曲。', 'warn');
            return null;
        }
        // 删歌确认：旧列表有、新列表没有 → 确认后才提交
        const oldIds = parseSaveSongs(GM_getValue('myMusicList', ''));
        if (oldIds !== null) {
            const removed = oldIds.filter(function (id) { return ids.indexOf(id) === -1; });
            if (removed.length > 0 && !window.confirm('确认提交删除？\n以下歌曲将从被助列表中移除：\n' + removed.join('\n'))) {
                return null;
            }
        }
        const savedText = ids.join('\n');
        const d = await callAPI('POST', '/songs', { songs: savedText });
        if (!d) {
            showHelperInfo('保存失败，请检查网络后重试。', 'warn');
            return null;
        }
        if (d.error) {
            showHelperInfo(d.message || getPayloadErrorText(d, 'save_failed'), 'warn');
            return null;
        }
        GM_setValue('myMusicList', savedText);
        setSongSlots(savedText);
        if (d.status === 'pending') {
            showHelperInfo(d.message || '已提交审核，待管理员审核。', 'warn');
        } else {
            showHelperInfo(d.message || '已保存。', 'success');
        }
        return savedText;
    }

    async function toggleHelper() {
        if (GM_getValue(RISK_ACCEPTED_KEY, '') !== '1') return;
        if (upgradeRequired) return;
        if (isHelperRunning) {
            // 手动停止互助：同步取消「自动开启」，避免下次刷新自动复活
            const autoStartEl = document.getElementById('auto-start');
            if (autoStartEl) autoStartEl.checked = false;
            GM_setValue('autoStart', '0');
            stopHelper();
            return;
        }
        let listText = songSlotsToText();
        const preference = document.getElementById('my-preference').value;
        // 开启前对比 3 槽位与已保存列表：有未保存改动则询问是否先保存
        if (normalizeSongsForCompare(listText) !== normalizeSongsForCompare(GM_getValue('myMusicList', ''))) {
            if (window.confirm('改动尚未保存，是否先保存？')) {
                const saved = await saveSongs();
                if (saved === null) return; // 保存失败/被取消，不开启
                listText = saved; // 用规范化后的文本
            }
        }
        const musicIds = parseMusicIds(listText);
        GM_setValue('myMusicList', listText);
        GM_setValue('myPreference', preference);
        GM_setValue('autoStart', document.getElementById('auto-start').checked ? '1' : '0');
        // 用户手动开启互助，视为可能修改了歌单：先清掉这些歌曲的解析缓存，重新从网易云解析
        invalidateSongMetaList(musicIds);
        await startHelper(musicIds, preference);
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
            toggleButton.style.background = 'var(--brand)';
            toggleButton.disabled = false;
        }
        if (helperInfo) {
            helperInfo.innerText = '已停止本机互助播放；已保存的歌曲仍会按剩余额度被其他人互助。';
        }
        setHelperInfoStyle('neutral');
        updateMinButtonState();
    }

    async function startHelper(musicIds, preference) {
        isHelperRunning = true;
        activeJoinState = { musicIds: musicIds, musics: null, preference: preference };
        document.getElementById('toggle-helper').innerText = '停止互助';
        document.getElementById('toggle-helper').style.background = 'var(--ok)';
        document.getElementById('helper-info').style.display = 'block';
        setHelperInfoStyle('running');
        updateMinButtonState();
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

    async function finishCurrentJob(jobId, playedMs, positionMs, durationMs, evidence) {
        if (!jobId) return null;
        const payload = { jobId, playedMs, positionMs, durationMs };
        if (evidence) {
            // 反作弊信号：monitorTick 里已算好的播放行为证据，字段名保持 camelCase。
            payload.playbackRate = Number(evidence.playbackRate) || 0;
            payload.jumpCount = Number(evidence.jumpCount) || 0;
            payload.backwardJumpCount = Number(evidence.backwardJumpCount) || 0;
            payload.listenDriftMs = Number(evidence.listenDriftMs) || 0;
            payload.recoveryAttempts = Number(evidence.recoveryAttempts) || 0;
            payload.stallDetected = !!evidence.stallDetected;
        }
        return callAPI('POST', '/play/finish', payload);
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
            // 播放状态变量提前声明，供「失败主动放弃」与后续监控共用
            let startTime = Date.now(), hasTriggered = false, finished = false;
            let prevCur = 0, prevDur = 0, prevTickAt = 0, localListenedMs = 0, suspiciousJumps = 0, cleanTicks = 0;
            let mismatchTicks = 0, lastRetargetAt = 0, retargeting = false, recoveryAttempts = 0;
            let lastHeartbeatAt = 0;
            let lastCurMoveAt = 0, lastStallCur = 0;
            // 反作弊证据（finish 时随 /play/finish 上报服务端，字段名见 finishCurrentJob）：
            // 回退次数、观察到的最大倍速、是否判定卡死过、最后一次进度与有效播放漂移。
            let backwardJumps = 0, maxPlaybackRate = 0, stallDetected = false, lastDriftMs = 0;
            const abandonCurrentJob = async (reason, fallbackMs = 3000) => {
                // 主动上报失败并放弃当前任务：成功后立即释放本单并继续下一单；
                // 上报失败/超时则回退到原来的延时重试逻辑，等服务端懒清扫判过期。
                finished = true;
                clearInterval(monitorTimer);
                infoEl.innerText = `目标歌曲播放失败，正在上报并放弃当前任务...\n原因: ${reason}`;
                let result = null;
                try {
                    result = await callAPI('POST', '/play/abandon', { jobId: jobId, reason: reason });
                } catch (e) {
                    result = null;
                }
                if (result && result.ok) {
                    infoEl.innerText = `已主动放弃当前任务（${reason}），继续下一单...`;
                    playNext();
                } else {
                    infoEl.innerText = `目标歌曲播放失败，准备重试...\n原因: ${reason}`;
                    setTimeout(playNext, fallbackMs);
                }
            };
            try { const p = getSafePlayer(); if(p && p.stop) p.stop(); } catch(e) {}
            infoEl.innerText = `正在跳转...\n目标: ${data.owner && data.owner.displayName ? data.owner.displayName : '互助用户'}`;

            const expectedSongId = String(id);
            const playbackError = await prepareTargetPlayback(expectedSongId);
            if (!isHelperRunning) {
                await idleCleanupPlaybackBestEffort();
                return;
            }
            if (playbackError) {
                // 播放失败（歌不可播 / 加载或播放按钮没生效）：清掉该歌曲的可播/时长缓存，下次遇到时重新解析，并主动上报失败放弃当前任务
                invalidateSongMeta('song:' + expectedSongId);
                await abandonCurrentJob(playbackError, 3000);
                return;
            }
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
                lastCurMoveAt = 0;
                lastStallCur = 0;
            };
            const recoverTargetPlayback = async (reason) => {
                if (retargeting) return false;
                if (recoveryAttempts >= 3) {
                    // 已重试 3 次仍无法恢复：主动上报失败并放弃当前任务
                    await abandonCurrentJob('load_failed', 3000);
                    return false;
                }
                recoveryAttempts += 1;
                retargeting = true;
                clearInterval(monitorTimer);
                infoEl.innerText = `播放状态异常，正在重新初始化...\n原因: ${reason}\n目标歌曲: ${expectedSongId}`;
                const playbackError = await prepareTargetPlayback(expectedSongId);
                resetPlaybackAccounting();
                retargeting = false;
                if (playbackError) {
                    // 恢复播放失败：主动上报失败并放弃当前任务
                    invalidateSongMeta('song:' + expectedSongId);
                    await abandonCurrentJob(playbackError, 3000);
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
                // 汇总本次任务的播放行为证据，随 /play/finish 上报服务端反作弊。
                const evidence = {
                    playbackRate: maxPlaybackRate,
                    jumpCount: suspiciousJumps,
                    backwardJumpCount: backwardJumps,
                    listenDriftMs: lastDriftMs,
                    recoveryAttempts: recoveryAttempts,
                    stallDetected: stallDetected,
                };
                // 对同一个 jobId 的 /play/finish 做有限次重试（初始 1 次 + 最多 2 次重试），
                // 网络/服务端失败时不作废本次有效播放。finished=true 已在首个 await 前同步置位，
                // 重试期间 monitorTick 不会重复触发完成。
                let result = null;
                for (let attempt = 0; attempt <= 2; attempt += 1) {
                    result = await finishCurrentJob(jobId, playedMs, positionMs, durationMs, evidence);
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
                    infoEl.innerText = credited
                        ? `助力成功\n本次获得额度: ${earnedCredits}${credits === null ? '' : `\n当前剩余额度: ${credits}`}`
                        : `任务已提交过\n本次未重复增加额度${credits === null ? '' : `\n当前剩余额度: ${credits}`}`;
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
                // 播放中进度长时间不动（VIP 试听卡死等）：state='play' 但进度超过 PLAYBACK_STALL_MS 未前移，判定卡死主动放弃
                if (state === 'play' && dur > 0) {
                    if (lastCurMoveAt === 0) {
                        lastCurMoveAt = now;
                        lastStallCur = cur;
                    } else if (cur !== lastStallCur) {
                        lastStallCur = cur;
                        lastCurMoveAt = now;
                    } else if (now - lastCurMoveAt >= PLAYBACK_STALL_MS) {
                        stallDetected = true;
                        await abandonCurrentJob('playback_stalled', 3000);
                        return;
                    }
                }
                const playbackRate = getPlaybackRate();
                if (playbackRate > maxPlaybackRate) maxPlaybackRate = playbackRate;
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
                lastDriftMs = progressListenDrift;
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
                        // 任务歌曲持续不一致、重试也无法恢复：主动上报失败并放弃当前任务
                        await abandonCurrentJob('load_failed', 3000);
                        return;
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
                        backwardJumps += 1;
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
                    const speedWarning = playbackRateInvalid ? '\n检测到倍速播放，请恢复 1x 后继续' : '';
                    const displayDurationMs = expectedDurationMs > 0 ? expectedDurationMs : dur;
                    const displayListenedMs = displayDurationMs > 0 ? Math.min(localListenedMs, displayDurationMs) : localListenedMs;
                    const currentCreditsLine = currentParticipantCredits === null ? '' : `\n当前剩余额度: ${currentParticipantCredits}`;
                    infoEl.innerText = `正在互助 [单曲]\n歌曲时长: ${formatTime(displayDurationMs)}\n当前进度: ${formatTime(cur)}\n有效播放: ${formatTime(displayListenedMs)} / ${formatTime(requiredListenMs)}\n本次完成可得额度: ${creditCost}${currentCreditsLine}${speedWarning}`;

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
