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
    var vipTypeCache = null;
    function ensureVipType() {
      if (vipTypeCache !== null) return Promise.resolve(vipTypeCache);
      return fetch('/api/nuser/account/get', { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var vt = d && d.account && typeof d.account.vipType === 'number' ? d.account.vipType : 0;
          vipTypeCache = vt;
          return vt;
        })
        .catch(function () { vipTypeCache = 0; return 0; });
    }
    const SIGN_VERSION = '4.0.21'; // 服务端下发脚本时会注入该常量（replaceCurrentVersion）
    const LEGACY_VERSION = '4.0.13';
    // HMAC 签名防重放（V4.0.14 引入）：只有能计算签名（crypto.subtle 可用）时才宣告
    // 新版本并携带 X-Timestamp/X-Nonce/X-Signature；不能算就保持旧版本号，服务端按
    // 旧版路径跳过签名校验，避免 403。
    const CAN_SIGN = typeof crypto !== 'undefined' && !!crypto.subtle;
    const CURRENT_VERSION = CAN_SIGN ? SIGN_VERSION : LEGACY_VERSION;
    const IS_EXTENSION = true;
    const EXTENSION_UPGRADE_PAGE_URL = 'https://163music.linyu.qzz.io/extension-upgrade.html';
    const UPDATE_FALLBACK_URL = 'https://163music.linyu.qzz.io/music-help.user.js';
    const TOKEN_KEY = 'musicHelperToken';
    const LEGACY_TOKEN_KEY = 'linuxDoToken';
    const ACCESS_EXPIRES_AT_KEY = 'musicHelperAccessExpiresAt';
    const REFRESH_EXPIRES_AT_KEY = 'musicHelperRefreshExpiresAt';
    const ERROR_KEY = 'musicHelperLastError';
    // 扩展与油猴脚本并存时，localStorage/sessionStorage 同名键会互踢/双跑（P11）。
    // 仅对「直接写 localStorage/sessionStorage」的键加命名空间前缀；GM_* 键（token 等）
    // 走扩展自身 localStorage，与油猴 Tampermonkey 存储天然隔离，不在此列。
    const STORAGE_NS = 'mhExt:';
    const TAB_LOCK_KEY = STORAGE_NS + 'musicHelperActiveTabLock';
    const TAB_ID_KEY = STORAGE_NS + 'musicHelperTabId';
    const RISK_ACCEPTED_KEY = 'musicHelperRiskAcceptedV1';
    const RISK_NOTICE_TEXT = [
        '使用前请确认：本脚本仅用于个人学习、研究与浏览器自动化实践，不提供音乐内容、不破解会员权益、不绕过版权或付费限制。',
        '请遵守网易云音乐、Linux.do、浏览器扩展平台及所在地区法律法规和服务条款。因使用脚本产生的账号、数据、版权、合规或其他风险由使用者自行承担。',
        '如果你不同意以上说明，请立即停用并删除本脚本。'
    ].join('\n');
    const JOIN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
    const SONG_META_CACHE_KEY = STORAGE_NS + 'musicHelperSongMetaCache';
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
    // 4.0.20：歌曲元数据权威 map（/api/me musics，musicId → {name, durationMs}），
    // 供折叠摘要即时渲染；refreshMe 时刷新，缺失时回退本地缓存/异步解析。
    let songMetaMap = null;
    // 4.0.20：N1 每日预计消耗数据源 —— 槽位歌曲最长时长（秒级口径）与每日被助上限生效值
    let currentMaxSongDurationMs = 0;
    let currentTodayReceivedLimit = 30; // 旧后端不下发时兜底 30（与服务端默认一致）
    // 4.0.20：歌曲修改是否处于「待审核」态（saveSongs 返回 pending / refreshMe /songs status=pending）
    let savedSongsPendingReview = false;

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
        // isPlayableSong 可能返回 'network_error'（网络失败，未写缓存）：退避重试，瞬时抖动不判不可播；
        // 确实不可播（false）才返回 song_unplayable；仍网络失败则按 load_failed 处理（同样不写不可播缓存）。
        let playable = await isPlayableSong(targetSongId);
        for (let attempt = 0; playable === 'network_error' && attempt < 2; attempt += 1) {
            await wait(1000 * (attempt + 1));
            playable = await isPlayableSong(targetSongId);
        }
        if (playable === false) return 'song_unplayable';
        if (playable === 'network_error') return 'load_failed';
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
        if (code === 'client_upgrade_required') return '你的脚本版本过低，请更新。';
        if (code === 'service_paused') return '服务已暂停，请稍后再试。';
        if (code === 'service_manual_blocked') return '服务已被管理员临时暂停，请稍后再试。';
        if (code === 'service_d1_blocked') return '网络环境不稳定，暂停互助一个小时';
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
            ? `你的脚本版本过低，最低支持版本为 v${requiredText}`
            : '你的脚本版本过低，请更新';
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

    // 网络失败哨兵：fetchJSON 在网络层错误（fetch reject / 断网 / 非 2xx）时返回该值，
    // 区别于「请求成功但无数据（null）」，供上层区分「网络抖动（退避重试）」与「确实不可播」。
    const NETWORK_ERROR = {};

    async function fetchJSON(path) {
        try {
            const res = await fetch(path, { credentials: 'include' });
            if (!res.ok) return NETWORK_ERROR; // 非 2xx（含 5xx / 风控 429）视为网络类失败
            return safeJSON(await res.text());
        } catch (e) {
            return NETWORK_ERROR;
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
        if (data === NETWORK_ERROR) return NETWORK_ERROR;
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
            if (data === NETWORK_ERROR) return NETWORK_ERROR;
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
        if (detail === NETWORK_ERROR) return 'network_error'; // 网络失败：不写不可播缓存
        const durationMs = Number(detail && (detail.dt || detail.duration || 0));
        const songName = detail && detail.name ? String(detail.name) : '';
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            setCachedSongMeta(cacheKey, { durationMs: 0, playable: false, name: songName });
            return false;
        }
        const playable = await fetchPlayableSongIds([songId]);
        if (playable === NETWORK_ERROR) return 'network_error';
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
        if (detail === NETWORK_ERROR) return 0; // 网络失败：不写缓存，交给进度兜底
        const durationMs = Number(detail && (detail.dt || detail.duration || 0));
        const songName = detail && detail.name ? String(detail.name) : '';
        if (Number.isFinite(durationMs) && durationMs > 0) {
            const playable = await fetchPlayableSongIds([songId]);
            if (playable !== NETWORK_ERROR) {
                const isPlayable = playable.has(String(songId));
                setCachedSongMeta(cacheKey, { durationMs: Math.floor(durationMs), playable: isPlayable, name: songName });
                if (isPlayable) return Math.floor(durationMs);
            }
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

    // 4.0.20：紧凑时长格式（去掉前导 0）：200000ms → 3:20
    function formatCompactMs(ms) {
        if (isNaN(ms) || ms <= 0) return '--:--';
        const s = Math.floor(ms / 1000);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    // 4.0.20 N2：歌名/时长三级数据源快照 —— ①refreshMe 的 d.musics（权威）→ ②本地缓存 → ③null（触发异步解析）
    function getSongMetaSnapshot(musicIdText) {
        const bare = String(musicIdText || '').trim().replace(/^song:/, '');
        if (!/^\d+$/.test(bare)) return null;
        if (songMetaMap) {
            const hit = songMetaMap['song:' + bare] || songMetaMap[bare];
            if (hit) return { name: String(hit.name || ''), durationMs: Number(hit.durationMs || 0) };
        }
        const cached = getCachedSongMeta('song:' + bare);
        if (cached) return { name: String(cached.name || ''), durationMs: Number(cached.durationMs || 0) };
        return null;
    }

    // 4.0.20 N2：对歌名/时长未知的歌曲异步解析（fetchSongDuration 内部写缓存），完成后回调 refresh()。
    // 只对快照缺失的 id 发起请求（in-flight 去重，双态渲染切换不重复请求）；
    // 解析完成后再渲染即为缓存命中，不会重复请求。
    const songMetaRefillInflight = new Set();
    // 会话级负缓存：解析失败/无进展的 id 不再反复请求（网络长期故障时防重复轰炸）
    const songMetaRefillFailed = new Set();
    function scheduleSongMetaRefill(refresh) {
        const ids = new Set();
        const collect = (text) => {
            const bare = String(text || '').trim().replace(/^song:/, '');
            if (/^\d+$/.test(bare)) ids.add(bare);
        };
        String(GM_getValue('myMusicList', '') || '').split('\n').forEach(collect);
        for (let i = 1; i <= songSlotLimit; i += 1) {
            const el = document.getElementById('my-music-slot-' + i);
            if (el) collect(el.value);
        }
        let pending = 0;
        ids.forEach((id) => {
            if (getSongMetaSnapshot(id)) return;
            if (songMetaRefillInflight.has(id)) return;
            if (songMetaRefillFailed.has(id)) return;
            pending += 1;
            songMetaRefillInflight.add(id);
            fetchSongDuration(id).then(() => {
                songMetaRefillInflight.delete(id);
                // 仅在解析有进展（缓存已写入）时触发刷新，避免网络失败时形成「失败→重渲染→再请求」循环
                if (getSongMetaSnapshot(id)) { try { refresh(); } catch (e) {} }
                else { songMetaRefillFailed.add(id); }
            }).catch(() => { songMetaRefillInflight.delete(id); songMetaRefillFailed.add(id); });
        });
        return pending;
    }

    // 4.0.20 N2：折叠态摘要渲染 —— 摘要行「N 首 · 最长 m:ss · 合计 m:ss」+ 逐行「序号. 歌名 时长 状态徽标」（无 ID）
    function renderSongSlotsSummary() {
        const bar = document.getElementById('slot-summary-bar');
        const textEl = document.getElementById('slot-summary-text');
        const listEl = document.getElementById('slot-summary-list');
        if (!bar || !textEl || !listEl) return;
        const savedLines = String(GM_getValue('myMusicList', '') || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        if (savedLines.length === 0) {
            textEl.textContent = '暂无已保存歌曲';
            listEl.innerHTML = '';
            listEl.style.display = 'none';
            return;
        }
        let totalMs = 0, maxMs = 0, known = 0, missing = 0;
        savedLines.forEach(function (line) {
            const meta = getSongMetaSnapshot(line);
            if (meta && meta.durationMs > 0) {
                totalMs += meta.durationMs;
                maxMs = Math.max(maxMs, meta.durationMs);
                known += 1;
            } else if (!meta) {
                missing += 1;
            }
        });
        textEl.textContent = `已保存 ${savedLines.length} 首 · 最长 ${known > 0 ? formatCompactMs(maxMs) : '--:--'} · 合计 ${known > 0 ? formatCompactMs(totalMs) : '--:--'}`;
        listEl.innerHTML = '';
        // 审核中徽标仅表示歌曲保存待审（槽位申请 pending 与歌曲审核态无关）
        const pendingReview = savedSongsPendingReview;
        const frag = document.createDocumentFragment();
        savedLines.forEach(function (line, idx) {
            const meta = getSongMetaSnapshot(line);
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:4px; font-size:12px; line-height:1.6; color:var(--text-secondary);';
            const num = document.createElement('span');
            num.style.cssText = 'color:var(--text-muted);';
            num.textContent = (idx + 1) + '.';
            const name = document.createElement('span');
            name.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            name.textContent = meta && meta.name ? meta.name : '…';
            const dur = document.createElement('span');
            dur.style.cssText = 'color:var(--text-muted);';
            // 已解析（有缓存/权威数据）但时长为 0（不可播等）→ 不显示时长；未解析 → 「…」
            dur.textContent = meta ? (meta.durationMs > 0 ? formatCompactMs(meta.durationMs) : '') : '…';
            const badge = document.createElement('span');
            badge.style.cssText = 'flex-shrink:0; font-size:11px; ' + (pendingReview ? 'color:var(--warn);' : 'color:var(--ok);');
            badge.textContent = pendingReview ? '⏳审核中' : '✓生效';
            row.appendChild(num);
            row.appendChild(name);
            row.appendChild(dur);
            row.appendChild(badge);
            frag.appendChild(row);
        });
        listEl.appendChild(frag);
        listEl.style.display = 'block';
        if (missing > 0) scheduleSongMetaRefill(renderSongSlotsSummary);
    }

    // 4.0.20 N2：展开态歌名/时长标签原位刷新（不重建输入框，避免打断用户输入）
    function refreshSlotMetaLabels() {
        const container = document.getElementById('my-music-slots');
        if (!container) return;
        for (let i = 1; i <= songSlotLimit; i += 1) {
            const el = document.getElementById('my-music-slot-' + i);
            const meta = container.querySelector('.slot-meta-el[data-slot="' + i + '"]');
            if (!el || !meta) continue;
            const snap = getSongMetaSnapshot(el.value);
            if (snap) {
                const parts = [];
                if (snap.name) parts.push(snap.name);
                if (snap.durationMs > 0) parts.push(formatCompactMs(snap.durationMs));
                meta.textContent = parts.join(' ');
            } else if (String(el.value || '').trim()) {
                meta.textContent = '…';
            } else {
                meta.textContent = '';
            }
        }
    }

    // 4.0.20 N2：折叠/展开双态渲染入口 —— 输入框始终存在（getSongSlots/saveSongs/toggleHelper 依赖），只切换可见性；
    // 折叠态渲染摘要（读 GM myMusicList），展开态渲染完整槽位（歌名·时长·ID 输入框可改 + 删除 + 底部新增槽）
    function renderSongSlotsUI() {
        renderSongSlots();
        const collapsed = GM_getValue('songSlotsCollapsed', '1') === '1';
        const bar = document.getElementById('slot-summary-bar');
        const slots = document.getElementById('my-music-slots');
        const hint = document.getElementById('slot-hint');
        const addRow = document.getElementById('slot-add-row');
        const expandBtn = document.getElementById('slot-expand-btn');
        if (bar) bar.style.display = collapsed ? 'block' : 'none';
        if (slots) slots.style.display = collapsed ? 'none' : 'block';
        if (hint) hint.style.display = collapsed ? 'none' : 'block';
        if (addRow) addRow.style.display = collapsed ? 'none' : 'flex';
        if (expandBtn) expandBtn.innerText = collapsed ? '展开编辑 ▾' : '收起 ▴';
        if (collapsed) renderSongSlotsSummary();
    }

    // 按 songSlotLimit 重新渲染槽位输入框；保留用户已填写的值，新增槽位以已保存歌单补位。
    // 4.0.20 N2：每行 = 歌名·时长标签 + ID 输入框（可改）+ 删除按钮；setSongSlots/getSongSlots/songSlotsToText 语义不变。
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
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:4px; margin-bottom:4px;';
            const meta = document.createElement('span');
            meta.className = 'slot-meta-el';
            meta.setAttribute('data-slot', String(i));
            meta.style.cssText = 'flex-shrink:0; font-size:11px; color:var(--text-muted); min-width:52px; max-width:52px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
            const input = document.createElement('input');
            input.id = 'my-music-slot-' + i;
            input.type = 'text';
            input.placeholder = '槽位 ' + i;
            input.value = oldValues[i] || '';
            input.style.cssText = 'flex:1; min-width:0;';
            // 输入时即时刷新该行歌名/时长标签；未知 id 触发异步解析
            input.addEventListener('input', function () {
                const snap = getSongMetaSnapshot(input.value);
                if (snap) {
                    const parts = [];
                    if (snap.name) parts.push(snap.name);
                    if (snap.durationMs > 0) parts.push(formatCompactMs(snap.durationMs));
                    meta.textContent = parts.join(' ');
                } else {
                    meta.textContent = String(input.value || '').trim() ? '…' : '';
                }
                if (String(input.value || '').trim() && !snap) scheduleSongMetaRefill(refreshSlotMetaLabels);
            });
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.innerText = '✕';
            delBtn.title = '删除此槽';
            delBtn.style.cssText = 'flex-shrink:0; background:var(--bg-muted); color:var(--text-muted); padding:2px 6px; font-size:11px;';
            delBtn.onclick = function () {
                input.value = '';
                renderSongSlots();
            };
            row.appendChild(meta);
            row.appendChild(input);
            row.appendChild(delBtn);
            container.appendChild(row);
            const snap = getSongMetaSnapshot(oldValues[i]);
            if (snap) {
                const parts = [];
                if (snap.name) parts.push(snap.name);
                if (snap.durationMs > 0) parts.push(formatCompactMs(snap.durationMs));
                meta.textContent = parts.join(' ');
            } else if (oldValues[i]) {
                meta.textContent = '…';
            }
        }
        scheduleSongMetaRefill(refreshSlotMetaLabels);
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
                        <a id="mute-toggle-link" title="切换网易云标签页静音（默认开）" style="font-size:12px; color:var(--link); cursor:pointer;">静音:开</a>
                        <a id="logout-link" style="font-size:12px; color:var(--text-muted); display:${token ? 'block' : 'none'}">退出</a>
                        <span id="min-btn" style="cursor:pointer; color:var(--text-muted);">—</span>
                    </div>
                </div>
                <div id="helper-body">
                    <div id="risk-notice" style="${riskAccepted ? 'display:none' : 'display:block'}; white-space:pre-line; font-size:12px; margin-bottom:8px; padding:8px; border-radius:var(--radius); background:var(--warn-bg); border:1px solid var(--warn-line); color:var(--warn); line-height:1.5;"></div>
                    <button id="risk-accept-btn" class="btn-primary" style="${riskAccepted ? 'display:none' : 'display:block'}; width:100%; margin-bottom:8px; padding:8px;">我已阅读并确认</button>
                    <div id="login-status" style="font-size:12px; margin-bottom:8px; color:var(--text-secondary);">${token ? '检测登录状态...' : '未登录'}</div>
                    <div id="auth-section" style="${token || !riskAccepted ? 'display:none' : 'display:block'}">
                        <button id="login-linuxdo" class="btn-primary" style="width:100%; padding:8px;">登录 Linux.do</button>
                        <button id="update-script-btn" class="btn-primary" style="display:none; margin-top:8px; width:100%; padding:8px;">更新扩展</button>
                    </div>
                    <!-- 4.0.20 P1：状态区（状态灯 + helper-info 文案，状态色随 setHelperInfoStyle 同步） -->
                    <div id="status-section" class="panel-section panel-section-first">
                        <div class="section-label">状态</div>
                        <div style="display:flex; align-items:flex-start; gap:6px;">
                            <span id="status-dot" style="flex-shrink:0; width:8px; height:8px; margin-top:6px; border-radius:50%; background:var(--text-muted);"></span>
                            <div id="helper-info" style="flex:1; min-width:0; white-space:pre-line; font-size:12px; padding:6px 8px; border-radius:var(--radius); background:var(--bg-soft); border:1px solid var(--line); color:var(--text-secondary); line-height:1.5;">就绪...</div>
                        </div>
                    </div>
                    <!-- 4.0.20 P1：统计区（helper-stats + N1 每日预计消耗常驻行） -->
                    <div id="stats-section" class="panel-section">
                        <div class="section-label">统计</div>
                        <div id="helper-stats" style="display:none; white-space:pre-line; font-size:12px; padding:8px; border-radius:var(--radius); background:var(--bg-soft); border:1px solid var(--line); color:var(--text-secondary); line-height:1.5;"></div>
                        <div id="daily-consume-line" style="display:none; margin-top:6px; padding:6px 8px; border-radius:var(--radius); background:var(--bg-muted); border:1px dashed var(--line); color:var(--text-muted); font-size:11px; line-height:1.5;"></div>
                    </div>
                    <div id="helper-form" style="${token && riskAccepted ? 'display:block' : 'display:none'}">
                        <!-- 4.0.20 P1：操作区（槽位折叠摘要 + 槽位编辑 + 偏好/自动开启 + 保存/开启） -->
                        <div id="ops-section" class="panel-section">
                            <div class="section-label">歌曲</div>
                            <!-- 4.0.20 N2：折叠摘要区（默认折叠，保存后自动折叠；展开态隐藏） -->
                            <div id="slot-summary-bar" style="display:none; margin-bottom:6px; padding:6px 8px; border-radius:var(--radius); background:var(--bg-soft); border:1px solid var(--line);">
                                <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                                    <span id="slot-summary-text" style="font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></span>
                                    <button id="slot-expand-btn" type="button" style="flex-shrink:0; background:var(--bg-muted); color:var(--text-secondary); padding:2px 8px;">展开编辑 ▾</button>
                                </div>
                                <div id="slot-summary-list" style="display:none; margin-top:4px;"></div>
                            </div>
                            <div id="slot-hint" style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">歌曲 ID（每槽一个，如 song:123 或纯数字；留空槽位=不挂载）</div>
                            <div id="my-music-slots" style="margin-bottom:4px;"></div>
                            <!-- 4.0.20 N2：展开态底部新增槽 -->
                            <div id="slot-add-row" style="display:none; margin-bottom:4px;">
                                <div style="display:flex; gap:4px;">
                                    <input id="new-slot-input" type="text" placeholder="新增歌曲 ID（song:123 或纯数字）" style="flex:1;">
                                    <button id="slot-add-btn" type="button" style="background:var(--bg-muted); color:var(--text-secondary); padding:4px 10px;">添加</button>
                                </div>
                            </div>
                            <div style="display:flex; gap:8px; margin-top:8px; margin-bottom:8px; align-items:center;">
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
                        <!-- 4.0.20 P1：申请入口（槽位折叠表单，保持原 DOM id 与事件绑定不变） -->
                        <div id="apply-section" class="panel-section">
                            <div class="section-label">申请</div>
                            <div id="slot-apply-section" style="font-size:12px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
                                <a id="slot-apply-link" style="color:var(--link); cursor:pointer; text-decoration:underline;">申请增加槽位</a>
                                <span id="slot-apply-pending" style="display:none; color:var(--warn);">槽位申请审核中</span>
                            </div>
                            <div id="slot-apply-form" style="display:none; margin-top:6px;">
                                <input id="slot-apply-count" type="number" min="1" max="10" placeholder="申请增加几个槽位（1~10）" style="margin-bottom:4px;">
                                <textarea id="slot-apply-reason" placeholder="理由（必填）" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:var(--radius); background:var(--input-bg); color:var(--text); font-size:12px; padding:5px 6px; margin-bottom:4px; resize:vertical;"></textarea>
                                <div style="display:flex; gap:8px;">
                                    <button id="slot-apply-submit" class="btn-primary" style="flex:1; padding:6px;">提交申请</button>
                                    <button id="slot-apply-cancel" style="flex:1; padding:6px; background:var(--bg-muted); color:var(--text-secondary);">取消</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <button id="manual-btn" class="btn-primary" style="display:none; width:100%; margin-top:8px; padding:8px; animation: blink 1s infinite;">点击开始播放</button>
                </div>
            </div>
        `;
        document.body.appendChild(container);
        renderSongSlotsUI();
        GM_addStyle(`
            #music-helper-container {
                --brand:#c20c0c; --brand-hover:#9b0a0a; --ok:#14804a; --bad:#d93025; --warn:#9a6700;
                --disabled:#999999; --panel:#ffffff; --line:#e3e8ef; --text:#333333;
                --text-secondary:#666666; --text-muted:#999999; --link:#1890ff; --bg-muted:#f5f6f8; --bg-soft:#f7f8fa;
                --ok-bg:#e8f5ee; --ok-line:#bfe5cf; --warn-bg:#fff7e6; --warn-line:#ffd591; --input-bg:#ffffff;
                --radius:6px; --radius-lg:10px;
                position: fixed; top: 100px; right: 20px; z-index: 1000000;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                font-size: 12px; user-select: none;
            }
            /* 4.0.20 P1：暗色适配 —— 整套变量翻转（面板/文字/边框/输入底/警告与成功浅色底） */
            @media (prefers-color-scheme: dark) {
                #music-helper-container {
                    --panel:#1e1e1e; --line:#3a3a3a; --text:#e5e5e5; --text-secondary:#b8b8b8; --text-muted:#8f8f8f;
                    --bg-muted:#262626; --bg-soft:#232323; --link:#4da3ff; --ok:#3fae6e; --bad:#e05252; --warn:#d9a04b;
                    --ok-bg:#122a1c; --ok-line:#245636; --warn-bg:#2b2110; --warn-line:#5c4a1c; --input-bg:#2a2a2a;
                }
            }
            #music-helper-panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: 0 8px 24px rgba(0,0,0,0.2); width: 220px; overflow: hidden; }
            #helper-header { background: var(--bg-muted); padding: 10px; display: flex; justify-content: space-between; align-items: center; cursor: move; }
            #helper-body { padding: 12px; }
            /* 4.0.20 P1：三区分层（状态/统计/操作/申请）分隔线 + 分区小标题 */
            #music-helper-container .panel-section { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 8px; }
            #music-helper-container .panel-section-first { border-top: none; margin-top: 0; padding-top: 0; }
            #music-helper-container .section-label { font-size: 11px; color: var(--text-muted); margin-bottom: 6px; letter-spacing: 0.5px; }
            #helper-toggle-btn { width: 44px; height: 44px; background: var(--brand); color: #fff; border-radius: 50%; display: none; align-items: center; justify-content: center; cursor: move; font-size: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
            #music-helper-container button { font-size: 12px; border: none; border-radius: var(--radius); cursor: pointer; transition: filter .15s ease, opacity .15s ease; }
            #music-helper-container button:hover { filter: brightness(0.92); }
            #music-helper-container button:active { filter: brightness(0.85); }
            #music-helper-container button:disabled { opacity: .6; cursor: not-allowed; }
            #music-helper-container .btn-primary { background: var(--brand); color: #fff; }
            #music-helper-container input[type="text"], #music-helper-container select, #music-helper-container textarea {
                width: 100%; box-sizing: border-box; border: 1px solid var(--line); border-radius: var(--radius);
                background: var(--input-bg); color: var(--text); font-size: 12px; padding: 5px 6px;
            }
            #music-helper-container input[type="text"]:focus, #music-helper-container select:focus, #music-helper-container textarea:focus { outline: none; border-color: var(--brand); }
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
        // —— 静音开关：经 bridge.js（ISOLATED world）转发给 background ——
        const muteLink = document.getElementById('mute-toggle-link');
        const renderMuteState = (enabled) => {
            muteLink.textContent = enabled ? '静音:开' : '静音:关';
            muteLink.style.color = enabled ? 'var(--link)' : '#e6a23c';
        };
        muteLink.onclick = () => {
            window.postMessage({ __mhBridge: true, type: 'mh-toggle-mute' }, '*');
        };
        window.addEventListener('message', (ev) => {
            if (!ev.data || ev.data.__mhBridge !== true || ev.data.type !== 'mh-mute-state') return;
            renderMuteState(!!ev.data.enabled);
        });
        window.postMessage({ __mhBridge: true, type: 'mh-get-mute-state' }, '*');
        document.getElementById('logout-link').onclick = async () => {
            await requestAPI('POST', '/auth/logout');
            releaseTabLock();
            clearStoredToken('');
            location.reload();
        };
        document.getElementById('toggle-helper').onclick = toggleHelper;
        document.getElementById('save-songs').onclick = saveSongs;
        // 4.0.20 N2：折叠摘要 ⇄ 展开编辑切换（状态持久化到 songSlotsCollapsed）
        document.getElementById('slot-expand-btn').onclick = () => {
            const collapsed = GM_getValue('songSlotsCollapsed', '1') !== '1';
            GM_setValue('songSlotsCollapsed', collapsed ? '1' : '0');
            renderSongSlotsUI();
        };
        // 4.0.20 N2：展开态底部「新增槽」——把新 ID 填入第一个空槽位（不改变槽位输入框语义）
        document.getElementById('slot-add-btn').onclick = () => {
            const input = document.getElementById('new-slot-input');
            const raw = String(input ? input.value || '' : '').trim();
            if (input) input.value = '';
            if (!raw) return;
            const ids = parseSaveSongs(raw);
            if (ids === null || ids.length !== 1) {
                showHelperInfo('请输入单个歌曲 ID（song:数字 或纯数字）。', 'warn');
                return;
            }
            for (let i = 1; i <= songSlotLimit; i += 1) {
                const el = document.getElementById('my-music-slot-' + i);
                if (el && !String(el.value || '').trim()) {
                    el.value = ids[0];
                    renderSongSlots();
                    return;
                }
            }
            showHelperInfo('槽位已满（最多 ' + songSlotLimit + ' 个），请先删除或保存。', 'warn');
        };
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
        var vt = await ensureVipType();
        return new Promise(r => GM_xmlhttpRequest({
            method:'GET',
            url:`${API_BASE}/auth-config`,
            headers:{'X-Music-Helper-Version': CURRENT_VERSION, 'X-Client-Type': 'extension', 'X-Vip-Type': String(vt)},
            onload:res=>{
                const d = safeJSON(res.responseText);
                renderAnnouncement(d && d.announcement);
                if(d && d.latestVersion && compareVersions(d.latestVersion, CURRENT_VERSION) > 0) {
                    const up = document.createElement('div');
                    up.innerHTML = `<div style="background:var(--warn-bg); border:1px solid var(--warn-line); padding:8px; border-radius:var(--radius); margin-bottom:8px; font-size:12px; color:var(--warn);">发现新版本 v${d.latestVersion}</div>`;
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
        box.style.cssText = 'white-space:pre-line;background:var(--warn-bg);border:1px solid var(--warn-line);padding:8px;border-radius:var(--radius);margin-bottom:8px;font-size:12px;color:var(--warn);line-height:1.5;';
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

    /* —— 网易云账号登录态读取（大小号关联识别）——
     * 读取链路（按可靠性降序，页面上下文可直接读 cookie/localStorage）：
     *   1) 同源调网易云自身接口 /api/nuser/account/get（需登录态，credentials:'include'），
     *      返回 { account:{id:数字, vipType}, profile:{nickname} } —— 最权威的 id + 昵称来源；
     *   2) cookie MUSIC_U：URL 编码的数字串，decodeURIComponent 后即网易云数字用户 ID（兜底 id）；
     *   3) localStorage 候选 key：netease_user_id / neteaseUserId / uid / MUSIC_U（兜底 id）。
     *   昵称拿不到时允许留空（只收集 netease_id，netease_name 空串）。
     */
    let neteaseIdentityCache = null;
    function readNeteaseIdFromCookieOrStorage() {
        try {
            const cookies = String(document.cookie || '').split(';');
            for (let i = 0; i < cookies.length; i++) {
                const parts = cookies[i].split('=');
                if (parts.length < 2) continue;
                const key = parts[0].trim();
                if (key === 'MUSIC_U') {
                    const raw = parts.slice(1).join('=').trim();
                    if (raw) {
                        const decoded = decodeURIComponent(raw);
                        if (/^\d{1,32}$/.test(decoded)) return decoded;
                    }
                }
            }
        } catch (e) {}
        try {
            const candidates = ['netease_user_id', 'neteaseUserId', 'uid', 'MUSIC_U'];
            for (let i = 0; i < candidates.length; i++) {
                const v = localStorage.getItem(candidates[i]);
                if (v && /^\d{1,32}$/.test(String(v).trim())) return String(v).trim();
            }
        } catch (e) {}
        return '';
    }
    function getNeteaseIdentity() {
        if (neteaseIdentityCache !== null) return Promise.resolve(neteaseIdentityCache);
        return fetch('/api/nuser/account/get', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                let id = '';
                let name = '';
                if (d && d.account && d.account.id != null) id = String(d.account.id);
                if (!/^\d{1,32}$/.test(id)) id = '';
                if (d && d.profile && typeof d.profile.nickname === 'string') name = d.profile.nickname;
                if (!id) id = readNeteaseIdFromCookieOrStorage();
                neteaseIdentityCache = { id: id || '', name: name || '' };
                return neteaseIdentityCache;
            })
            .catch(function () {
                neteaseIdentityCache = { id: readNeteaseIdFromCookieOrStorage(), name: '' };
                return neteaseIdentityCache;
            });
    }

    /* —— HMAC 签名防重放（V4.0.14）——
     * 签名密钥 = 会话 access token（raw token，与 Authorization: Bearer 一致）；
     * 签名消息 = METHOD + "\n" + path(含 query) + "\n" + timestamp + "\n" + nonce + "\n" + body；
     * 算法 = HMAC-SHA256，输出小写 hex；通过 X-Timestamp/X-Nonce/X-Signature 三个请求头发送。
     * 与服务端 hmac.go 的 verifyRequestSignature 严格对称。
     */
    function generateNonce() {
        const bytes = new Uint8Array(16);
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            window.crypto.getRandomValues(bytes);
            let out = '';
            for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
            return out;
        }
        let out = '';
        for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
        return out;
    }

    // 计算签名三件套；无法计算（无 crypto.subtle / 无 token / 异常）时返回 {}（降级不签名）。
    async function buildSignHeaders(method, fullUrl, rawBody, token) {
        if (!CAN_SIGN || !token) return {};
        try {
            const u = new URL(fullUrl, window.location.href);
            const path = u.pathname + u.search; // path + query，与服务端 r.URL.RequestURI() 一致
            const timestamp = String(Math.floor(Date.now() / 1000));
            const nonce = generateNonce();
            const msg = [method, path, timestamp, nonce, rawBody || ''].join('\n');
            // client key（mh_ck_ 前缀）模式：HMAC 密钥 = sha256(凭证) 小写 hex（对齐 docker/signing.js）。
            let hmacKeyMaterial = token;
            if (typeof token === 'string' && token.indexOf('mh_ck_') === 0) {
                const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
                const bytes = new Uint8Array(digest);
                let hashHex = '';
                for (let i = 0; i < bytes.length; i++) hashHex += bytes[i].toString(16).padStart(2, '0');
                hmacKeyMaterial = hashHex;
            }
            const key = await crypto.subtle.importKey(
                'raw',
                new TextEncoder().encode(hmacKeyMaterial),
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign'],
            );
            const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
            const sigBytes = new Uint8Array(sigBuf);
            let signature = '';
            for (let i = 0; i < sigBytes.length; i++) signature += sigBytes[i].toString(16).padStart(2, '0');
            return { 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature };
        } catch (e) {
            return {};
        }
    }

    async function requestAPI(method, path, body = null, token = GM_getValue(TOKEN_KEY, '')) {
        const rawBody = body ? JSON.stringify(body) : '';
        const url = `${API_BASE}${path}`;
        var vt = await ensureVipType();
        const headers = { 'Authorization':`Bearer ${token}`,'Content-Type':'application/json' };
        const signHeaders = await buildSignHeaders(method, url, rawBody, token);
        // 关键：版本号必须与「是否实际带上了签名」一致 —— 能签名才宣告 4.0.14，
        // 否则回退旧版本号走服务端旧版路径（跳过签名校验），避免 403。
        headers['X-Music-Helper-Version'] = signHeaders['X-Signature'] ? SIGN_VERSION : LEGACY_VERSION;
        headers['X-Client-Type'] = 'extension';
        headers['X-Vip-Type'] = String(vt);
        Object.assign(headers, signHeaders);
        return new Promise(r => GM_xmlhttpRequest({
            method, url, headers,
            data: rawBody !== '' ? rawBody : null,
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
            // 刷新凭证已过期（永久失效）：给用户可见提示（走 handleAccessError），不再裸 reload。
            handleAccessError('invalid_or_expired_token');
            return false;
        }
        if (!force && !tokenNeedsRefresh()) return true;
        if (refreshPromise) return refreshPromise;

        refreshPromise = (async () => {
            // 网络类错误（status:0 / 5xx）做有限次指数退避重试且不清登录态；
            // 仅明确 401（凭证永久失效）或 403（封禁/无权限）才走 handleAccessError 并清态。
            const maxAttempts = 3;
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
                if (result.status === 401) {
                    // 刷新令牌已失效/被吊销：永久失效。
                    handleAccessError(
                        result.payload && result.payload.error ? result.payload.error : 'invalid_or_expired_token',
                        result.payload && result.payload.message ? result.payload.message : '',
                    );
                    return false;
                }
                // status:0（网络错误）/ 5xx（服务端临时故障）：保留旧凭证，退避后重试。
                if (attempt < maxAttempts) {
                    await wait(1000 * Math.pow(2, attempt - 1)); // 1s, 2s
                }
            }
            // 连续网络/5xx 失败：不清登录态，保留旧凭证，交由下次调用重试。
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
        var vt = await ensureVipType();
        return new Promise(r => GM_xmlhttpRequest({
            method:'POST',
            url:`${API_BASE}/auth/claim`,
            headers:{'Content-Type':'application/json','X-Music-Helper-Version': CURRENT_VERSION, 'X-Client-Type': 'extension', 'X-Vip-Type': String(vt)},
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
            // 4.0.20 N2/N1：/api/me musics 为歌名/时长权威源（零请求），存 map 供折叠摘要即时渲染；
            // 同时计算槽位歌曲最长时长（N1 每日预计消耗口径，仅计入 durationMs>0 的歌曲）。
            // 必须先于 updateParticipantInfo 执行，保证每日消耗常驻行首帧即用上新数据。
            if (Array.isArray(d.musics)) {
                songMetaMap = {};
                let maxMs = 0;
                d.musics.forEach(function (m) {
                    if (!m || !m.musicId) return;
                    const bare = String(m.musicId).replace(/^song:/, '');
                    const dur = Number(m.durationMs || 0);
                    const entry = { name: String(m.name || ''), durationMs: dur > 0 ? dur : 0 };
                    songMetaMap['song:' + bare] = entry;
                    songMetaMap[bare] = entry;
                    if (dur > 0 && dur > maxMs) maxMs = dur;
                });
                currentMaxSongDurationMs = maxMs;
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
                savedSongsPendingReview = true;
                const infoEl = document.getElementById('helper-info');
                if (infoEl && !isHelperRunning) {
                    infoEl.style.display = 'block';
                    infoEl.innerText = '歌曲修改待管理员审核，通过后生效。';
                    setHelperInfoStyle('warn');
                }
            } else if (songsRes && songsRes.songs != null && String(songsRes.songs).trim()) {
                savedSongsPendingReview = false;
                setSongSlots(String(songsRes.songs));
                GM_setValue('myMusicList', String(songsRes.songs));
            } else if (Array.isArray(d.musics) && d.musics.length > 0 && !(GM_getValue('myMusicList', '') || '').trim()) {
                savedSongsPendingReview = false;
                const lines = d.musics.map(function (m) { return m.musicId || ''; }).filter(Boolean);
                if (lines.length > 0) {
                    setSongSlots(lines.join('\n'));
                    GM_setValue('myMusicList', lines.join('\n'));
                }
            }
            // 4.0.20 N2：同步后刷新折叠摘要（歌名/时长/状态徽标随权威数据变化）
            renderSongSlotsSummary();
            return;
        }
        // 登录态获取失败（网络异常等），且无其他错误提示覆盖时：可点击重试
        if (loginStatus && !d && loginStatus.innerText === '检测登录状态...') {
            loginStatus.innerText = '登录状态获取失败，点击重试';
            loginStatus.style.cursor = 'pointer';
            loginStatus.style.color = 'var(--bad)';
            loginStatus.onclick = function () {
                loginStatus.innerText = '检测登录状态...';
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
        // 4.0.20 N1：每日被助上限生效值存模块变量（缺失不动旧值，初始兜底 30）
        if (participant.today_received_limit != null) currentTodayReceivedLimit = Number(participant.today_received_limit);
        const todayReceived = Number(participant.received_finished_count_24h != null ? participant.received_finished_count_24h : participant.today_received_help_count || 0);
        const todayReceivedLimit = Number(participant.today_received_limit || 0);
        const todayHelped = Number(participant.today_helped_count || 0);
        const monthlyReceived = Number(participant.monthly_received_help_count || 0);
        const monthlyLimit = Number(participant.monthly_received_limit || 0);
        const helpSecondsLimit = Number(participant.help_seconds_limit != null ? participant.help_seconds_limit : NaN);
        const helpSecondsUsed = Number(participant.help_seconds_used != null ? participant.help_seconds_used : NaN);
        const helpSecondsRemain = Number(participant.remaining_help_seconds != null ? participant.remaining_help_seconds : NaN);
        const monthlyCapReached = !!participant.monthly_cap_reached;
        const lines = [];
        if (todayReceivedLimit > 0) lines.push(`今日被助: ${todayReceived} / ${todayReceivedLimit}`);
        // v5 秒闸：帮听次数已无上限，改按秒展示；help_seconds_* 缺失时降级为「帮听额度（秒）」
        if (Number.isFinite(helpSecondsLimit) && helpSecondsLimit > 0) {
            const used = Number.isFinite(helpSecondsUsed)
                ? helpSecondsUsed
                : (Number.isFinite(helpSecondsRemain) ? Math.max(0, helpSecondsLimit - helpSecondsRemain) : 0);
            let helpedText = helpSecondsLimit >= 60
                ? `今日帮听 ${Math.floor(used / 60)} 分钟 / 上限 ${Math.floor(helpSecondsLimit / 60)} 分钟`
                : `今日帮听秒 ${used} / ${helpSecondsLimit}`;
            if (Number.isFinite(helpSecondsRemain)) helpedText += `（剩余 ${helpSecondsRemain} 秒）`;
            lines.push(helpedText);
        } else {
            lines.push(`帮听额度（秒）: ${todayHelped}`);
        }
        if (monthlyLimit > 0 || monthlyCapReached) lines.push(`近 30 天（滚动）被助: ${monthlyReceived} / ${monthlyLimit}`);
        lines.push(`可用额度: ${credits}`);
        // 数据区常驻可见，运行时也不被「正在互助」文本覆盖
        if (statsEl) {
            statsEl.style.display = 'block';
            statsEl.innerText = lines.join('\n');
        }
        // 4.0.20 N1：每日预计消耗常驻行（统计区，弱化背景；无歌/无上限/全 0 时隐藏）
        renderDailyConsumptionLine();
    }

    // 4.0.20 N1：每日预计消耗 ≈ floor(最长歌秒) × 每日被助上限（today_received_limit 生效值，缺失兜底 30）。
    // 积分=秒（与服务端 credit_cost 同构）；无歌/时长全 0/上限为 0 → 整行隐藏；字段缺失不报错。
    function renderDailyConsumptionLine() {
        const lineEl = document.getElementById('daily-consume-line');
        if (!lineEl) return;
        const maxMs = currentMaxSongDurationMs;
        const dailyCount = currentTodayReceivedLimit;
        if (!(maxMs > 0) || !(dailyCount > 0)) {
            lineEl.style.display = 'none';
            lineEl.textContent = '';
            return;
        }
        const estimated = Math.floor(maxMs / 1000) * dailyCount;
        let text = `每日预计消耗 ≈ ${estimated} 积分/天（最长歌 ${formatCompactMs(maxMs)} × 每日 ${dailyCount} 次）`;
        if (currentParticipantCredits !== null && Number.isFinite(Number(currentParticipantCredits))) {
            text += ` · 剩余 ${Number(currentParticipantCredits)} 积分`;
        }
        lineEl.style.display = 'block';
        lineEl.textContent = text;
    }

    // helper-info 状态色分层：空闲/正常=中性，运行中=绿色，保存成功=绿色，错误/待审核=黄色。只改颜色不改文字。
    // 4.0.20 P1：颜色全部走 CSS 变量（含暗色翻转），并同步状态灯 #status-dot 颜色。
    function setHelperInfoStyle(kind) {
        const infoEl = document.getElementById('helper-info');
        if (infoEl) {
            if (kind === 'running' || kind === 'success') {
                infoEl.style.background = 'var(--ok-bg)';
                infoEl.style.borderColor = 'var(--ok-line)';
                infoEl.style.color = 'var(--ok)';
            } else if (kind === 'warn') {
                infoEl.style.background = 'var(--warn-bg)';
                infoEl.style.borderColor = 'var(--warn-line)';
                infoEl.style.color = 'var(--warn)';
            } else {
                infoEl.style.background = 'var(--bg-soft)';
                infoEl.style.borderColor = 'var(--line)';
                infoEl.style.color = 'var(--text-secondary)';
            }
        }
        const dot = document.getElementById('status-dot');
        if (dot) {
            if (kind === 'running' || kind === 'success') {
                dot.style.background = 'var(--ok)';
                dot.style.boxShadow = '0 0 0 2px var(--ok-bg)';
            } else if (kind === 'warn') {
                dot.style.background = 'var(--warn)';
                dot.style.boxShadow = '0 0 0 2px var(--warn-bg)';
            } else {
                dot.style.background = 'var(--text-muted)';
                dot.style.boxShadow = '0 0 0 2px var(--bg-soft)';
            }
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
        if (reason === 'daily_limit') return '今日帮助已达上限，24 小时后自动恢复。';
        const participants = Number(summary.participants || 0);
        const notSelf = Number(summary.notSelf || 0);
        const active = Number(summary.active || 0);
        const withCredit = Number(summary.withAvailableCredit || 0);
        const underMonthly = Number(summary.underMonthlyLimit || 0);
        const underActiveJobs = Number(summary.underActiveJobLimit || 0);
        const notInCooldown = Number(summary.notInCooldown || 0);
        // 4.0.20 P2（K4）：reason=contended 且明细七项计数全 0 → 服务端未下发明细（统计口径缺失），
        // 输出简短兜底文案，不输出全 0 的误导明细行；其他 reason 行为保持不变。
        if (reason === 'contended' && participants === 0 && notSelf === 0 && active === 0
            && withCredit === 0 && underMonthly === 0 && underActiveJobs === 0 && notInCooldown === 0) {
            return '任务被抢，稍后再试，30s 后自动继续。';
        }
        const detail = `入队用户: ${participants}，非本人: ${notSelf}，正常: ${active}，有可用额度: ${withCredit}，未到近 30 天上限: ${underMonthly}，未超并发: ${underActiveJobs}，非冷却: ${notInCooldown}`;
        const reasonMap = {
            no_participants: '当前没人加入互助队列',
            only_self: '当前队列里只有你自己，不能给自己互助',
            no_active_participants: '队列里没有正常状态的其他用户',
            no_participant_with_credit: '其他入队用户都没有可用额度',
            all_monthly_limit_reached: '其他入队用户都已达到近 30 天（滚动）被互助上限',
            all_active_job_limited: '其他入队用户当前派发任务数已满',
            all_in_cooldown: '其他候选都处于同账号冷却期',
            no_eligible_participant: '当前没有满足条件的互助目标',
            helper_banned: '网络环境不稳定，暂停互助一个小时',
            helper_busy: '你已有一个进行中的任务，完成后才会接下一单。',
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
        // 保存按钮同时持久化「自动开启」勾选（此前只在点「开启互助」时才写入，勾选后点保存无反应）
        const autoStartEl = document.getElementById('auto-start');
        if (autoStartEl) GM_setValue('autoStart', autoStartEl.checked ? '1' : '0');
        // 4.0.20 顺带①：保存按钮一并持久化偏好（对齐 toggleHelper 行为，此前仅 toggleHelper 落盘）
        const preferenceEl = document.getElementById('my-preference');
        if (preferenceEl) GM_setValue('myPreference', preferenceEl.value);
        GM_setValue('myMusicList', savedText);
        setSongSlots(savedText);
        // 4.0.20 N2：记录歌曲审核态；保存成功后自动切换为折叠态（摘要展示，隐藏长 ID）
        savedSongsPendingReview = d.status === 'pending';
        GM_setValue('songSlotsCollapsed', '1');
        renderSongSlotsUI();
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
        HEAL.reset();
        isHelperRunning = false;
        activeJoinState = null;
        clearInterval(monitorTimer);
        monitorTimer = null;
        clearInterval(joinTimer);
        joinTimer = null;
        idleCleanupPlaybackBestEffort().catch(() => {});
        const toggleButton = document.getElementById('toggle-helper');
        const helperInfo = document.getElementById('helper-info');
        if (toggleButton) {
            toggleButton.innerText = '开启互助';
            toggleButton.style.background = 'var(--brand)';
            toggleButton.disabled = false;
        }
        if (helperInfo) {
            helperInfo.innerText = '已停止本机挂机；已保存歌曲仍在被助队列。';
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

    // ===== 多级自愈（v4.0.20）：网络/API 失败自动重试 → 自动刷新页面 → 停止 =====
    // 目标：挂机期间遇到瞬时网络抖动/服务端临时错误/连续播放失败时自动恢复；
    // 刷新有次数上限与最小间隔防抖，多次仍失败则停止并给出明确文案，不无限循环。
    const HEAL = {
        NET_RETRY_DELAY_MS: 30000,        // 网络/API 失败重试间隔
        MAX_NET_FAIL_BEFORE_REFRESH: 3,   // 连续失败触发页面刷新阈值
        MAX_CONSECUTIVE_ABANDON: 5,       // 连续放弃（播放失败）触发页面刷新阈值
        REFRESH_MIN_INTERVAL_MS: 120000,  // 两次刷新最小间隔（防抖）
        MAX_REFRESH_PER_SEQUENCE: 2,      // 单次故障序列刷新上限
        WINDOW_POLL_MS: 60000,            // docker 活跃窗口外轮询间隔
        netFail: 0,                       // 连续网络/API 失败计数
        abandonStreak: 0,                 // 连续放弃计数
        refreshCount: 0,                  // 本序列已刷新次数
        lastRefreshAt: 0,                 // 上次刷新时间戳（防抖）
        reset() {
            HEAL.netFail = 0;
            HEAL.abandonStreak = 0;
            HEAL.refreshCount = 0;
            HEAL.lastRefreshAt = 0;
        },
        clearFail() {
            if (HEAL.netFail || HEAL.abandonStreak || HEAL.refreshCount) {
                HEAL.netFail = 0;
                HEAL.abandonStreak = 0;
                HEAL.refreshCount = 0;
                HEAL.lastRefreshAt = 0;
            }
        }
    };

    function scheduleHeal(kind) {
        if (!isHelperRunning) return;
        if (kind === 'window_wait') {
            // docker 活跃窗口外：等待窗口开启，轮询不停止、不刷新
            setTimeout(playNext, HEAL.WINDOW_POLL_MS);
            return;
        }
        // net_fail / api_err：累计失败次数，达到阈值升级为页面刷新
        HEAL.netFail += 1;
        if (HEAL.netFail >= HEAL.MAX_NET_FAIL_BEFORE_REFRESH) {
            performPageReload('网络/服务持续异常');
        } else {
            setTimeout(playNext, HEAL.NET_RETRY_DELAY_MS);
        }
    }

    function performPageReload(reason) {
        const now = Date.now();
        if (now - HEAL.lastRefreshAt < HEAL.REFRESH_MIN_INTERVAL_MS) {
            // 距上次刷新太近（防抖）：继续重试而不是再刷新
            setTimeout(playNext, HEAL.NET_RETRY_DELAY_MS);
            return;
        }
        if (HEAL.refreshCount >= HEAL.MAX_REFRESH_PER_SEQUENCE) {
            // 刷新已达上限：停止循环，给出明确文案，不无限循环
            try { stopHelper(); } catch (e) {}
            const el = document.getElementById('helper-info');
            if (el) el.innerText = '多次尝试后仍无法恢复，已自动停止；请检查网络/账号后手动开启';
            return;
        }
        HEAL.refreshCount += 1;
        HEAL.lastRefreshAt = now;
        // 保证刷新后自动重启：强制写 autoStart=1（三端各自存储封装）
        try { GM_setValue('autoStart', '1'); } catch (e) {}
        const el = document.getElementById('helper-info');
        if (el) el.innerText = `${reason}，正在自动刷新页面重试...（${HEAL.refreshCount}/${HEAL.MAX_REFRESH_PER_SEQUENCE}）`;
        setTimeout(() => { try { location.reload(); } catch (e) {} }, 500);
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
            infoEl.innerText = '服务器连接失败，30 秒后自动重试...';
            return scheduleHeal('net_fail');
        }
        if (isApiErrorPayload(data)) {
            await idleCleanupPlaybackBestEffort();
            if (isServicePauseError(data.error)) {
                return; // 停服类：保持现状（由停服处理流程负责），不自动重试
            }
            if (data.error === 'outside_active_window') {
                infoEl.innerText = '当前不在活跃窗口内，1 分钟后自动重试...';
                return scheduleHeal('window_wait');
            }
            infoEl.innerText = getPayloadErrorText(data, 'next_failed') + '，30 秒后自动重试...';
            return scheduleHeal('api_err');
        }
        HEAL.clearFail();
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
            let ticking = false; // monitorTick 重入保护：上一 tick 仍在 await（complete/recover/abandon）时跳过
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
                    // 连续放弃计数：达到阈值升级为自动刷新页面（重新解析歌曲后重来）
                    HEAL.abandonStreak += 1;
                    if (HEAL.abandonStreak >= HEAL.MAX_CONSECUTIVE_ABANDON) {
                        infoEl.innerText = '连续多次播放失败，正在自动刷新页面重试...';
                        performPageReload('连续多次播放失败');
                        return;
                    }
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
                if (isHelperRunning) monitorTimer = setInterval(monitorTick, 1000);
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
                    // 4.0.20 顺带②：可用额度优先取 available_credits（与 updateParticipantInfo 口径一致），缺失兜底 credits
                    const credits = result.participant
                        ? Number(result.participant.available_credits != null ? result.participant.available_credits : result.participant.credits || 0)
                        : null;
                    const credited = result.credited !== false;
                    const earnedCredits = Number(result.creditCost || creditCost || 0);
                    if (result.participant) updateParticipantInfo(result.participant);
                    infoEl.style.display = 'block';
                    infoEl.innerText = credited
                        ? `助力成功\n本次获得额度: ${earnedCredits}${credits === null ? '' : `\n当前可用额度: ${credits}`}`
                        : `任务已提交过\n本次未重复增加额度${credits === null ? '' : `\n当前可用额度: ${credits}`}`;
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
                if (ticking) return; // 重入保护：上一 tick 仍在 await 中（complete/recover/abandon 最长 ~15s）
                ticking = true;
                try {
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
                    getNeteaseIdentity().then(function (ident) {
                        requestAPI('POST', '/play/heartbeat', { jobId: jobId, positionMs: Math.floor(cur), neteaseId: ident.id, neteaseName: ident.name });
                    });
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
                    const currentCreditsLine = currentParticipantCredits === null ? '' : `\n当前可用额度: ${currentParticipantCredits}`;
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
                } finally {
                    ticking = false;
                }
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

    /* —— 播放趋势自动上传（音乐人后台播放趋势 → 平台每日上报）——
     * 趋势接口（纯 Cookie MUSIC_U 即可，无 csrf/风控）：
     *   GET https://music.163.com/api/creator/musician/play/count/statistic/data/trend/get?startTime=YYYY-MM-DD&endTime=YYYY-MM-DD
     * 返回 {code:200, data:[{dateTime:"YYYY-MM-DD", dataValue:"10"},...]}，dataValue 为字符串数字。
     * 音乐人账号才有数据；普通账号 code!=200 或 data 为空 → 静默放弃（不提示、不重试风暴）。
     * 注意：日期用浏览器本地时区；上报 date 透传网易云 dateTime，后端按服务器时区校验。
     */
    const AUTO_PLAY_SYNC_DATE_KEY = 'mh_auto_play_sync_date';
    const AUTO_PLAY_SYNC_MAX_ATTEMPTS = 4; // 页内指数退避重试上限（30s/60s/120s/240s）
    let autoPlaySyncAttempts = 0;
    function localDateStr(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }
    function scheduleAutoPlaySyncRetry() {
        if (autoPlaySyncAttempts >= AUTO_PLAY_SYNC_MAX_ATTEMPTS) return;
        if (GM_getValue(AUTO_PLAY_SYNC_DATE_KEY, '') === localDateStr(new Date())) return; // 当天已成功，不再重试
        const delay = 30000 * Math.pow(2, autoPlaySyncAttempts);
        autoPlaySyncAttempts += 1;
        setTimeout(syncPlayTrendAuto, delay);
    }
    async function syncPlayTrendAuto() {
        try {
            // 未登录平台（无 Bearer token）→ 无法上报，静默返回。
            if (!GM_getValue(TOKEN_KEY, '')) return;
            const today = localDateStr(new Date());
            // 同一天只跑一次；失败走页内指数退避重试，再失败次日页面加载兜底。
            if (GM_getValue(AUTO_PLAY_SYNC_DATE_KEY, '') === today) return;
            const start = localDateStr(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
            const url = '/api/creator/musician/play/count/statistic/data/trend/get?startTime=' + start + '&endTime=' + today;
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) { scheduleAutoPlaySyncRetry(); return; }
            const payload = await res.json();
            if (!payload || payload.code !== 200 || !Array.isArray(payload.data) || payload.data.length === 0) return;
            // P1 修：上报前先确保 token 新鲜；刷新失败（网络/凭证/未取得 tab 锁）即放弃本次同步，
            // 避免逐天 callAPI 串行触发刷新风暴（refreshPromise 只去重并发不去重串行），由 P3 退避重试兜底。
            if (!await ensureFreshToken()) return;
            let reported = 0;
            for (let i = 0; i < payload.data.length; i++) {
                const item = payload.data[i];
                if (!item) continue;
                const dateStr = item.dateTime ? String(item.dateTime).slice(0, 10) : '';
                const rawVal = item.dataValue;
                if (!dateStr || rawVal === null || rawVal === undefined || rawVal === '') continue;
                const playCount = Number(rawVal);
                if (!Number.isFinite(playCount) || playCount < 0) continue;
                // P1：/play-report 改走 callAPI（带 401→refresh→重试），对齐手动路径。
                const d = await callAPI('POST', '/play-report', { date: dateStr, playCount: playCount, note: '自动同步' });
                if (d && d.ok) reported += 1;
            }
            // 至少成功上报一天才写日期；全失败则页内退避重试（下次页面加载兜底）。
            if (reported > 0) {
                GM_setValue(AUTO_PLAY_SYNC_DATE_KEY, today);
            } else {
                scheduleAutoPlaySyncRetry();
            }
            console.debug('[music-help] play trend auto sync: reported=' + reported + '/' + payload.data.length);
        } catch (e) {
            console.debug('[music-help] play trend auto sync skipped:', e && e.message);
            scheduleAutoPlaySyncRetry();
        }
    }

    // 页面加载后延迟 5 秒静默同步（避开心跳等首屏逻辑）。
    setTimeout(syncPlayTrendAuto, 5000);

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
