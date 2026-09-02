/**
 * 网易云音乐互助播放脚本 —— Chrome MV3 service worker
 *
 * 职责：
 *   1. 扩展安装（onInstalled）或浏览器启动（onStartup）时，
 *      打开一个网易云音乐标签页（不固定 pinned）。
 *   2. 只要标签页的 URL 域名是 music.163.com，就将其静音；
 *      其它网站的标签页一律不碰。
 *   3. 静音开关（chrome.storage.local 'muteMusic163'，默认开）：
 *      页面互助面板的「静音」按钮经 bridge.js 转发 toggle 消息到这里切换；
 *      切换后立即对当前所有 music.163.com 标签页应用新状态。
 */

const MUSIC_URL = 'https://music.163.com/';
const MUTE_KEY = 'muteMusic163';

function isMusic163Url(url) {
    if (!url) return false;
    try {
        const u = new URL(url);
        return u.hostname === 'music.163.com' || u.hostname.endsWith('.music.163.com');
    } catch (e) {
        return false;
    }
}

/** 读取静音开关：未设置或值非 false 一律视为开（保持历史默认行为）。 */
function getMuteEnabled() {
    return new Promise(function (resolve) {
        chrome.storage.local.get(MUTE_KEY, function (data) {
            resolve(data[MUTE_KEY] !== false);
        });
    });
}

function setTabMuted(tabId, muted) {
    return chrome.tabs.update(tabId, { muted: muted }).catch(function () {
        // 标签可能已被关闭，忽略即可。
    });
}

/** 对当前所有 music.163.com 标签页统一应用静音/取消静音。 */
function applyMuteToMusicTabs(muted) {
    chrome.tabs.query({}, function (tabs) {
        tabs.forEach(function (tab) {
            if (isMusic163Url(tab.url)) setTabMuted(tab.id, muted);
        });
    });
}

function openMusicTab() {
    chrome.tabs.create({ url: MUSIC_URL }, function (tab) {
        if (chrome.runtime.lastError) return;
        getMuteEnabled().then(function (enabled) {
            if (enabled) setTabMuted(tab.id, true);
        });
    });
}

chrome.runtime.onInstalled.addListener(openMusicTab);
chrome.runtime.onStartup.addListener(openMusicTab);

chrome.tabs.onCreated.addListener(function (tab) {
    if (isMusic163Url(tab.pendingUrl || tab.url)) {
        getMuteEnabled().then(function (enabled) {
            if (enabled) setTabMuted(tab.id, true);
        });
    }
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.url !== undefined && isMusic163Url(tab.url)) {
        getMuteEnabled().then(function (enabled) {
            if (enabled) setTabMuted(tabId, true);
        });
    }
});

// 静音开关消息（由 bridge.js 转发）：get 查询 / toggle 切换。
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'mh-get-mute-state') {
        getMuteEnabled().then(function (enabled) {
            sendResponse({ enabled: enabled });
        });
        return true; // 异步响应，保持消息通道
    }
    if (msg.type === 'mh-toggle-mute') {
        getMuteEnabled().then(function (enabled) {
            const next = !enabled;
            chrome.storage.local.set({ [MUTE_KEY]: next }, function () {
                applyMuteToMusicTabs(next);
                sendResponse({ enabled: next });
            });
        });
        return true;
    }
});
