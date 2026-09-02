#!/usr/bin/env bash
# ============================================================================
# 163music docker-client · VPS 管理脚本 v2（交互式 + 命令式）
# 用法：
#   ./vps-setup.sh                交互式主菜单
#   ./vps-setup.sh install        全新安装向导
#   ./vps-setup.sh upgrade        安全升级（先拉后换 + .bak 回滚 + 健康检查）
#   ./vps-setup.sh rollback       回滚到上一版本（.bak）
#   ./vps-setup.sh status         状态总览
#   ./vps-setup.sh start|stop|restart
#   ./vps-setup.sh logs [--tail N| -f]
#   ./vps-setup.sh config         修改配置（端口/卷/通道/镜像/时区/密码）
#   ./vps-setup.sh reset-password / show-password
#   ./vps-setup.sh backup|restore 数据卷备份 / 恢复
#   ./vps-setup.sh diagnose       诊断（网络/代理/资源）
#   ./vps-setup.sh uninstall      卸载（默认保留数据卷）
# 环境变量（自动化）：UI_PASSWORD / HOST_PORT / DATA_DIR / IMAGE_SOURCE / IMAGE_TAG / TZ
# ============================================================================
set -euo pipefail
umask 022

# ---------- 标识与常量 ----------
CONTAINER_NAME="${CONTAINER_NAME:-163music-docker-client}"
BACKUP_NAME="${CONTAINER_NAME}.bak"
CONTAINER_PORT=3000
IMAGE_REPO="ghcr.io/y08lin4/163help-client/docker-client"
IMAGE="${IMAGE_REPO}:${IMAGE_TAG:-latest}"
CDN_TAR_URL="https://163music.linyu.qzz.io/docker/163music-docker-client-latest.tar.gz"
CDN_SHA_URL="${CDN_TAR_URL}.sha256"
CONF_FILE="${HOME}/.163music-docker-client.conf"
VERSION="5.0.0"

# ---------- 输出 ----------
if [ -t 1 ]; then
  C_OK=$(printf '\033[32m'); C_WARN=$(printf '\033[33m'); C_ERR=$(printf '\033[31m')
  C_T=$(printf '\033[36m'); C_DIM=$(printf '\033[2m'); C_OFF=$(printf '\033[0m')
else
  C_OK=""; C_WARN=""; C_ERR=""; C_T=""; C_DIM=""; C_OFF=""
fi
log()  { echo "${C_T}[${1:-i}]${C_OFF} $2"; }
ok()   { echo "${C_OK}✅${C_OFF} $1"; }
warn() { echo "${C_WARN}⚠️ ${C_OFF}$1"; }
err()  { echo "${C_ERR}❌ ${C_OFF}$1" >&2; }
die()  { err "$1"; exit 1; }
step() { echo "${C_T}──[${1}/${2}] ${3}${C_OFF}"; }

# ---------- 交互工具 ----------
confirm() { # confirm "问题" [默认 y|N]
  local q="$1" def="${2:-N}" ans
  if [ "$def" = "y" ] || [ "$def" = "Y" ]; then printf "%s (%s) [Y/n] " "$q" "$def"; else printf "%s (%s) [y/N] " "$q" "$def"; fi
  read -r ans
  if [ "$def" = "y" ] || [ "$def" = "Y" ]; then
    [ -z "$ans" ] || [ "$ans" = "y" ] || [ "$ans" = "Y" ]
  else
    [ "$ans" = "y" ] || [ "$ans" = "Y" ]
  fi
}
ask() { # ask "提示" "默认值" -> 全局 ANS
  local q="$1" def="$2" ans
  printf "%s %s: " "$q" "$([ -n "$def" ] && echo "(${def})")"
  read -r ans >/dev/tty
  [ -z "$ans" ] && ans="$def"
  ANS="$ans"
}
ask_secret() { # 隐藏输入 + 二次确认
  local p1 p2
  printf "%s: " "$1"; read -r -s p1; echo
  printf "再次输入确认: "; read -r -s p2; echo
  [ "$p1" != "$p2" ] && die "两次输入不一致"
  [ -z "$p1" ] && die "密码不能为空"
  echo "$p1"
}
random_pw() { openssl rand -base64 15 2>/dev/null | tr -d '/+=' | cut -c1-20 || echo "mh$RANDOM$RANDOM"; }

