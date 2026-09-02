/**
 * background service worker：
 * - 开机自启：创建（或聚焦）静音网易云标签
 * - 会话续期兜底：定期 ping /api/me 保持 token 新鲜（并触发 401→refresh 走 content 逻辑）
 * - 扩展版本升级提示（chrome.runtime.onInstalled）
 */
const BASE = 'https://163music.linyu.qzz.io';
const SHEET_URL = 'https://music.163.com/';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.storage.local.set({ mh_install_at: Date.now(), mh_version: '5.0.0' });
  }
});

/** 开机自启（开机/浏览器启动时打开静音标签） */
chrome.runtime.onStartup.addListener(() => { void ensureSheetTab(); });
const ensureSheetTab = async () => {
  const tabs = await chrome.tabs.query({ url: `${SHEET_URL}*` });
  if (tabs.length > 0) { void chrome.tabs.update(tabs[0].id, { active: true }); return; }
  const tab = await chrome.tabs.create({ url: SHEET_URL, muted: true });
  void chrome.tabs.update(tab.id, { active: true }).catch(() => {});
};

/** 静音网易云标签（不动其它标签） */
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url && tab.url.startsWith('https://music.163.com/')) void chrome.tabs.update(tab.id, { muted: true });
});

/** 周期保活：每 6 分钟 ping（SW 生命周期宽容下仍能触发） */
setInterval(() => { void ping().catch(() => {}); }, 6 * 60_000);
async function ping() {
  const token = (await chrome.storage.local.get('mh_token')).mh_token;
  if (!token) return;
  await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` }, method: 'GET' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'open-sheet') { void ensureSheetTab(); sendResponse({ ok: true }); }
  return false;
});
