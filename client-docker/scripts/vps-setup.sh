#!/usr/bin/env bash
# =============================================================================
# 163music docker-client 的 VPS 部署脚本（Ubuntu / Debian 系）
# -----------------------------------------------------------------------------
# 功能：
#   1. 检测并安装 Docker Engine（curl -fsSL https://get.docker.com | sh）
#   2. 创建数据目录（默认 /opt/163music-docker/data）
#   3. 双通道获取镜像（自动选择，见下方「镜像来源」）
#   4. 登录 GHCR（可选：镜像已公开匿名可拉；设置了 GHCR_PAT 时才显式登录）
#   5. docker run 运行容器（常驻、自启、内存限制 1g）
#   6. 打印后续升级命令
#
# 镜像来源（IMAGE_SOURCE 环境变量控制，默认 auto）：
#   通道 1 GitHub GHCR：
#     docker pull ghcr.io/y08lin4/163music-help/docker-client:latest
#     镜像已公开，匿名即可拉取，无需 PAT（历史私有期凭据仍可通过 GHCR_PAT 传入）。
#   通道 2 Cloudflare CDN（tar）：
#     curl 下载 tar 包并 docker load，无需登录任何 registry。
#   IMAGE_SOURCE=auto（默认）：先试 GHCR，失败自动切换 CDN；
#   IMAGE_SOURCE=ghcr       ：强制 GHCR（失败即退出并提示 CDN 命令）；
#   IMAGE_SOURCE=cdn        ：强制 CDN（跳过 GHCR 登录，国内网络推荐）。
#
# 用法：
#   chmod +x vps-setup.sh
#   # 方式 A：只给 UI 密码（镜像公开，无需 PAT）
#   UI_PASSWORD='你的密码' ./vps-setup.sh
#   # 方式 B：不传环境变量，脚本会交互询问
#   sudo ./vps-setup.sh
#   # 强制走 CDN 通道（国内网络推荐）：
#   IMAGE_SOURCE=cdn UI_PASSWORD='你的密码' ./vps-setup.sh
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# 可调参数（按需覆盖，例如：DATA_DIR=/srv/163music ./vps-setup.sh）
# -----------------------------------------------------------------------------
# 镜像获取通道：auto（默认，先 GHCR 后 CDN）| ghcr | cdn
IMAGE_SOURCE="${IMAGE_SOURCE:-auto}"
IMAGE="ghcr.io/y08lin4/163music-help/docker-client:latest"
CDN_TAR_URL="https://163music.linyu.qzz.io/docker/163music-docker-client-latest.tar.gz"
CDN_SHA_URL="${CDN_TAR_URL}.sha256"
DATA_DIR="${DATA_DIR:-/opt/163music-docker/data}"
CONTAINER_NAME="163music-docker-client"
GHCR_NAMESPACE="ghcr.io/y08lin4"
# 端口映射：宿主机 3000 → 容器 3000（与客户端组件约定一致）
HOST_PORT="${HOST_PORT:-13000}"
CONTAINER_PORT=3000
TZ="${TZ:-Asia/Shanghai}"

