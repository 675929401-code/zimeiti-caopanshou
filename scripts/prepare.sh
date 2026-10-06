#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

cd "${COZE_WORKSPACE_PATH}"

# 防护：清理文件系统根目录残留的 lockfile
# 原因：沙箱 / 下可能残留 /pnpm-lock.yaml，导致 Turbopack 误判工作区根为 /
# → 模块解析失败 → 编译卡死 → Turbopack panic → 预览白屏
if [ -f "/pnpm-lock.yaml" ]; then
  echo "WARN: Found stale /pnpm-lock.yaml (causes Turbopack crash), removing..."
  rm -f /pnpm-lock.yaml
fi

echo "Installing dependencies..."

# 使用轻量安装参数，避免 OOM：
# - 去掉 --loglevel debug（产生大量输出导致内存溢出被 Kill）
# - 去掉 --reporter=append-only（缓冲全部输出，加剧内存压力）
# - 跳过浏览器下载（puppeteer/playwright 在沙箱不需要）
# - 保留 --prefer-frozen-lockfile 和 --prefer-offline 保证速度
# - 增加重试：首次失败后用更轻量的参数重试一次
export PUPPETEER_SKIP_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
if ! pnpm install --prefer-frozen-lockfile --prefer-offline 2>&1; then
  echo "WARN: pnpm install failed, retrying with minimal options..."
  pnpm install
fi

if command -v coze > /dev/null 2>&1 && coze check-bins --help > /dev/null 2>&1; then
  coze check-bins --fix
fi
