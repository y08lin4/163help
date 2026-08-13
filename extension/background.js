/**
 * 网易云音乐互助播放脚本 —— Chrome MV3 service worker
 *
 * 职责：
 *   1. 扩展安装（onInstalled）或浏览器启动（onStartup）时，
 *      打开一个静音的网易云音乐标签页（不固定 pinned）。
 *   2. 只要标签页的 URL 域名是 music.163.com，就将其静音；
 *      其它网站的标签页一律不碰。
 */

const MUSIC_URL = 'https://music.163.com/';

function isMusic163Url(url) {
    if (!url) return false;
    try {
        const u = new URL(url);
        return u.hostname === 'music.163.com' || u.hostname.endsWith('.music.163.com');
    } catch (e) {
        return false;
    }
}

function openMusicTab() {
    chrome.tabs.create({ url: MUSIC_URL }, function (tab) {
        if (chrome.runtime.lastError) return;
        muteMusicTab(tab.id);
    });
}

function muteMusicTab(tabId) {
    chrome.tabs.update(tabId, { muted: true }).catch(function () {
        // 标签可能已被关闭，忽略即可。
    });
}

chrome.runtime.onInstalled.addListener(() => {
    openMusicTab();
});

chrome.runtime.onStartup.addListener(() => {
    openMusicTab();
});

chrome.tabs.onCreated.addListener((tab) => {
    if (isMusic163Url(tab.pendingUrl || tab.url)) {
        muteMusicTab(tab.id);
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url !== undefined && isMusic163Url(tab.url)) {
        muteMusicTab(tabId);
    }
});
