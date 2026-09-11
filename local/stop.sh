#!/usr/bin/env bash
# 停止本地服务（释放 8080 / 25500 端口）。
set -uo pipefail

WEB_PORT="${WEB_PORT:-8080}"
SUB_PORT="${SUB_PORT:-25500}"

for port in "$WEB_PORT" "$SUB_PORT"; do
  pids="$(lsof -ti ":$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "停止端口 $port 上的进程: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  else
    echo "端口 $port 上没有运行中的进程"
  fi
done
