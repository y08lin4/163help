'use strict';

/**
 * main.js —— 客户端入口。
 *
 * 职责：
 *   - 读取 config / 环境变量（UI_PASSWORD、API_BASE、UI_BIND、TZ）；
 *   - 校验 UI_PASSWORD 必填（缺失 → 打印中文提示并 exit(1)）；
 *   - 启动 server.js（管理 UI HTTP 服务）；
 *   - require orchestrator.js 并调用 start()（该文件可能尚不存在，失败时降级只跑 UI）；
 *   - 进程级 uncaughtException / unhandledRejection 日志。
 */

const config = require('./config');
const { Store } = require('./store');

// —— UI_PASSWORD 必填校验 ——
if (!config.hasPassword || String(config.uiPassword).length === 0) {
  console.error('未设置 UI_PASSWORD，拒绝启动。用法：docker run -e UI_PASSWORD=xxx ...');
  process.exit(1);
}

// —— 日志环形缓冲区（供 server.js 尾部读取） ——
const MAX_LOG_LINES = 1000;
const logBuffer = [];
function appendLog(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}`;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  // 同时打到标准输出，便于 docker logs -f 查看。
  if (level === 'error') console.error(line);
  else console.log(line);
}

// 日志尾部读取接口（server.js 通过 init 注入）。
const log = {
  tail(limit) {
    const n = limit && limit > 0 ? limit : 100;
    return logBuffer.slice(-n);
  },
  push(level, message) {
    appendLog(level, message);
    return logBuffer.length;
  },
};

// —— store 实例（持久化到 config.paths.store） ——
const store = new Store(config.paths.store);

// —— server ——
const server = require('./server');
server.init({ store, log });

const app = server.createServer();
app.listen(config.uiPort, config.uiBind, () => {
  appendLog('info', `管理 UI 已启动：http://${config.uiBind}:${config.uiPort}`);
});

// —— orchestrator（可能由另一模块实现，缺失时降级只跑 UI） ——
let orchestrator = null;
try {
  orchestrator = require('./orchestrator');
} catch (e) {
  appendLog('warn', 'orchestrator 加载失败，仅运行管理 UI：' + e.message);
}

if (orchestrator && typeof orchestrator.start === 'function') {
  Promise.resolve(orchestrator.start({ store, log }))
    .catch((e) => {
      appendLog('error', 'orchestrator 启动失败：' + (e && e.message ? e.message : e));
    });
} else if (orchestrator) {
  appendLog('warn', 'orchestrator 未导出 start()，未启动');
}

// —— 进程级异常日志 ——
process.on('uncaughtException', (err) => {
  appendLog('error', 'uncaughtException：' + (err && err.stack ? err.stack : err));
});

process.on('unhandledRejection', (reason) => {
  appendLog('error', 'unhandledRejection：' + (reason && reason.stack ? reason.stack : reason));
});