# ---------- 配置持久化（不含密码） ----------
load_conf() {
  [ -f "$CONF_FILE" ] && . "$CONF_FILE" || true
}
save_conf() {
  cat > "$CONF_FILE" <<EOF
# 163music docker-client 配置（密码不落盘）
HOST_PORT="${HOST_PORT:-13000}"
DATA_DIR="${DATA_DIR:-./data}"
IMAGE_SOURCE="${IMAGE_SOURCE:-auto}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
TZ="${TZ:-Asia/Shanghai}"
EOF
}

# ---------- 基础检测 ----------
require_root() { [ "$(id -u)" -eq 0 ] || die "请以 root 运行（sudo ./vps-setup.sh）"; }
require_docker() { command -v docker >/dev/null 2>&1 || die "未安装 docker：请先安装（apt install docker.io）"; }

# ---------- 镜像操作 ----------
ghcr_digest_of() { # 远程 latest 的 digest
  local tok digest
  tok=$(curl -s "https://ghcr.io/token?scope=repository:y08lin4/163help-client/docker-client:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/')
  digest=$(curl -sI -H "Accept: application/vnd.oci.image.index.v1+json" -H "Authorization: Bearer ${tok}" \
    "https://ghcr.io/v2/y08lin4/163help-client/docker-client/manifests/${1:-latest}" |
    tr -d '\r' | grep -i '^docker-content-digest:' | awk '{print $2}')
  echo "$digest"
}
local_digest() { # 运行容器所用镜像的 RepoDigest
  local img rem
  img=$(docker inspect -f '{{.Image}}' "$1" 2>/dev/null) || return 1
  rem=$(docker inspect -f '{{index .RepoDigests 0}}' "$img" 2>/dev/null || true)
  [ -n "$rem" ] && echo "${rem##*@}" || return 1
}
need_update() {
  local r d
  r=$(ghcr_digest_of latest) || return 0
  d=$(local_digest "$CONTAINER_NAME" 2>/dev/null || true)
  [ -z "$d" ] && return 0
  [ "$r" != "$d" ]
}

# ---------- 容器操作 ----------
container_running() { docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; }
container_exists()  { docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; }

pull_image() {
  case "${IMAGE_SOURCE:-auto}" in
    ghcr)
      log i "从 GHCR 拉取 ${IMAGE}…"
      docker pull "${IMAGE}" ;;
    cdn)
      log i "从 CDN 下载并导入镜像…"
      curl -fSL -o /tmp/mh-docker-client.tar.gz "${CDN_TAR_URL}"
      curl -fSL -o /tmp/mh-docker-client.tar.gz.sha256 "${CDN_SHA_URL}" 2>/dev/null && \
        (cd /tmp && sha256sum -c mh-docker-client.tar.gz.sha256 >/dev/null 2>&1 || warn "sha256 校验失败，请检查网络后重试")
      docker load -i /tmp/mh-docker-client.tar.gz
      rm -f /tmp/mh-docker-client.tar.gz /tmp/mh-docker-client.tar.gz.sha256 ;;
    auto)
      if docker pull "${IMAGE}" 2>/dev/null; then
        ok "GHCR 拉取成功"
      else
        warn "GHCR 拉取失败，切换 CDN…"
        IMAGE_SOURCE=cdn pull_image
      fi ;;
    *) die "IMAGE_SOURCE 非法（ghcr|cdn|auto）" ;;
  esac
}

health_check() { # 容器 Up + 管理端探活（重试 5 次）
  local tries=0
  while [ "$tries" -lt 5 ]; do
    if container_running && curl -fsS -o /dev/null "http://127.0.0.1:${HOST_PORT:-13000}/" 2>/dev/null; then
      return 0
    fi
    tries=$((tries+1)); sleep 2
  done
  return 1
}

