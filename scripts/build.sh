#!/bin/bash
# Coze 平台构建脚本（优化版：增量缓存 + 内存自适应 + 进度输出）
set -e

# 构建时间戳
BUILD_START=$(date +%s)
echo "[build] =========================================================="
echo "[build] 开始构建 $(date '+%Y-%m-%d %H:%M:%S')"
echo "[build] =========================================================="

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
cd "$COZE_WORKSPACE_PATH"

# ─── 内存自适应 ────────────────────────────────────────
# 自动检测可用内存，分配 70% 给 Node.js，上限 8GB
# 之前固定 1024MB 太小 → GC 频繁 → 构建慢/卡死
detect_memory() {
  local avail_mb=0
  if command -v free >/dev/null 2>&1; then
    avail_mb=$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')
  fi
  if [ -z "$avail_mb" ] || [ "$avail_mb" -eq 0 ]; then
    avail_mb=2048  # 保底 2GB
  fi
  # 分配 70%，上限 8192MB
  local heap_mb=$((avail_mb * 70 / 100))
  if [ "$heap_mb" -gt 8192 ]; then
    heap_mb=8192
  elif [ "$heap_mb" -lt 1024 ]; then
    heap_mb=1024
  fi
  echo "$heap_mb"
}

if [ -n "${NODE_OPTIONS:-}" ]; then
  echo "[build] 沿用已有 NODE_OPTIONS: $NODE_OPTIONS"
else
  HEAP_MB=$(detect_memory)
  export NODE_OPTIONS="--max-old-space-size=${HEAP_MB}"
  echo "[build] 自动分配 Node.js 堆内存: ${HEAP_MB}MB"
fi

export NEXT_TELEMETRY_DISABLED=1
# 跳过构建时的 ESLint 检查（Next.js 官方环境变量）
export DISABLE_ESLINT_PLUGIN=true

# 跳过浏览器下载（puppeteer/playwright 在部署沙箱完全不需要）
export PUPPETEER_SKIP_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# libuv 线程池：根据 CPU 核数自适应，默认 4
if [ -z "${UV_THREADPOOL_SIZE:-}" ]; then
  CPU_CORES=$(nproc 2>/dev/null || echo 4)
  if [ "$CPU_CORES" -gt 8 ]; then
    UV_THREADPOOL_SIZE=8
  else
    UV_THREADPOOL_SIZE=$CPU_CORES
  fi
  export UV_THREADPOOL_SIZE
fi
echo "[build] UV_THREADPOOL_SIZE=$UV_THREADPOOL_SIZE"

# ─── 缓存策略：增量构建（关键优化） ──────────────────
# 之前每次 rm -rf .next → 缓存全丢 → 从零编译 → 慢+卡
# 现在：保留 webpack 缓存，只清可能出问题的部分
# 同时做缓存有效性校验：lockfile 没变 → 安全复用
CACHE_VALID=true

# 检查 lockfile 变化
LOCK_HASH_FILE=".next/.cache-lock-hash"
CURRENT_LOCK_HASH=$(md5sum pnpm-lock.yaml 2>/dev/null | awk '{print $1}' || echo "")

if [ -d ".next" ]; then
  if [ -f "$LOCK_HASH_FILE" ]; then
    CACHED_LOCK_HASH=$(cat "$LOCK_HASH_FILE" 2>/dev/null || echo "")
    if [ "$CURRENT_LOCK_HASH" != "$CACHED_LOCK_HASH" ]; then
      echo "[build] lockfile 变化，清理构建缓存（保留 .next/cache/webpack 加速增量）"
      rm -rf .next/standalone .next/server .next/static 2>/dev/null || true
      # 保留 webpack 缓存，加快增量编译
      CACHE_VALID=false
    else
      echo "[build] lockfile 未变，使用增量构建缓存"
    fi
  else
    echo "[build] 无缓存校验记录，清理旧构建产物"
    rm -rf .next/standalone .next/server .next/static 2>/dev/null || true
    CACHE_VALID=false
  fi
else
  echo "[build] 无 .next 目录，全新构建"
  CACHE_VALID=false
fi

# 部署环境下不清理 pnpm store（缓存加速后续安装）
if [ "${COZE_PROJECT_ENV:-}" != "PROD" ]; then
  echo "[build] 非生产环境：清理过期 pnpm 缓存..."
  pnpm store prune 2>&1 || true
fi

# ─── 安装依赖 ──────────────────────────────────────────
echo "[build] 安装依赖..."
DEPS_START=$(date +%s)
if [ -d "node_modules" ] && [ -f "node_modules/.pnpm/lock.yaml" ] && $CACHE_VALID; then
  echo "[build] node_modules 完整且缓存有效，跳过安装"
else
  # 优先使用 lockfile 确定版本（快速+省内存）
  if pnpm install --prefer-frozen-lockfile --prefer-offline 2>&1 | tail -5; then
    echo "[build] 依赖安装完成 (frozen lockfile)"
  else
    echo "[build] frozen lockfile 失败，回退到普通安装..."
    pnpm install --prefer-offline 2>&1 | tail -10
    echo "[build] 依赖安装完成 (普通模式)"
  fi
