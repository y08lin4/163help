# 客户端组件发布手册（Docker + GHCR + VPS）

本文档面向需要发布或更新「Docker 常驻客户端组件」的开发者与运维。

## 一、总体发布流程

```text
改完代码
   │
   ▼
push 到 main（可选：先在本地验证）
   │
   ▼
打 tag：git tag docker-vX  &&  git push origin docker-vX
   │
   ▼
GitHub Actions 自动构建 → 推送到 GHCR
（ghcr.io/y08lin4/163music-help/docker-client）
   │
   ▼
VPS 上运行 vps-setup.sh（首次） 或 执行升级命令（更新）
```

### 分步说明

1. **改完代码**：修改客户端代码 / Dockerfile / docker-compose.example.yml 后自测无误。
2. **push**：提交并推送到远端 `main` 分支。
3. **打 tag**（关键触发点）：

   ```bash
   # 每次发布递增版本号 X
   git tag docker-vX            # 例如 docker-v3
   git push origin docker-vX    # 推送 tag 即触发构建
   ```

   > 只需推 tag，无需单独的 release。tag 名必须匹配 `docker-v*`。

4. **Actions 自动构建推 GHCR**：工作流 `Build and push docker client` 会被自动触发，完成：
   - 检出源码 → 登录 GHCR → 构建 client-docker 目录
   - 推两个标签：`latest` 和 `docker-vX`
   - 复用构建缓存（type=gha），未变化的镜像层不重复构建

   可在仓库 **Actions** 页查看构建进度与结果。

5. **VPS 部署**：
   - **首次部署**：运行 `client-docker/scripts/vps-setup.sh`（见下文）
   - **后续升级**：执行升级命令（见下文「升级」）

### 升级（后续版本更新）

```bash
docker pull ghcr.io/y08lin4/163music-help/docker-client:latest
docker rm -f 163music-docker-client
docker run -d \
    --name 163music-docker-client \
    --restart unless-stopped \
    --memory 1g \
    -e UI_PASSWORD='你的密码' \
    -e TZ=Asia/Shanghai \
    -p 3000:3000 \
    -v /opt/163music-docker/data:/data \
    ghcr.io/y08lin4/163music-help/docker-client:latest
```

> 数据卷 `/opt/163music-docker/data:/data` 保持不变，升级不会丢失数据。

---

## 二、VPS 首次部署（vps-setup.sh）

```bash
# 1. 赋予执行权限
chmod +x client-docker/scripts/vps-setup.sh

# 2a. 推荐：通过环境变量运行（可完全无交互）
UI_PASSWORD='你的密码' GHCR_PAT='ghp_xxx' ./vps-setup.sh

# 2b. 或直接运行（脚本会交互询问 UI_PASSWORD 与 PAT）
sudo ./vps-setup.sh
```

脚本会依次完成：

1. 检测 / 安装 Docker Engine（优先 apt 的 docker.io，回退 `curl -fsSL https://get.docker.com | sh`）
2. 创建数据目录 `/opt/163music-docker/data`
3. 登录 GHCR（读 `GHCR_PAT` 环境变量或交互输入）
4. `docker run` 启动容器（参数见下）
5. 打印后续升级命令

### 运行参数约定

| 项 | 值 |
| --- | --- |
| 镜像 | `ghcr.io/y08lin4/163music-help/docker-client:latest` |
| 环境变量 | `UI_PASSWORD`（必填）、`TZ=Asia/Shanghai` |
| 端口 | `-p 3000:3000` |
| 数据卷 | `-v /opt/163music-docker/data:/data` |
| 自启 | `--restart unless-stopped` |
| 内存限制 | `--memory 1g` |

---

## 三、GHCR 私有包与 PAT 说明

**重要：GHCR 上的包默认是私有的**，VPS 拉取镜像前必须先认证。

- **镜像地址**：`ghcr.io/y08lin4/163music-help/docker-client`
- **命名空间**：`ghcr.io/y08lin4`
- **认证方式**：Personal Access Token（PAT）

### 获取 PAT 的步骤

1. 打开 GitHub → 右上角头像 → **Settings**
2. 左侧 **Developer settings** → **Personal access tokens** → **Tokens (classic)**
3. 点击 **Generate new token (classic)**
4. 勾选 **`read:packages`** 权限（只需读包即可拉取镜像）
5. 生成后复制 token（形如 `ghp_xxx`，**只显示一次，请妥善保存**）

### 在 VPS 上使用 PAT

```bash
# 方式一：通过 vps-setup.sh（读取 GHCR_PAT）
GHCR_PAT='ghp_xxx' ./vps-setup.sh

# 方式二：手动 docker login
echo 'ghp_xxx' | docker login ghcr.io/y08lin4 -u __token__ --password-stdin
```

登录成功后，`docker pull ghcr.io/y08lin4/163music-help/docker-client:latest` 即可拉取。

---

## 四、服务端 .env 需要同步的事项清单（给运维）

> 客户端组件发布时，服务端 `.env` 可能也需要同步调整。**请逐项核对：**

- [ ] **`LATEST_VERSION` 升到 `4.0.16`** —— 客户端升级到新版本后，务必把服务端 `.env` 的 `LATEST_VERSION` 更新为 `4.0.16`，确保新旧客户端版本校验一致。
- [ ] **CORS 新头** —— 如有新增的 CORS 相关响应头，**由服务端代码自动生效**，无需手动改 `.env`，但需确认服务端已重启以加载最新代码。
- [ ] **`MIN_SUPPORTED_VERSION` 不动** —— 本次发布**不修改** `MIN_SUPPORTED_VERSION`，保持原值，避免误伤仍在使用旧版客户端的用户。

> 以上为提醒清单，具体以本次发布的实际改动为准。改动后记得重启服务端使其生效。

---

## 五、附录：常用命令速查

```bash
# 构建缓存说明：workflow 使用 type=gha 缓存，重复构建复用未变化层，节省大镜像（约 1.3GB）的构建时间
# 手动触发构建：仓库 Actions → Build and push docker client → Run workflow
# 查看最新可用 tag：git tag | grep '^docker-v' | sort -V
```
