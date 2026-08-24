# 网易云音乐互助播放脚本（Chrome MV3 扩展版）

本扩展是 `music-help.user.js`（Tampermonkey 油猴脚本）的**独立移植版本**，不依赖 Tampermonkey，可作为普通 Chrome 扩展安装。你也可以继续使用油猴脚本，两者功能一致。

- 版本：`4.0.21`
- API 服务：`https://163music.linyu.qzz.io/api`

## 安装（加载已解压的扩展程序）

1. 打开 Chrome，在地址栏输入 `chrome://extensions/` 并回车。
2. 打开右上角的 **「开发者模式」** 开关。
3. 点击左上角 **「加载已解压的扩展程序」**。
4. 选择本目录 `extension/`（即包含 `manifest.json` 的那个文件夹）。
5. 安装后扩展会自动打开一个**静音的** `https://music.163.com/` 标签页，并把网易云音乐标签页统一静音。

## 使用

1. 打开网易云音乐网页版，页面右下角会出现 🎵 互助面板。
2. 首次使用请阅读并确认风险提示，然后点击 **「登录 Linux.do」** 完成登录授权。
3. 在「音乐 ID」输入框中填写要加入互助队列的歌曲（每行一个，仅支持单曲，如 `song:123` 或纯数字 `123`；留空表示只帮别人、不加入被助队列）。
4. 点击 **「开启互助」** 开始自动互助播放。

## 与油猴脚本的区别（实现层面）

- **存储**：`GM_setValue / GM_getValue` → 页面 `localStorage`。因此**从油猴脚本切换到扩展后需要重新登录一次**，之前保存的音乐列表也会清空。
- **网络请求**：`GM_xmlhttpRequest` → 原生 `fetch`（服务端已开启宽松 CORS，`Access-Control-Allow-Origin: *`）。
- **样式注入**：`GM_addStyle` → 创建 `<style>` 元素注入 `<head>`。
- **运行世界**：内容脚本运行在 MAIN world（`manifest.json` 中 `"world": "MAIN"`），因此能直接访问页面播放器对象 `window.player`。
- **页面限制**：`if (window.self !== window.top) return;` 保证只在顶层页面运行。

## 说明

- 扩展只静音 `music.163.com` 域名的标签页，不触碰其它网站。
- 本扩展仅用于个人学习、研究与浏览器自动化实践，请遵守网易云音乐、Linux.do 及相关平台的服务条款。