fi
DEPS_END=$(date +%s)
echo "[build] 依赖安装耗时 $((DEPS_END - DEPS_START)) 秒"

# 非生产环境清理冗余文件（省磁盘）
if [ "${COZE_PROJECT_ENV:-}" != "PROD" ]; then
  echo "[build] 清理冗余文件..."
  rm -rf node_modules/.pnpm/*/node_modules/*.md 2>/dev/null || true
  rm -rf node_modules/.pnpm/*/node_modules/CHANGELOG* 2>/dev/null || true
  rm -rf node_modules/.pnpm/*/node_modules/LICENSE* 2>/dev/null || true
  rm -rf node_modules/.pnpm/*/node_modules/.github 2>/dev/null || true
  rm -rf node_modules/.pnpm/*/node_modules/docs 2>/dev/null || true
  rm -rf node_modules/.pnpm/*/node_modules/test* 2>/dev/null || true
  rm -rf node_modules/.pnpm/*/node_modules/__tests__ 2>/dev/null || true
fi

# Prisma: generate client before build when the CLI is present.  Use
# `pnpm exec` instead of `pnpm prisma` so pnpm does not look for a package
# script named "prisma" and emit a misleading deploy warning.
if [ -x "node_modules/.bin/prisma" ]; then
  echo "[build] Generating Prisma client..."
  pnpm exec prisma generate 2>&1 | tail -2 || true
else
  echo "[build] Prisma CLI not installed, skipping client generation."
fi

# ─── Next.js 构建 ──────────────────────────────────────
echo "[build] 开始 Next.js 构建 (audited webpack mode)..."
BUILD_PHASE_START=$(date +%s)

# 带进度输出的构建（每 30 秒打一行心跳，防止平台以为卡死）
# 同时将完整输出保留到日志
BUILD_LOG="/tmp/next-build-$$.log"
pnpm next build --webpack > "$BUILD_LOG" 2>&1 &
BUILD_PID=$!

# 心跳监控：每 30 秒输出一次进度
while kill -0 "$BUILD_PID" 2>/dev/null; do
  sleep 30
  if kill -0 "$BUILD_PID" 2>/dev/null; then
    # 取最后 2 行有价值的输出
    LAST_LINES=$(tail -5 "$BUILD_LOG" 2>/dev/null | grep -v '^$' | tail -2 || echo "")
    echo "[build] 构建中... (已运行 $(( ($(date +%s) - BUILD_PHASE_START) ))s) 最近输出: $(echo "$LAST_LINES" | tr '\n' ' ' | cut -c1-200)"
  fi
done

# 等待构建结束并获取退出码。脚本启用了 set -e；如果直接 wait，
# Next.js 一旦失败，shell 会在打印日志前退出，真正的编译错误就会丢失。
set +e
wait "$BUILD_PID"
BUILD_EXIT=$?
set -e

# 输出构建日志尾部
echo "[build] 构建日志尾部:"
tail -20 "$BUILD_LOG" 2>/dev/null || true
rm -f "$BUILD_LOG"

if [ "$BUILD_EXIT" -ne 0 ]; then
  echo "[build] ❌ 构建失败 (exit code: $BUILD_EXIT)"
  exit $BUILD_EXIT
fi

# 写入 lockfile 哈希，下次增量构建校验
mkdir -p .next
echo "$CURRENT_LOCK_HASH" > "$LOCK_HASH_FILE"

BUILD_END=$(date +%s)
echo "[build] ✅ 构建完成，总耗时 $((BUILD_END - BUILD_START)) 秒"
echo "[build]   - 依赖安装: $((DEPS_END - DEPS_START))s"
echo "[build]   - Next.js 编译: $((BUILD_END - BUILD_PHASE_START))s"

# Next.js standalone 运行时不会自动从项目根目录读取 .next/static。
# 这里把静态 chunk 与 public 静态资源补入 .next/standalone，
# 防止服务器 PM2 直接运行 standalone/server.js 后出现前端资源 404、页面空白或交互卡死。
if [ -f "scripts/prepare-next-standalone-assets.mjs" ]; then
  echo "[build] 准备 standalone 静态资源..."
  node scripts/prepare-next-standalone-assets.mjs --service web
fi

# ─── 构建智音工坊（开发环境才做） ──────────────────────
VOICE_PLATFORM_DIR="${COZE_WORKSPACE_PATH}/voice-platform"
if [ -d "$VOICE_PLATFORM_DIR" ] && [ -f "$VOICE_PLATFORM_DIR/package.json" ]; then
  if [ "${COZE_PROJECT_ENV:-}" = "DEV" ]; then
    echo "[build] 开发环境：构建智音工坊 (voice-platform)..."
    (cd "$VOICE_PLATFORM_DIR" && \
     [ ! -d "node_modules" ] && pnpm install 2>&1 | tail -3
     pnpm exec prisma generate 2>&1 | tail -1
     pnpm build 2>&1 | tail -5
    ) || true
    echo "[build] 智音工坊构建完成"
  else
    echo "[build] 部署环境：跳过 voice-platform 构建（服务器端按需构建）"
  fi
fi

echo "[build] =========================================================="
echo "[build] 全部完成 $(date '+%Y-%m-%d %H:%M:%S')"
echo "[build] =========================================================="
