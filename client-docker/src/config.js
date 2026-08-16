'use strict';

/**
 * config.js —— 运行时配置与常量。
 *
 * 所有可调配置集中在环境变量；密码缺失 / 非法活跃窗口由 server.js 与 active-window.js 校验。
 */

const path = require('path');

// —— 客户端协议常量 ——
// 版本头统一报 4.0.17（>= 4.0.14 的服务端会强制校验 HMAC 签名三件套）。
const CLIENT_VERSION = '4.0.17';
// 活跃时间窗口最大跨度（小时），UI 与配置加载时双重校验。
const MAX_ACTIVE_SPAN_HOURS = 16;
// 客户端 key 前缀：以 mh_ck_ 开头视为 portal 粘贴的 client key（不换 token）。
const CLIENT_KEY_PREFIX = 'mh_ck_';

const DEFAULTS = {
  // 互助平台 API 基址（环境变量 API_BASE 可覆盖，便于联调）。
  API_BASE: 'https://163music.linyu.qzz.io/api',
  // 管理 UI 监听地址 / 端口。
  UI_BIND: '0.0.0.0',
  UI_PORT: 3000,
  // 数据目录（Docker 内挂载为 /data volume）。
  DATA_DIR: '/data',
  // 网易云音乐首页（浏览器加载目标）。
  MUSIC_HOME: 'https://music.163.com',
  // 时区（默认 Asia/Shanghai，影响活跃窗口的本地时间判断）。
  TZ: 'Asia/Shanghai',
  // 活跃时间窗口默认值（HH:mm，start 未配置即视为「全天」= 永不拦截）。
  ACTIVE_START: '',
  ACTIVE_END: '',
  // 领取任务偏好（short | long | random）。
  PREFERENCE: 'random',
  // 登录接口限速：1 分钟最多 5 次尝试。
  LOGIN_RATE_LIMIT: 5,
  LOGIN_RATE_WINDOW_MS: 60 * 1000,
  // 会话 cookie 有效期（毫秒）。
  SESSION_TTL_MS: 24 * 60 * 60 * 1000,
  // 浏览器页面内的循环与心跳间隔（毫秒）。
  PLAYER_LOOP_INTERVAL_MS: 1000,
  // 状态快照拉取间隔（UI 展示 /api/me、/api/ledger）。
  STATUS_REFRESH_MS: 30 * 1000,
  // Playwright 启动参数（固定，含 headless=new、no-sandbox、mute-audio 等）。
  CHROMIUM_ARGS: [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--js-flags=--max-old-space-size=256',
  ],
};

function parsePort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

const config = {
  version: CLIENT_VERSION,
  maxActiveSpanHours: MAX_ACTIVE_SPAN_HOURS,
  clientKeyPrefix: CLIENT_KEY_PREFIX,

  apiBase: (env('API_BASE', DEFAULTS.API_BASE) || '').replace(/\/+$/, ''),
  uiBind: env('UI_BIND', DEFAULTS.UI_BIND),
  uiPort: parsePort(env('UI_PORT', String(DEFAULTS.UI_PORT)), DEFAULTS.UI_PORT),
  dataDir: env('DATA_DIR', DEFAULTS.DATA_DIR),
  musicHome: env('MUSIC_HOME', DEFAULTS.MUSIC_HOME),
  tz: env('TZ', DEFAULTS.TZ),

  uiPassword: env('UI_PASSWORD', ''),
  hasPassword: !!process.env.UI_PASSWORD && String(process.env.UI_PASSWORD).length > 0,

  activeStart: env('ACTIVE_START', DEFAULTS.ACTIVE_START),
  activeEnd: env('ACTIVE_END', DEFAULTS.ACTIVE_END),
  preference: env('PREFERENCE', DEFAULTS.PREFERENCE),

  loginRateLimit: Number(env('LOGIN_RATE_LIMIT', String(DEFAULTS.LOGIN_RATE_LIMIT))) || DEFAULTS.LOGIN_RATE_LIMIT,
  loginRateWindowMs: DEFAULTS.LOGIN_RATE_WINDOW_MS,
  sessionTtlMs: DEFAULTS.SESSION_TTL_MS,
  playerLoopIntervalMs: DEFAULTS.PLAYER_LOOP_INTERVAL_MS,
  statusRefreshMs: DEFAULTS.STATUS_REFRESH_MS,
  chromiumArgs: DEFAULTS.CHROMIUM_ARGS,
};

// 数据目录下各持久化文件的绝对路径（挂载 /data volume）。
config.paths = {
  store: path.join(config.dataDir, 'store.json'),      // 通用 KV（GM_getValue / 凭证 / 偏好 / 窗口）
  cookies: path.join(config.dataDir, 'cookies.json'),  // 网易云 Cookie（MUSIC_U / __csrf）
  sessions: path.join(config.dataDir, 'sessions.json'),// UI 登录会话（内存外的持久备份，可选）
};

module.exports = config;
