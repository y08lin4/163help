'use strict';

/**
 * store.js —— 持久化 KV 存储（挂载 /data volume 的 JSON 文件）。
 *
 * 职责：
 *   - 作为页内 GM_setValue / GM_getValue 的后端（核心逻辑的 KV 落到这里）；
 *   - 保存网易云 Cookie、凭证（session token 或 client key）、偏好、活跃窗口、账号锁定信息。
 *
 * 并发策略：单进程单 writer，写操作串行化（写队列 + 原子落盘），读操作直接读内存缓存。
 */

const fs = require('fs');
const path = require('path');

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    this._writeQueue = Promise.resolve();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.data = parsed;
        }
      }
    } catch (e) {
      // 损坏的 store 不致命：回退为空对象，后续写入会重建文件。
      this.data = {};
    }
  }

  get(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(this.data, key) && this.data[key] !== undefined) {
      return this.data[key];
    }
    return fallback === undefined ? null : fallback;
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.data, key);
  }

  set(key, value) {
    this.data[key] = value;
    return this._persist();
  }

  setMany(obj) {
    Object.assign(this.data, obj);
    return this._persist();
  }

  delete(key) {
    if (Object.prototype.hasOwnProperty.call(this.data, key)) {
      delete this.data[key];
      return this._persist();
    }
    return Promise.resolve();
  }

  all() {
    return Object.assign({}, this.data);
  }

  // 串行化落盘 + 临时文件 rename 原子替换，避免写一半损坏。
  _persist() {
    const doWrite = () => {
      const tmp = this.filePath + '.tmp';
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    };
    this._writeQueue = this._writeQueue.then(() => {
      try { doWrite(); } catch (e) { /* 忽略落盘失败，内存态继续可用 */ }
    });
    return this._writeQueue;
  }
}

module.exports = { Store };
