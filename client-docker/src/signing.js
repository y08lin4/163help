'use strict';

/**
 * signing.js —— Bearer + HMAC 签名（Node 侧通用，供 api-client.js 复用）。
 *
 * 与脚本核心逻辑的 buildSignHeaders 保持完全一致的算法：
 *   签名消息 = METHOD + "\n" + path(含 query) + "\n" + timestamp + "\n" + nonce + "\n" + body
 *   算法 = HMAC-SHA256，输出小写 hex。
 *
 * 关键差异（第 3 种客户端形态的适配）：
 *   - 凭证以 mh_ck_ 开头（portal 粘贴的 client key）时，HMAC 密钥 = sha256(凭证) 的小写 hex；
 *     服务端只存 key 的哈希，用哈希当验签密钥。
 *   - 否则（session token 模式）HMAC 密钥 = 凭证原文。
 *   - 版本头恒报 CLIENT_VERSION（4.0.18）。
 */

const crypto = require('crypto');
const config = require('./config');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/**
 * 计算 HMAC 签名密钥。
 * @param {string} credential Bearer 凭证（session token 或 client key）
 * @returns {string} HMAC 密钥字符串
 */
function hmacKeyForCredential(credential) {
  const cred = String(credential || '');
  if (cred.startsWith(config.clientKeyPrefix)) {
    return sha256Hex(cred); // key 模式：密钥 = sha256(key) 小写 hex
  }
  return cred; // token 模式：密钥 = 凭证原文
}

function generateNonce(len = 16) {
  return crypto.randomBytes(len).toString('hex');
}

function nowUnixSeconds() {
  return String(Math.floor(Date.now() / 1000));
}

/**
 * 构造签名请求头（含版本头）。
 * @param {string} method HTTP 方法（大写）
 * @param {string} fullUrl 完整 URL（含 query）
 * @param {string} rawBody 原始请求体字符串（GET/无 body 为空字符串）
 * @param {string} credential Bearer 凭证（可为 session token 或 client key；空则降级不签名）
 * @returns {{'X-Music-Helper-Version': string, 'X-Timestamp'?: string, 'X-Nonce'?: string, 'X-Signature'?: string}}
 */
function buildSignHeaders(method, fullUrl, rawBody, credential) {
  const cred = String(credential || '');
  const headers = {
    'X-Music-Helper-Version': config.version,
  };
  if (!cred) return headers;

  const u = new URL(fullUrl);
  const path = u.pathname + u.search; // path + query，与服务端 r.URL.RequestURI() 一致
  const timestamp = nowUnixSeconds();
  const nonce = generateNonce();
  const msg = [String(method).toUpperCase(), path, timestamp, nonce, rawBody || ''].join('\n');
  const key = hmacKeyForCredential(cred);
  const signature = crypto
    .createHmac('sha256', key)
    .update(msg, 'utf8')
    .digest('hex');

  Object.assign(headers, {
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  });
  return headers;
}

module.exports = {
  sha256Hex,
  hmacKeyForCredential,
  generateNonce,
  buildSignHeaders,
};
