#!/usr/bin/env bash
set -e

cd "/c/Users/Administrator/Desktop/Project-X-main"

NODE="/c/Users/Administrator/AppData/Local/Programs/kimi-desktop/resources/resources/runtime/node.exe"

# 启动后端服务（后台）
echo "[1/2] 启动 Project-X 后端服务..."
nohup "$NODE" "node_modules/tsx/dist/cli.mjs" "src/apps/answer-card/server/index.ts" > server.log 2>&1 &
BACKEND_PID=$!
echo "  后端 PID: $BACKEND_PID"

sleep 4

# 启动 Cloudflare Tunnel（后台）
echo "[2/2] 启动 Cloudflare Tunnel..."
nohup ./cloudflared.exe tunnel --url http://127.0.0.1:5174 > tunnel.log 2>&1 &
TUNNEL_PID=$!
echo "  隧道 PID: $TUNNEL_PID"

sleep 3

echo ""
echo "========================================="
echo "  Project-X 服务已启动！"
echo "  本地访问: http://127.0.0.1:5174"
echo "  查看 tunnel.log 获取公网 URL"
echo "========================================="
echo ""
echo "  后端 PID: $BACKEND_PID"
echo "  隧道 PID: $TUNNEL_PID"
echo ""
echo "  停止服务: kill $BACKEND_PID $TUNNEL_PID"
echo ""
