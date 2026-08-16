#!/usr/bin/env bash
# 镜像 CDN 分发：GHCR 拉取 → docker save → gzip → 放到静态站 public/docker/ → 生成 sha256
# 用法：在服务器上执行（需 docker 权限），镜像公开后无需登录 GHCR。
#   ./release-cdn.sh [镜像TAG] [静态站public目录]
# 示例：./release-cdn.sh latest /opt/music-help/script-release/public
set -euo pipefail

TAG="${1:-latest}"
PUBLIC_DIR="${2:-/opt/music-help/script-release/public}"
IMG="ghcr.io/y08lin4/163music-help/docker-client:${TAG}"
OUT_DIR="${PUBLIC_DIR}/docker"
OUT_FILE="163music-docker-client-${TAG}.tar.gz"

mkdir -p "${OUT_DIR}"
echo "[1/4] 拉取镜像 ${IMG} ..."
docker pull "${IMG}"

echo "[2/4] 导出并压缩 ..."
docker save "${IMG}" | gzip -1 > "${OUT_DIR}/${OUT_FILE}"

echo "[3/4] 计算 sha256 ..."
(cd "${OUT_DIR}" && sha256sum "${OUT_FILE}" > "${OUT_FILE}.sha256")

echo "[4/4] latest 通道（无版本 tag）同步 ..."
if [ "${TAG}" != "latest" ]; then
  cp -f "${OUT_DIR}/${OUT_FILE}" "${OUT_DIR}/163music-docker-client-latest.tar.gz"
  cp -f "${OUT_DIR}/${OUT_FILE}.sha256" "${OUT_DIR}/163music-docker-client-latest.tar.gz.sha256"
fi

echo "完成："
ls -lh "${OUT_DIR}/${OUT_FILE}" "${OUT_DIR}/${OUT_FILE}.sha256"
cat "${OUT_DIR}/${OUT_FILE}.sha256"
echo "CDN URL: https://163music.linyu.qzz.io/docker/${OUT_FILE}"
echo "校验 URL: https://163music.linyu.qzz.io/docker/${OUT_FILE}.sha256"
