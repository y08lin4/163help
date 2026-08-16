# syntax=docker/dockerfile:1

# =============================================================================
# 163music docker-client —— 网易云音乐互助播放 Docker 常驻客户端
# -----------------------------------------------------------------------------
# 运行时：Node 20 + Playwright Chromium（无头浏览器真实播放）
# 目标镜像体积约 1.3GB（≤1.5GB）
# 约定（与 scripts/vps-setup.sh 保持一致）：
#   端口 3000、数据卷 /data、env UI_PASSWORD/TZ/API_BASE/UI_BIND
# =============================================================================

FROM node:20-slim

# Chromium 浏览器统一装到 /ms-playwright，而非 root 的 ~/.cache，
# 这样切换非 root 用户后仍能读写浏览器，避免"浏览器装好了但读不到"的坑。
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# 1) 先只 COPY package.json，让 npm 安装命中 Docker 层缓存：
#    只有依赖变化时才重装，业务代码改动不重复安装依赖。
#    注意：workflow 构建上下文是仓库根（context: .），所以路径要带 client-docker/ 前缀。
COPY client-docker/package.json ./

# 2) 安装依赖（--omit=dev：唯一运行时依赖就是 playwright）。
#    随后用 --with-deps 一并安装 chromium 与其系统动态库，
#    它内部会调用 apt-get，因此必须保持 root 身份执行。
#    装完清理 apt 缓存与临时文件，压缩镜像体积。
#    注意：不要在下方 && 链内写行内 # 注释，会被 shell 连坐注释掉后续命令。
RUN npm install --omit=dev \
    && npx playwright install --with-deps chromium \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/*

# 3) 拷贝业务源码（构建上下文是仓库根，只拷 client-docker/ 目录内容；
#    仓库其它目录不进镜像）。
COPY client-docker/. .

# 4) 创建非 root 的 app 用户，并把代码、浏览器、数据目录的属主交给他，
#    容器内不再以 root 运行（降低提权风险）。
#    注意：node:20-slim 自带 UID 1000 的 node 用户，useradd --uid 1000 会因冲突退出（exit 4），
#    故改用 UID 1001。
RUN useradd --create-home --uid 1001 app \
    && mkdir -p /data \
    && chown -R app:app /app /ms-playwright /data

# 5) 切换到 app 用户。
USER app

# 运行约定（与 vps-setup.sh / docker-compose.example.yml 对齐）
# UI_PASSWORD 无默认值，必须由运行方显式传入，否则容器应拒绝启动。
ENV UI_PASSWORD="" \
    API_BASE="https://163music.linyu.qzz.io/api" \
    UI_BIND="0.0.0.0" \
    TZ="Asia/Shanghai"

EXPOSE 3000

# 数据卷（cookie / store / 会话等持久化数据，升级不丢数据）
VOLUME /data

# 启动入口
CMD ["node", "src/main.js"]