run_container() {
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --memory 1g \
    -e "UI_PASSWORD=${UI_PASSWORD}" \
    -e "TZ=${TZ:-Asia/Shanghai}" \
    -p "${HOST_PORT:-13000}:${CONTAINER_PORT}" \
    -v "${DATA_DIR:-./data}:/data" \
    "${IMAGE}"
  if health_check; then
    ok "容器启动成功 → http://${PUBLIC_IP:-你的IP}:${HOST_PORT:-13000}"
  else
    warn "容器已启动但探活未通过：查看 docker logs ${CONTAINER_NAME}"
  fi
}

# ---------- 命令实现 ----------
cmd_install() {
  require_root; require_docker
  if container_exists; then
    warn "已存在容器 ${CONTAINER_NAME}。请用 upgrade 升级，或先 uninstall。"
    return 1
  fi
  echo; log i "全新安装向导（163music docker-client ${VERSION}）"
  echo "──────────────────────────────────────────────"
  ask "镜像通道（auto|ghcr|cdn）" "${IMAGE_SOURCE:-auto}"; IMAGE_SOURCE=$ANS
  if [ -z "${UI_PASSWORD:-}" ]; then
    ask "设置管理密码方式 [1]手动输入 [2]自动生成" "1"
    case "$ANS" in
      2) UI_PASSWORD=$(random_pw); ok "已生成随机密码（请保存）: ${C_OK}${UI_PASSWORD}${C_OFF}" ;;
      *) UI_PASSWORD=$(ask_secret "请输入 UI_PASSWORD（管理端登录密码）");;
    esac
  else
    ok "使用环境变量提供的 UI_PASSWORD"
  fi
  ask "宿主端口（管理端访问）" "${HOST_PORT:-13000}"; HOST_PORT=$ANS
  ask "数据卷目录（持久化）" "${DATA_DIR:-./data}"; DATA_DIR=$ANS
  mkdir -p "$DATA_DIR"
  echo; step 1 3 "拉取镜像"
  pull_image
  step 2 3 "启动容器"
  save_conf
  run_container
  step 3 3 "完成"
  echo
  cat <<EOF
${C_OK}✅ 部署完成${C_OFF}
  管理端:  http://${PUBLIC_IP:-你的公网IP}:${HOST_PORT}
  密码:    如忘记用 ./vps-setup.sh show-password 找回（或 reset-password）
  数据卷:  ${DATA_DIR}（升级不丢失 Cookie/密钥）
  常用:    ./vps-setup.sh status | logs | upgrade
EOF
}

cmd_upgrade() {
  require_root; require_docker
  container_exists || die "未找到容器 ${CONTAINER_NAME}（全新部署请用 install）"
  echo; step 1 4 "检查更新"
  local lv
  lv=$(local_version "$CONTAINER_NAME")
  echo "  当前版本: ${lv:-${C_WARN}旧版（无版本标记）${C_OFF}}"
  echo "  最新版本: $(remote_version 2>/dev/null || echo 未知)"
  if ! need_update; then ok "当前已是最新版本，无需升级。"; return 0; fi
  local r d
  r=$(ghcr_digest_of latest); d=$(local_digest "$CONTAINER_NAME" 2>/dev/null || true)
  echo "  local  ﹒${d:0:16}…"
  echo "  remote ﹒${r:0:16}…  (latest)"
  echo "──────────────────────────────────────────────"
  confirm "确认升级？（旧容器备份为 ${BACKUP_NAME}，健康检查通过后删除）" N || { log i "已取消"; return 0; }
  step 2 4 "拉取新镜像（见进度条）"
  pull_image
  step 3 4 "切换容器（先备份后重建）"
  docker rename "$CONTAINER_NAME" "$BACKUP_NAME" 2>/dev/null || true
  if run_container && container_running; then
    docker rm -f "$BACKUP_NAME" >/dev/null 2>&1 || true
    ok "升级完成（原容器备份已清理）"
  else
    err "新容器启动失败，回滚…"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    docker rename "$BACKUP_NAME" "$CONTAINER_NAME" 2>/dev/null || true
    container_running && ok "已恢复原容器" || err "回滚异常：容器 ${BACKUP_NAME} 可能存在，请手动处理"
    return 1
  fi
  step 4 4 "完成"
}