log()  { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# =============================================================================
# 1) 检测 / 安装 Docker Engine
# -----------------------------------------------------------------------------
# 优先探测 docker 命令；没有则尝试 apt 安装源里的 docker.io，
# 再回退到官方一键脚本 get.docker.com。
# get.docker.com 需要 root 权限，非 root 时用 sudo 包装。
# =============================================================================
install_docker() {
    if command -v docker >/dev/null 2>&1; then
        log "Docker 已安装：$(docker --version)"
        return 0
    fi

    log "未检测到 Docker，开始安装……"

    # 判断是否有 root 权限，决定是否用 sudo
    local sudo_cmd=""
    if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
        sudo_cmd="sudo"
    fi

    # 尝试通过发行版包管理器安装（更稳、后续可用 apt 升级）
    if command -v apt-get >/dev/null 2>&1; then
        if ${sudo_cmd:+${sudo_cmd} }apt-get install -y docker.io 2>/dev/null; then
            log "已通过 apt 安装 docker.io"
        else
            warn "apt 安装 docker.io 失败，改用官方一键脚本 get.docker.com"
            curl -fsSL https://get.docker.com | ${sudo_cmd:+${sudo_cmd} }sh
        fi
    else
        # 非 apt 系（应不会走到，本脚本面向 Ubuntu/Debian），仍用官方脚本兜底
        curl -fsSL https://get.docker.com | ${sudo_cmd:+${sudo_cmd} }sh
    fi

    # 校验安装结果
    if ! command -v docker >/dev/null 2>&1; then
        die "Docker 安装失败，请检查网络或手动安装后重试：https://docs.docker.com/engine/install/"
    fi

    # 若当前用户不在 docker 组，提示加入，避免后续每次都要 sudo
    if ! ${sudo_cmd:+${sudo_cmd} }docker info >/dev/null 2>&1; then
        warn "当前用户无权访问 docker 守护进程。执行以下命令并重新登录后生效："
        warn "  sudo usermod -aG docker $USER"
        die "请完成上述配置后重新运行本脚本（或全程加 sudo）。"
    fi

    log "Docker 就绪：$(docker --version)"
}

# =============================================================================
# 2) 创建数据目录（挂载到容器 /data）
# =============================================================================
ensure_data_dir() {
    log "创建数据目录：${DATA_DIR}"
    mkdir -p "${DATA_DIR}"
    # 提示：若容器内进程以非 root 运行，可能需要 chown 调整属主，这里保持默认。
}

# =============================================================================
# 3) 登录 GHCR（可选；镜像已公开，匿名即可拉取）
# -----------------------------------------------------------------------------
# 镜像 ghcr.io/y08lin4/163music-help/docker-client 已公开，无需 PAT 即可 pull。
# 本函数仅在设置了 GHCR_PAT 时做一次显式登录（兼容历史私有期凭据），
# 未设置则直接跳过（匿名拉取）。IMAGE_SOURCE=cdn 时同样跳过。
# =============================================================================
login_ghcr() {
    local pat="${GHCR_PAT:-}"
    if [[ -z "${pat}" ]]; then
        log "镜像已公开，跳过 GHCR 登录（匿名拉取）"
        return 0
    fi

    # 通过 stdin 传 PAT，避免明文出现在 ps 输出或命令行参数里
    log "登录 GHCR：${GHCR_NAMESPACE}"
    if ! docker login "${GHCR_NAMESPACE}" -u "__token__" --password-stdin <<<"${pat}"; then
        die "GHCR 登录失败，请检查 PAT 是否具备 read:packages 权限。"
    fi
    log "GHCR 登录成功"
}

# =============================================================================
# 4) 读取 UI_PASSWORD（必填环境变量）
# =============================================================================
require_ui_password() {
    if [[ -z "${UI_PASSWORD:-}" ]]; then
        read -r -s -p "请输入 UI_PASSWORD（容器 Web 界面密码，必填）: " UI_PASSWORD
        echo
    fi
    if [[ -z "${UI_PASSWORD}" ]]; then
        die "UI_PASSWORD 为必填项，未提供。"
    fi
}

# =============================================================================
# 5) 获取镜像（双通道）+ 运行容器
# -----------------------------------------------------------------------------
# 运行参数与客户端组件约定对齐：
#   - 镜像    ghcr.io/y08lin4/163music-help/docker-client:latest（两通道产物同名）
#   - 环境    -e UI_PASSWORD（必填）、-e TZ=Asia/Shanghai
#   - 端口    -p 113000:3000
#   - 数据卷  -v /opt/163music-docker/data:/data
#   - 自启    --restart unless-stopped
#   - 内存    --memory 1g
# 镜像获取策略（IMAGE_SOURCE）：
#   auto（默认）先试 GHCR（需已登录），失败自动切换 Cloudflare CDN（tar，免登录）；
#   ghcr 强制 GHCR；cdn 强制 CDN。成功时打印实际使用的通道。
# =============================================================================
pull_image_ghcr() {
    log "镜像来源：GitHub GHCR"
    if docker pull "${IMAGE}"; then
        return 0
    fi
    warn "GHCR 拉取失败：${IMAGE}"
    return 1
}

verify_tar_checksum() {
    # 若 CDN 同目录存在 .sha256 校验文件则用 sha256sum -c 校验；
    # 文件 404 时跳过校验（可选校验，容忍失败）。
    if ! curl -fsSL -o /tmp/163music-docker-client.tar.gz.sha256 "${CDN_SHA_URL}"; then
        warn "未获取到 .sha256 校验文件（${CDN_SHA_URL}），跳过校验。"
        return 0
    fi

    log "校验镜像校验和（sha256sum -c）……"
    if (cd /tmp && sha256sum -c 163music-docker-client.tar.gz.sha256) >/dev/null 2>&1; then
        log "校验通过"
    else
        # .sha256 内引用的文件名可能与本地文件名不一致，退化为按哈希内容比对
        local expected actual
        expected="$(awk '{gsub(/\r/,""); print $1}' /tmp/163music-docker-client.tar.gz.sha256 | head -n1)"
        actual="$(sha256sum /tmp/163music-docker-client.tar.gz | awk '{print $1}')"
        if [[ -z "${expected}" || "${expected}" != "${actual}" ]]; then
            rm -f /tmp/163music-docker-client.tar.gz /tmp/163music-docker-client.tar.gz.sha256
            die "镜像校验失败（${CDN_SHA_URL}）。请重新运行本脚本重试；若仍失败，可改用 IMAGE_SOURCE=ghcr 走 GHCR 通道。"
        fi
        log "校验通过（哈希比对）"
    fi
    rm -f /tmp/163music-docker-client.tar.gz.sha256
}

load_image_from_cdn() {
    log "镜像来源：Cloudflare CDN（tar）"
    if ! curl -fSL -o /tmp/163music-docker-client.tar.gz "${CDN_TAR_URL}"; then
        rm -f /tmp/163music-docker-client.tar.gz
        die "CDN 下载失败：${CDN_TAR_URL}。请重新运行本脚本重试；若仍失败，可改用 IMAGE_SOURCE=ghcr 走 GHCR 通道。"
    fi
    verify_tar_checksum
    if ! docker load -i /tmp/163music-docker-client.tar.gz; then
        rm -f /tmp/163music-docker-client.tar.gz
        die "docker load 失败。请重新运行本脚本重试；若仍失败，可改用 IMAGE_SOURCE=ghcr 走 GHCR 通道。"
    fi
    rm -f /tmp/163music-docker-client.tar.gz
}

# 按 IMAGE_SOURCE 选择通道；GHCR 登录仅在需要走 GHCR 通道时执行。
acquire_image() {
    case "${IMAGE_SOURCE}" in
        auto)
            login_ghcr
            if pull_image_ghcr; then
                return 0
            fi
            warn "GHCR 拉取失败，自动切换到 Cloudflare CDN（tar）通道……"
            load_image_from_cdn
            ;;
        ghcr)
            login_ghcr
            if ! pull_image_ghcr; then
                local hint
                hint="GHCR 拉取失败。可手动改用 CDN 通道重试：
  IMAGE_SOURCE=cdn ./vps-setup.sh
  或直接执行：
  curl -fSL -o /tmp/163music-docker-client.tar.gz ${CDN_TAR_URL} && docker load -i /tmp/163music-docker-client.tar.gz"
                die "${hint}"
            fi
            ;;
        cdn)
            load_image_from_cdn
            ;;
        *)
            die "IMAGE_SOURCE 取值非法：${IMAGE_SOURCE}（允许：ghcr | cdn | auto）"
            ;;
    esac
}

