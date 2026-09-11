#!/usr/bin/env bash
# 一键启动 ZJU Rule 本地转换服务。
#
#   ./local/start.sh              启动（前台运行，Ctrl-C 退出）
#   WEB_PORT=9000 ./local/start.sh  换端口
#
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node，请先安装 Node.js 18+：https://nodejs.org/" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ 需要 Node.js 18 或更高版本（当前 $(node -v)）" >&2
  exit 1
fi

exec node local/server.mjs "$@"
