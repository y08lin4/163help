/**
 * bridge.js —— MAIN world content.js 与扩展 background（MV3 service worker）之间的消息桥。
 *
 * 背景：content.js 以 world:"MAIN" 注入（页面上下文），拿不到 chrome.runtime；
 * 本脚本运行在默认的 ISOLATED world，负责把页面的 window.postMessage 转发为
 * chrome.runtime.sendMessage，并把 background 的回复回传页面。
 *
 * 协议（window.postMessage 数据均带 __mhBridge:true 标记）：
 *   页面 → bridge : { type:'mh-toggle-mute' }        切换网易云标签页静音开关
 *   页面 → bridge : { type:'mh-get-mute-state' }     查询当前开关
 *   bridge → 页面 : { type:'mh-mute-state', enabled } background 回复的开关状态
 */
(function () {
    'use strict';

    function forward(payload) {
        window.postMessage(Object.assign({ __mhBridge: true }, payload), '*');
    }

    function askBackground(type) {
        try {
            chrome.runtime.sendMessage({ type: type })
                .then(function (resp) {
                    if (resp && typeof resp.enabled === 'boolean') {
                        forward({ type: 'mh-mute-state', enabled: resp.enabled });
                    }
                })
                .catch(function () {
                    // background 未就绪（如扩展刚重载），忽略即可，页面默认显示「开」。
                });
        } catch (e) {
            // ignore
        }
    }

    window.addEventListener('message', function (ev) {
        if (!ev.data || ev.data.__mhBridge !== true) return;
        if (ev.data.type === 'mh-toggle-mute' || ev.data.type === 'mh-get-mute-state') {
            askBackground(ev.data.type);
        }
    });

    // 页面加载后主动推送一次当前开关状态，保证面板文案与实际一致。
    askBackground('mh-get-mute-state');
})();