run_container() {
    # 已存在同名容器时提示并重建，保证幂等（重复执行不会冲突）
    if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
        warn "检测到已存在的容器 ${CONTAINER_NAME}，停止并移除后重建……"
        docker rm -f "${CONTAINER_NAME}" >/dev/null
    fi

    log "启动容器：${CONTAINER_NAME}"
    docker run -d \
        --name "${CONTAINER_NAME}" \
        --restart unless-stopped \
        --memory 1g \
        -e "UI_PASSWORD=${UI_PASSWORD}" \
        -e "TZ=${TZ}" \
        -p "${HOST_PORT}:${CONTAINER_PORT}" \
        -v "${DATA_DIR}:/data" \
        "${IMAGE}"

    log "容器已启动，查看状态："
    docker ps --filter "name=${CONTAINER_NAME}" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

# =============================================================================
# 6) 打印后续升级命令
# =============================================================================
print_upgrade_hints() {
    cat <<'EOF'

============================================
 部署完成。后续升级到新版本，执行：
============================================
  docker pull ghcr.io/y08lin4/163music-help/docker-client:latest
  docker rm -f 163music-docker-client
  docker run -d \
      --name 163music-docker-client \
      --restart unless-stopped \
      --memory 1g \
      -e UI_PASSWORD='你的密码' \
      -e TZ=Asia/Shanghai \
      -p 113000:3000 \
      -v /opt/163music-docker/data:/data \
      ghcr.io/y08lin4/163music-help/docker-client:latest

  # 也可以用 CDN 通道一键升级（免 PAT，脚本会自动重建容器）：
  #   IMAGE_SOURCE=cdn ./vps-setup.sh

============================================
 常用运维命令
============================================
  查看日志：  docker logs -f 163music-docker-client
  查看状态：  docker ps
  停止容器：  docker stop 163music-docker-client
============================================
EOF
}

# =============================================================================
# 主流程
# =============================================================================
main() {
    log "=== 163music docker-client VPS 部署开始 ==="
    install_docker
    ensure_data_dir
    require_ui_password
    acquire_image
    run_container
    print_upgrade_hints
    log "=== 部署完成 ==="
}

main "$@"
