# 网易云音乐互助播放 · Docker 常驻客户端

网易云音乐互助播放的**第三种客户端形态**：Docker 常驻版。

- **24 小时在线**：容器长期运行，无需打开浏览器挂机。
- **真实播放**：内置无头浏览器（Playwright Chromium）进行真实播放，行为贴近真人。
- **参与调度**：服务端会把本客户端识别为 `docker` 类型客户端，纳入互助播放的调度体系。

> 本项目 `client-docker/` 是网易云互助播放的第三个客户端组件。运行入口为 `src/main.js`，核心依赖 `playwright`。

---

## 快速开始

### 方式一：`docker run`（推荐，单容器最直接）

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

参数说明：

| 参数 | 作用 |
| --- | --- |
| `-e UI_PASSWORD` | **必填**，Web 管理界面登录密码；不设置容器会拒绝启动 |
| `-p 3000:3000` | 管理界面端口（宿主 3000 → 容器 3000） |
| `-v ./data:/data` | 数据卷：cookie / store / 会话持久化，升级不丢数据 |
| `--restart unless-stopped` | 崩溃或重启后自动拉起，实现常驻 |
| `--memory 1g` | 内存上限 1G，防无头浏览器吃爆内存 |

> 镜像位于 GitHub Container Registry，默认私有，拉取前需先 `docker login ghcr.io`（详见 `scripts/RELEASE.md` 的 PAT 说明）。

### 方式二：Docker Compose

复制 `docker-compose.example.yml` 为 `docker-compose.yml`，修改 `UI_PASSWORD` 后：

```bash
docker compose up -d
```

> 一个容器 = 一个网易云账号。多账号请复制多个 service，并各自改容器名、宿主机端口与数据卷（`./data2:/data` 等）。

---

## 首次配置（三步）

1. **登录**：浏览器打开 `http://IP:3000`，输入刚才设置的 `UI_PASSWORD`。
2. **粘贴 Cookie**：在浏览器按 `F12` 打开开发者工具，在 Network/Application 中找到网易云音乐的 `MUSIC_U` 与 `__csrf`，复制到客户端粘贴。
   > ⚠️ Cookie 等同账号登录凭证，**请勿外泄**，也切勿公开截图、分享给他人或提交到任何仓库。
3. **填写服务端凭证**（二选一，推荐前者）：
   - **推荐**：使用 portal 生成的**客户端密钥**（以 `mh_ck_` 开头），粘贴即可**长期直接使用**，无需反复授权。
   - 备选：通过 **Linux.do 授权**获取 `ticket`，粘贴换取 `token` 使用。

---

## 活跃时间窗口

在客户端管理界面可设置**每日活跃开始 / 结束时间**：

- 支持**跨零点**（例如 `22:00` → `06:00`）。
- 跨度上限 **16 小时**，超过会被限制。
- **窗口外不领取新任务**。

**用途**：把实际播放火力集中到你希望的时间段，例如避开凌晨的服务端高峰期，减少对服务器与账号的持续压力。

---

## 安全提醒

- **管理端口公网暴露务必设强密码**：`UI_PASSWORD` 未设置时容器将**拒绝启动**。切勿使用简单口令，建议 `--memory` 限制 + 强密码一起用。
- **Cookie / 密钥等同账号凭证**：`MUSIC_U`、`__csrf`、`mh_ck_*` 密钥、`token` 均勿泄露、勿入库、勿截图外发。
- **建议使用小号**并合理设置活跃窗口，降低网易云风控风险；避免主号高频操作引发异常。

---

## 常见问题（FAQ）

**日志在哪里看？**

```bash
docker logs -f 163music-docker-client
```

**数据存在哪？**

容器内为 `/data` 卷，宿主上就是你映射的目录（`docker run` 示例里的 `./data`，`vps-setup.sh` 默认 `/opt/163music-docker/data`）。**升级容器不会丢数据**，前提是保持同一个数据卷。

**怎么升级？**

- 首次部署：运行 `scripts/vps-setup.sh`。
- 后续升级：参照 `scripts/RELEASE.md` 中的**升级命令**（`docker pull` → `docker rm -f` → 用相同数据卷重新 `docker run`）。数据卷保持不变即可无损升级。

**内存不够 / 容器反复重启？**

确认启动参数里带 `--memory 1g`，并检查 `docker logs` 是否有 OOM 或浏览器崩溃日志；必要时调高内存上限。

---

## 更多

- 发布 / 打 tag / GHCR 私有包与 PAT：见 [`scripts/RELEASE.md`](scripts/RELEASE.md)
- VPS 一键部署脚本：见 [`scripts/vps-setup.sh`](scripts/vps-setup.sh)