cmd_rollback() {
  require_root; require_docker
  local bak
  bak=$(docker ps -a --format '{{.Names}}' | grep -E "^${BACKUP_NAME}$" || true)
  [ -z "$bak" ] && die "没有可用备份（${BACKUP_NAME}）。升级会在健康检查通过后清理备份。"
  confirm "恢复备份容器？当前容器将被删除" N || return 0
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rename "$BACKUP_NAME" "$CONTAINER_NAME"
  docker start "$CONTAINER_NAME" >/dev/null
  ok "已回滚到备份容器"
}

cmd_status() {
  require_docker
  echo; log i "状态总览"
  echo "──────────────────────────────────────────────"
  if container_running; then
    echo "  ${C_OK}● 运行中${C_OFF}    $(docker ps --filter "name=${CONTAINER_NAME}" --format '{{.Status}}')"
  elif container_exists; then
    echo "  ${C_WARN}● 已停止${C_OFF}    （start 启动）"
  else
    echo "  ${C_DIM}○ 未安装${C_OFF}     （install 全新安装）"
  fi
  if container_exists; then
    local lv
    lv=$(local_version "$CONTAINER_NAME")
    if [ -n "$lv" ]; then echo "  版本: ${C_OK}${lv}${C_OFF}"; else echo "  版本: ${C_WARN}旧版（无版本标记，建议 upgrade）${C_OFF}"; fi
    echo "  镜像: $(docker inspect -f '{{.Config.Image}}' "$CONTAINER_NAME")"
    local d; d=$(local_digest "$CONTAINER_NAME" 2>/dev/null || true); [ -n "$d" ] && echo "  本机digest: ${d:0:16}…"
    echo "  端口映射: $(docker port "$CONTAINER_NAME" 2>/dev/null | tr '\n' ' ')"
    echo "  数据卷: $(docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' "$CONTAINER_NAME")"
    docker inspect -f '{{.Config.Env}}' "$CONTAINER_NAME" | grep -q UI_PASSWORD && echo "  密码: ${C_OK}已设置${C_OFF}" || echo "  密码: ${C_ERR}未设置（config 可设）${C_OFF}"
    echo "  ── 最近日志 ──"
    docker logs --tail 8 "$CONTAINER_NAME" 2>&1 | sed 's/^/    /'
  fi
}

cmd_lifecycle() { # start|stop|restart
  require_root; require_docker
  container_exists || die "未安装"
  case "$1" in
    start)   docker start "$CONTAINER_NAME" >/dev/null && ok "已启动" ;;
    stop)    docker stop "$CONTAINER_NAME" >/dev/null && ok "已停止" ;;
    restart) docker restart "$CONTAINER_NAME" >/dev/null && ok "已重启" ;;
  esac
}

cmd_logs() { # logs [-f] [--tail N]
  require_docker
  docker logs "$@" "$CONTAINER_NAME" 2>&1
}

cmd_config() {
  require_root; require_docker
  container_exists || die "未安装（install）"
  echo; log i "修改配置（修改后重建容器生效）"
  echo "──────────────────────────────────────────────"
  local np vol img_tag pw_mode tz
  ask "宿主端口" "${HOST_PORT:-13000}"; np=$ANS
  ask "数据卷目录" "${DATA_DIR:-$(docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || echo ./data)}"; vol=$ANS
  ask "镜像 tag（latest 或 docker-vX）" "${IMAGE_TAG:-latest}"; img_tag=$ANS
  ask "时区" "${TZ:-Asia/Shanghai}"; tz=$ANS
  ask "密码处理 [1]沿用当前 [2]重新输入 [3]自动生成" "1"; pw_mode=$ANS
  case "$pw_mode" in
    2) UI_PASSWORD=$(ask_secret "新密码") ;;
    3) UI_PASSWORD=$(random_pw); ok "新密码（保存好）: ${C_OK}${UI_PASSWORD}${C_OFF}" ;;
  esac
  HOST_PORT=$np; DATA_DIR=$vol; IMAGE_TAG=$img_tag; TZ=$tz; IMAGE="${IMAGE_REPO}:${IMAGE_TAG}"
  mkdir -p "$DATA_DIR"
  step 1 3 "拉取镜像（如 tag 变化）"; pull_image
  step 2 3 "重建容器"; docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true; save_conf; run_container
  step 3 3 "完成"; ok "配置已生效"
}

