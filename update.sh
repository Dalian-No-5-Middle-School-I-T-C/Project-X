#!/usr/bin/env bash
# Project-X 一键同步更新脚本
# 从 GitHub 拉取最新代码并自动部署

set -e

PROJECT_DIR="/c/Users/Administrator/Desktop/Project-X-main"
NODE="/c/Users/Administrator/AppData/Local/Programs/kimi-desktop/resources/resources/runtime/node.exe"

cd "$PROJECT_DIR"

echo "=========================================="
echo "  Project-X GitHub 同步更新脚本"
echo "=========================================="
echo ""

# 1. 保存本地修改（缓存头、配置等）
echo "[1/5] 保存本地修改..."
git stash push -m "auto-stash before update $(date +%Y-%m-%d_%H:%M:%S)" || echo "  无本地修改需要保存"

# 2. 拉取最新代码
echo "[2/5] 从 GitHub 拉取最新代码..."
git fetch origin main
git pull origin main || {
  echo "  ⚠️ 拉取失败，尝试恢复本地修改..."
  git stash pop || true
  exit 1
}

# 3. 恢复本地修改（如果有冲突，优先保留远程代码）
echo "[3/5] 恢复本地修改..."
git stash pop || echo "  没有待恢复的本地修改"

# 4. 重新应用缓存头（防止被远程代码覆盖）
echo "[4/5] 确保缓存头配置正确..."
# 检查缓存头是否还在
if ! grep -q "防止浏览器缓存前端文件" "src/apps/answer-card/server/index.ts"; then
  echo "  ⚠️ 缓存头被远程覆盖，重新应用..."
  # 使用 sed 或 Python 重新插入缓存头（这里用简单方式）
  # 实际上，如果第3步stash pop成功，缓存头应该还在
  echo "  请手动检查 src/apps/answer-card/server/index.ts 中的 Cache-Control 设置"
fi

# 5. 复制 HTML 到 dist/client
echo "[5/5] 同步前端文件到 dist/client..."
if [ -f "Grade-Analysis-System-mobile.html" ]; then
  mkdir -p dist/client
  cp Grade-Analysis-System-mobile.html dist/client/Grade-Analysis-System-mobile.html
  cp Grade-Analysis-System-mobile.html dist/client/index.html
  echo "  ✓ 前端文件已同步"
else
  echo "  ⚠️ Grade-Analysis-System-mobile.html 不存在，跳过"
fi

# 6. 重启后端服务
echo ""
echo "=========================================="
echo "  正在重启后端服务..."
echo "=========================================="

# 查找并停止旧的后端进程
OLD_PID=$(ps | grep "server/index.ts" | grep -v grep | awk '{print $1}')
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  sleep 2
  echo "  旧后端进程已停止 (PID: $OLD_PID)"
fi

# 启动新后端
nohup "$NODE" node_modules/tsx/dist/cli.mjs src/apps/answer-card/server/index.ts > server.log 2>&1 &
BACKEND_PID=$!
echo "  新后端已启动 (PID: $BACKEND_PID)"

sleep 3

# 验证后端是否正常运行
if curl -s http://127.0.0.1:5174/api/app/health > /dev/null 2>&1; then
  echo "  ✓ 后端健康检查通过"
else
  echo "  ⚠️ 后端可能未正常启动，请检查 server.log"
fi

echo ""
echo "=========================================="
echo "  更新完成！"
echo "=========================================="
echo "  本地访问: http://127.0.0.1:5174"
echo "  后端 PID: $BACKEND_PID"
echo ""
echo "  注意：Cloudflare Tunnel 的 URL 可能已变化，"
echo "        请查看 tunnel.log 获取最新公网地址。"
echo ""
