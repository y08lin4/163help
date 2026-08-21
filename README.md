# 163help 🎵

> 当前版本：**v4.0.20**

网易云音乐互助播放的**客户端**仓库，提供三种独立客户端形态：**油猴脚本** / **Chrome 浏览器扩展** / **Docker 常驻客户端**（按需选择）。

## 这是什么

一个网易云音乐**互助播放**工具：用户之间互相帮助播放歌曲——你帮别人放歌赚积分，用积分换别人帮你放歌，从而完成任务（如音乐人每月播放量任务）。

**不卖播放量、不收费、不搞会员，纯社区互助。**

## 安装方式（三选一）

### 方式 A：油猴脚本

1. 安装浏览器插件 [Tampermonkey](https://www.tampermonkey.net/)（油猴）
2. 打开下方地址，Tampermonkey 会弹出安装确认，点「安装」：

   ```
   https://163music.linyu.qzz.io/music-help.user.js
   ```

3. 打开网页版 [music.163.com](https://music.163.com/)，页面右侧出现「🎵 互助面板」

### 方式 B：Chrome 浏览器扩展（无需 Tampermonkey）

扩展版是油猴脚本的完整移植，额外提供**开机自启 + 标签静音**，适合想把浏览器常驻挂着的人：

1. 下载本仓库的 `extension/` 目录（Clone 或下载 ZIP）
2. Chrome 打开 `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点「加载已解压的扩展程序」，选择 `extension/` 目录
5. 扩展会自动打开一个静音的网易云标签，登录后即可使用

> 扩展版只静音网易云标签，其它标签不受影响。


### 方式 C：Docker 常驻客户端（VPS 24 小时在线互助）

不需要打开浏览器，把客户端放进 Docker 容器，在 VPS 上 **24 小时常驻互助**：无头浏览器（Playwright Chromium）真实播放，一个容器 = 一个网易云账号。当前版本 **v4.0.20**，镜像已公开、匿名可拉取。

**一键脚本（自动选择镜像通道）**：脚本默认先试 GitHub GHCR、失败自动切换 Cloudflare CDN；国内 VPS 可 `IMAGE_SOURCE=cdn` 强制走 CDN（免登录、更稳）：

```bash
curl -fsSL https://raw.githubusercontent.com/y08lin4/163help/main/client-docker/scripts/vps-setup.sh -o vps-setup.sh
chmod +x vps-setup.sh
UI_PASSWORD='你的强密码' ./vps-setup.sh
```

**双通道手动安装（任选其一）**

通道 A：GitHub GHCR（海外推荐）——镜像已公开、匿名可拉取，无需 `docker login`：

```bash
docker run -d \
  --name 163music-docker-client \
  --restart unless-stopped \
  --memory 1g \
  -e UI_PASSWORD='你的强密码' \
  -e TZ=Asia/Shanghai \
  -p 3000:3000 \
  -v ./data:/data \
  ghcr.io/y08lin4/163music-help/docker-client:latest
```

通道 B：Cloudflare CDN tar（国内推荐）——无需登录任何 registry，国内拉取更稳：

```bash
# 1. 下载 tar 包（附 .sha256 校验文件，可选校验）
curl -fSL -o /tmp/163music-docker-client.tar.gz \
  https://163music.linyu.qzz.io/docker/163music-docker-client-latest.tar.gz
curl -fSL -o /tmp/163music-docker-client.tar.gz.sha256 \
  https://163music.linyu.qzz.io/docker/163music-docker-client-latest.tar.gz.sha256
(cd /tmp && sha256sum -c 163music-docker-client.tar.gz.sha256)

# 2. 导入镜像（镜像名与通道 A 相同，随后执行通道 A 的 docker run 命令即可）
docker load -i /tmp/163music-docker-client.tar.gz
```

**要点**

- **`UI_PASSWORD` 必设强密码**：Web 管理界面登录用，未设置容器会拒绝启动。
- **管理界面**：`http://IP:3000`，粘贴网易云 Cookie + portal 客户端密钥（`mh_ck_` 开头）即可长期运行；宿主机端口冲突时自行映射，如 `-p 13000:3000`。
- **数据持久化**：`-v ./data:/data`（cookie / store / 会话），升级不丢数据。
- **升级**：`docker pull ghcr.io/y08lin4/163music-help/docker-client:latest` → `docker rm -f 163music-docker-client` → 用**相同数据卷**重新 `docker run`；或直接重跑一键脚本（自动重建容器）。
- **常驻参数**：`--restart unless-stopped`（崩溃自动拉起）+ `--memory 1g`（防无头浏览器吃爆内存）+ `-e TZ=Asia/Shanghai`。
- **镜像**：`ghcr.io/y08lin4/163music-help/docker-client`（tag：`latest` / `docker-v4.0.20`）。
- 支持每日活跃时间窗口（跨零点，上限 16 小时）、Docker Compose、VPS 一键脚本；完整说明见仓库 `client-docker/` 目录。
## 仓库结构

```
.
├── music-help.user.js   # 油猴脚本
├── index.html           # 使用说明页
├── extension/           # Chrome MV3 浏览器扩展（独立版）
│   ├── manifest.json
│   ├── background.js    # 开机自启 + 标签静音
│   └── content.js       # 完整移植的互助逻辑
└── LICENSE
```

## 功能

- 多歌曲挂载，专辑自动展开成单曲
- 偏好选择：短歌优先 / 长歌优先 / 随机
- 只帮不助：只帮别人赚积分，自己不排队
- 个人中心 / 排行榜
- 播放进度心跳（反作弊数据收集）
- 网易云账号 ID 上报
- VIP 类型图标
- 播放趋势自动上报：音乐人账号每日自动同步近 30 天播放数据，无需手动填报
- SMTP 邮件日报：被助 30/30 达成时自动发送邮件日报（附余额与支撑天数预测）
- 扩展版额外：开机自启 + 标签静音

详细使用说明见 [index.html](index.html)。

## 免责声明

本脚本仅用于个人学习、研究与浏览器自动化实践。请遵守网易云音乐、Linux.do 及相关法律法规，因使用产生的风险由使用者自行承担。

## License

[CC BY-NC 4.0](LICENSE) — 非商业使用