cmd_reset_password() {
  require_root; require_docker
  container_exists || die "未安装"
  local np
  ask "密码方式 [1]手动 [2]自动生成" "1"; np=$ANS
  case "$np" in
    2) np=$(random_pw); ok "新密码（保存好）: ${C_OK}${np}${C_OFF}" ;;
    *) np=$(ask_secret "新密码") ;;
  esac
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  UI_PASSWORD=$np; run_container
  ok "密码已重置"
}

cmd_show_password() {
  require_docker
  docker inspect -f '{{index .Config.Env}}' "$CONTAINER_NAME" 2>/dev/null | tr ' ' '\n' | grep '^UI_PASSWORD=' | sed 's/^/  当前密码: /' || true
  warn "密码明文存于容器环境变量，任何能执行 docker 的人可见；建议定期 reset-password。"
}

cmd_backup() {
  require_root; require_docker
  container_exists || die "未安装"
  local dir ts out
  dir=$(docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' "$CONTAINER_NAME")
  ts=$(date +%Y%m%d_%H%M%S)
  out="/tmp/163music-docker-client-data-${ts}.tar.gz"
  step 1 1 "备份数据卷 ${dir}"
  tar -czf "$out" -C "$dir" . 2>/dev/null && ok "备份完成: ${out}" || die "备份失败"
}

cmd_restore() {
  require_root; require_docker
  container_exists || die "未安装"
  local f dir
  ls -lt /tmp/163music-docker-client-data-*.tar.gz 2>/dev/null || die "没有备份文件（backup 先备份）"
  ask "输入要恢复的备份文件完整路径" "$(ls -t /tmp/163music-docker-client-data-*.tar.gz 2>/dev/null | head -1)"
  f=$ANS
  confirm "恢复会覆盖当前数据卷，确认？" N || return 0
  dir=$(docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' "$CONTAINER_NAME")
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  tar -xzf "$f" -C "$dir" || { docker start "$CONTAINER_NAME" >/dev/null 2>&1; die "恢复失败"; }
  docker start "$CONTAINER_NAME" >/dev/null && ok "已恢复并启动"
}

cmd_diagnose() {
  echo; log i "诊断"
  echo "──────────────────────────────────────────────"
  echo -n "  docker: "; command -v docker >/dev/null 2>&1 && echo "${C_OK}ok${C_OFF}" || echo "${C_ERR}未安装${C_OFF}"
  echo -n "  网络 (ghcr): "; curl -s -o /dev/null -w '%{http_code}' "https://ghcr.io/v2/" >/dev/null 2>&1 && echo "${C_OK}ok${C_OFF}" || echo "${C_WARN}慢/不通${C_OFF}"
  echo -n "  网络 (站点): "; curl -s -o /dev/null -w '%{http_code}' "https://163music.linyu.qzz.io/music-help.user.js" >/dev/null 2>&1 && echo "${C_OK}ok${C_OFF}" || echo "${C_ERR}不通${C_OFF}"
  local proxy phost
  proxy=$(systemctl cat docker 2>/dev/null | grep -iE 'HTTPS?_PROXY' | head -3 || true)
  if [ -n "$proxy" ]; then
    warn "检测到 docker daemon 配置了代理："
    echo "$proxy" | sed 's/^/    /'
    phost=$(echo "$proxy" | head -1 | grep -oE 'http://[^ ]+' | head -1 | sed 's|http://||;s|:.*||')
    if [ -n "$phost" ] && ! ping -c1 -W1 "$phost" >/dev/null 2>&1; then
      err "代理主机 ${phost} 不可达（no route）——会导致 docker pull 失败！修复："
      echo "    rm -f /etc/systemd/system/docker.service.d/*proxy*.conf && systemctl daemon-reload && systemctl restart docker"
    fi
  else
    ok "docker 直连（无代理配置）"
  fi
  echo -n "  磁盘可用: "; df -h / | tail -1 | awk '{print $4, "("$5" used)"}'
  echo "  内存建议: --memory 1g（无头浏览器需 ≥1G）"
}

cmd_uninstall() {
  require_root; require_docker
  container_exists || die "未安装"
  warn "此操作将删除容器（${CONTAINER_NAME}）"
  confirm "确认卸载？" N || return 0
  local keep dir
  confirm "是否保留数据卷（Cookie/密钥）？" y && keep=y || keep=n
  dir=$(docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [ "$keep" = "y" ]; then
    ok "已卸载（数据卷保留: $dir）"
  else
    [ -n "$dir" ] && rm -rf "$dir"
    ok "已卸载（数据卷已删除）"
  fi
  rm -f "$CONF_FILE"
}

# ---------- 交互主菜单 ----------
interactive_menu() {
  local choice op
  while true; do
    clear 2>/dev/null || true
    cat <<EOF
${C_T}╔══════════════════════════════════════════════╗${C_OFF}
${C_T}║  ${C_OFF}163music Docker 客户端 · 管理菜单 v${VERSION} ${C_T}║${C_OFF}
${C_T}╚══════════════════════════════════════════════╝${C_OFF}
  [1] 全新安装（向导）        [2] 升级到最新（安全+回滚）
  [3] 状态总览                [4] 启动 / 停止 / 重启
  [5] 实时日志                [6] 修改配置（端口/卷/密码…）
  [7] 回滚到上一版本 (.bak)    [8] 数据卷备份 / 恢复
  [9] 诊断（网络/代理/资源）   [10] 重置密码
  [0] 卸载                    [q] 退出
EOF
    if container_running; then
      echo "  ${C_OK}● 运行中${C_OFF}  $(docker ps --filter "name=${CONTAINER_NAME}" --format '{{.Status}}')  $(docker port "$CONTAINER_NAME" 2>/dev/null | head -1 | tr -d ' ')  $(docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' "$CONTAINER_NAME")"
    fi
    printf "  请选择 [0-10/q] █ "; read -r choice
    case "$choice" in
      1) cmd_install;;
      2) cmd_upgrade;;
      3) cmd_status;;
      4) ask "操作 [start|stop|restart]" "restart"; op=$ANS; cmd_lifecycle "$op";;
      5) cmd_logs -f --tail 80;;
      6) cmd_config;;
      7) cmd_rollback;;
      8) ask "操作 [backup|restore]" "backup"; op=$ANS; [ "$op" = "restore" ] && cmd_restore || cmd_backup;;
      9) cmd_diagnose;;
      10) cmd_reset_password;;
      0) cmd_uninstall;;
      q|Q) echo; exit 0;;
      *) warn "无效选择";;
    esac
    echo; printf "按回车返回菜单…"; read -r _
  done
}

# ---------- 入口 ----------
load_conf
CMD="${1:-}"
case "$CMD" in
  ""|menu)             interactive_menu ;;
  install)             cmd_install ;;
  upgrade)             cmd_upgrade ;;
  rollback)            cmd_rollback ;;
  status)              cmd_status ;;
  start|stop|restart)  cmd_lifecycle "$CMD" ;;
  logs)                shift; cmd_logs "$@" ;;
  config)              cmd_config ;;
  reset-password)      cmd_reset_password ;;
  show-password)       cmd_show_password ;;
  backup)              cmd_backup ;;
  restore)             cmd_restore ;;
  diagnose)            cmd_diagnose ;;
  uninstall)           cmd_uninstall ;;
  *)                   echo "用法: $0 [install|upgrade|rollback|status|start|stop|restart|logs|config|reset-password|show-password|backup|restore|diagnose|uninstall]"; exit 1 ;;
esac
