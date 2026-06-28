#!/usr/bin/env bash
# ==============================================================
#  Project-X 一键同步更新脚本
#  用法: ./update.sh [选项]
#
#  选项:
#    --build       拉取后执行 npm run build（默认跳过，直接用 dev 模式）
#    --merge       把 main 合并到当前分支（默认只更新本地 main）
#    --dry-run     仅显示将要执行的操作，不实际执行
# ==============================================================
set -euo pipefail

# ── 配置 ────────────────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT="${PROJECTX_PORT:-5174}"
DO_BUILD=false
DO_MERGE=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --build)   DO_BUILD=true ;;
    --merge)   DO_MERGE=true ;;
    --dry-run) DRY_RUN=true ;;
    *) echo "未知选项: $arg"; exit 1 ;;
  esac
done

# ── 自动探测 Node 可执行文件 ───────────────────────────────
detect_node() {
  # 按优先级尝试
  for candidate in \
    "/c/Program Files/nodejs/node.exe" \
    "$HOME/AppData/Local/Programs/kimi-desktop/resources/resources/runtime/node.exe" \
    "/c/Program Files (x86)/nodejs/node.exe" \
    "node"; do
    if "$candidate" --version &>/dev/null; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

NODE="$(detect_node)"
if [ -z "$NODE" ]; then
  echo "❌ 未找到可用的 Node.js，请安装 Node 22+ 并添加到 PATH"
  exit 1
fi

# 把 Node 目录加到 PATH 以便找到 npm
NODE_DIR="$(dirname "$NODE")"
export PATH="$NODE_DIR:$PATH"

# ── 颜色 ────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
fail()  { echo -e "${RED}[✗]${NC} $*"; }
step()  { echo -e "\n${CYAN}══ $* ══${NC}"; }

# ── 进入项目目录 ────────────────────────────────────────────
cd "$PROJECT_DIR"

echo "================================================="
echo "  Project-X 一键同步更新"
echo "  Node: $NODE ($("$NODE" --version))"
echo "  目录: $PROJECT_DIR"
echo "  端口: $BACKEND_PORT"
echo "================================================="

# ── Step 1: 保存并记录当前状态 ──────────────────────────────
step "1/6  保存工作区状态"
ORIGINAL_BRANCH="$(git branch --show-current)"
STASHED=false

if [ "$DRY_RUN" = true ]; then
  echo "  [dry-run] 当前分支: $ORIGINAL_BRANCH"
else
  # 检查是否有未提交的修改
  if ! git diff-index --quiet HEAD --; then
    git stash push -m "update.sh auto-stash $(date +%Y-%m-%d_%H:%M:%S)" && STASHED=true
    info "已暂存未提交的修改 (git stash)"
  else
    info "工作区干净，无需暂存"
  fi
fi

# ── Step 2: 同步 main 分支 ──────────────────────────────────
step "2/6  从 GitHub 同步 main 分支"

sync_main() {
  # 获取远程最新状态
  git fetch origin main --quiet

  # 判断本地 HEAD 和 origin/main 的关系
  LOCAL_SHA="$(git rev-parse main 2>/dev/null || echo '')"
  REMOTE_SHA="$(git rev-parse origin/main)"

  if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
    info "本地 main 已是最新 ($(echo "$REMOTE_SHA" | head -c 8))"
    return 0
  fi

  # 更新本地 main（不管当前在哪个分支）
  # 方法：用 fetch + 直接移动 ref，不切换分支
  # 但如果本地 main 被 checkout 了，就正常 pull
  if [ "$ORIGINAL_BRANCH" = "main" ]; then
    info "当前在 main 分支，执行 git pull..."
    git pull origin main --ff-only
  else
    info "将 origin/main 快进到本地 main (不切换分支)..."
    git branch -f main origin/main
    info "本地 main 已更新到 $(git rev-parse main | head -c 8)"
  fi
}

if [ "$DRY_RUN" = false ]; then
  sync_main
fi

# ── Step 3: 合并到当前分支 (可选) ──────────────────────────
if [ "$DO_MERGE" = true ] && [ "$ORIGINAL_BRANCH" != "main" ]; then
  step "3/6  将 main 合并到 $ORIGINAL_BRANCH"
  if [ "$DRY_RUN" = false ]; then
    if git merge-base --is-ancestor origin/main HEAD; then
      info "$ORIGINAL_BRANCH 已经包含 main 的所有提交，无需合并"
    else
      if git merge origin/main --no-edit; then
        info "成功将 main 合并到 $ORIGINAL_BRANCH"
      else
        fail "合并冲突！请手动解决后运行 git merge --continue"
        warn "已中止自动流程。解决冲突后手动执行后续步骤。"
        exit 1
      fi
    fi
  fi
elif [ "$ORIGINAL_BRANCH" != "main" ]; then
  step "3/6  跳过合并 (当前分支: $ORIGINAL_BRANCH ≠ main)"
  warn "如需合并 main 到当前分支，使用: git merge origin/main"
  warn "或者运行: ./update.sh --merge"
fi

# ── Step 4: 安装依赖 & 构建 (可选) ──────────────────────────
step "4/6  检查依赖"

if [ "$DRY_RUN" = false ]; then
  if [ ! -d "node_modules" ]; then
    warn "node_modules 不存在，正在安装..."
    npm install --ignore-scripts
    npm rebuild better-sqlite3
  fi

  if grep -q '"zod"' package.json && ! [ -d "node_modules/zod" ]; then
    warn "新依赖 zod 未安装，正在安装..."
    npm install --ignore-scripts
  fi

  if [ "$DO_BUILD" = true ]; then
    info "正在构建 (typecheck + vite + esbuild)..."
    npm run build && info "构建完成"
  fi
fi

# ── Step 5: 构建前端 (仅 dev 模式，不需要完整 build) ────────
step "5/6  同步前端文件"

# 检查 dist/client 是否存在且有内容
if [ -d "dist/client" ] && [ -f "dist/client/index.html" ]; then
  info "dist/client 已存在，跳过前端构建"
elif [ -f "Grade-Analysis-System-mobile.html" ]; then
  # 旧版兼容：用单独的 HTML 作为前端
  warn "使用 Grade-Analysis-System-mobile.html 作为前端 (旧版模式)"
  mkdir -p dist/client
  cp Grade-Analysis-System-mobile.html dist/client/index.html
  info "前端文件已同步"
else
  warn "dist/client 不存在且无独立 HTML，请先运行 npm run build:client"
  warn "后端仍会启动，但前端页面可能不可用。"
fi

# ── Step 6: 重启后端服务 ────────────────────────────────────
step "6/6  重启后端服务"

restart_backend() {
  # 查找占用目标端口的进程 (兼容 Windows Git Bash / Linux / macOS)
  OLD_PID=""

  # 方法 1: 上次运行时保存的 PID 文件
  if [ -f .backend.pid ]; then
    SAVED_PID="$(cat .backend.pid 2>/dev/null || true)"
    if [ -n "$SAVED_PID" ] && kill -0 "$SAVED_PID" 2>/dev/null; then
      OLD_PID="$SAVED_PID"
    fi
  fi

  # 方法 2: 按端口查找 (netstat)
  if [ -z "$OLD_PID" ]; then
    OLD_PID="$(netstat -ano 2>/dev/null | grep ":${BACKEND_PORT}" | grep LISTENING | awk '{print $NF}' | head -1 || true)"
  fi

  # 方法 3: ss (Linux)
  if [ -z "$OLD_PID" ]; then
    OLD_PID="$(ss -tlnp 2>/dev/null | grep ":${BACKEND_PORT}" | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)"
  fi

  if [ -n "$OLD_PID" ]; then
    info "停止旧进程 (PID: $OLD_PID, 端口: $BACKEND_PORT)..."

    # Windows: taskkill, Unix: kill
    if command -v taskkill &>/dev/null; then
      taskkill //PID "$OLD_PID" //F 2>/dev/null || true
    else
      kill "$OLD_PID" 2>/dev/null || true
    fi

    # 等进程退出
    for i in $(seq 1 5); do
      sleep 1
      if ! kill -0 "$OLD_PID" 2>/dev/null; then
        break
      fi
    done

    # 强制杀
    if kill -0 "$OLD_PID" 2>/dev/null; then
      kill -9 "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi

    info "旧进程已停止"
  fi

  # 用 tsx 启动服务 (dev 模式，支持热重载)
  nohup "$NODE" node_modules/tsx/dist/cli.mjs src/apps/answer-card/server/index.ts > server.log 2>&1 &
  BACKEND_PID=$!
  echo "$BACKEND_PID" > .backend.pid
  info "后端已启动 (PID: $BACKEND_PID, 日志: server.log)"

  # 等后端就绪
  for i in $(seq 1 15); do
    sleep 1
    if curl -s "http://127.0.0.1:${BACKEND_PORT}/api/app/health" > /dev/null 2>&1; then
      info "后端健康检查通过 ✓"
      return 0
    fi
    echo -n "."
  done
  echo ""
  warn "后端 15 秒内未就绪，请检查 server.log 末尾 100 行:"
  tail -20 server.log
  return 1
}

if [ "$DRY_RUN" = false ]; then
  restart_backend || true
fi

# ── 恢复本地修改 ────────────────────────────────────────────
if [ "$STASHED" = true ]; then
  step "恢复本地修改"
  if git stash list | grep -q "update.sh auto-stash"; then
    git stash pop && info "已恢复上一次的本地修改" || warn "stash pop 失败，可能有冲突，保留在 stash 中"
  fi
fi

# ── 完成 ────────────────────────────────────────────────────
echo ""
echo "================================================="
echo -e "  ${GREEN}更新完成！${NC}"
echo "================================================="
echo "  本地地址: http://127.0.0.1:${BACKEND_PORT}"
echo "  健康检查: http://127.0.0.1:${BACKEND_PORT}/api/app/health"
echo "  分支状态: $(git branch --show-current) ($(git rev-parse --short HEAD))"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "  ⚠️  这是 dry-run，实际操作未执行。去掉 --dry-run 重新运行。"
fi
