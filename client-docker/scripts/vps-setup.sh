#!/usr/bin/env bash
# =============================================================================
# 163music docker-client 的 VPS 部署脚本（Ubuntu / Debian 系）
# -----------------------------------------------------------------------------
# 功能：
#   1. 检测并安装 Docker Engine（curl -fsSL https://get.docker.com | sh）
#   2. 创建数据目录（默认 /opt/163music-docker/data）
#   3. 指导登录 GHCR（读 GHCR_PAT 环境变量或交互输入）
#   4. docker run 运行容器（常驻、自启、内存限制 1g）
#   5. 打印后续升级命令
#
# 用法：
#   chmod +x vps-setup.sh
#   # 方式 A：通过环境变量提供 PAT（推荐，脚本可完全无交互运行）
#   UI_PASSWORD='你的密码' GHCR_PAT='ghp_xxx' ./vps-setup.sh
#   # 方式 B：不传环境变量，脚本会交互询问
#   sudo ./vps-setup.sh
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# 可调参数（按需覆盖，例如：DATA_DIR=/srv/163music ./vps-setup.sh）
# -----------------------------------------------------------------------------
IMAGE="ghcr.io/y08lin4/163music-help/docker-client:latest"
DATA_DIR="${DATA_DIR:-/opt/163music-docker/data}"
CONTAINER_NAME="163music-docker-client"
GHCR_NAMESPACE="ghcr.io/y08lin4"
# 端口映射：宿主机 3000 → 容器 3000（与客户端组件约定一致）
HOST_PORT="${HOST_PORT:-3000}"
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
# 3) 登录 GHCR（私有镜像，拉取前必须认证）
# -----------------------------------------------------------------------------
# GHCR 的包默认是私有的，VPS 拉取需要 PAT（读包权限 read:packages）。
# 优先读环境变量 GHCR_PAT，否则交互输入（不回显）。
# =============================================================================
login_ghcr() {
    local pat="${GHCR_PAT:-}"
    if [[ -z "${pat}" ]]; then
        read -r -s -p "请输入 GHCR PAT（read:packages 权限，输入不回显）: " pat
        echo
    fi
    if [[ -z "${pat}" ]]; then
        die "未提供 GHCR PAT。请设置 GHCR_PAT 环境变量或交互输入后重试。"
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
# 5) 拉取并运行容器
# -----------------------------------------------------------------------------
# 运行参数与客户端组件约定对齐：
#   - 镜像    ghcr.io/y08lin4/163music-help/docker-client:latest
#   - 环境    -e UI_PASSWORD（必填）、-e TZ=Asia/Shanghai
#   - 端口    -p 3000:3000
#   - 数据卷  -v /opt/163music-docker/data:/data
#   - 自启    --restart unless-stopped
#   - 内存    --memory 1g
# =============================================================================
run_container() {
    # 先停掉已存在的同名容器，保证幂等（重复执行不会冲突）
    if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
        warn "检测到已存在的容器 ${CONTAINER_NAME}，停止并移除……"
        docker rm -f "${CONTAINER_NAME}" >/dev/null
    fi

    log "拉取镜像：${IMAGE}"
    docker pull "${IMAGE}"

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
      -p 3000:3000 \
      -v /opt/163music-docker/data:/data \
      ghcr.io/y08lin4/163music-help/docker-client:latest

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
    login_ghcr
    run_container
    print_upgrade_hints
    log "=== 部署完成 ==="
}

main "$@"
