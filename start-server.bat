@echo off
chcp 65001 >nul
cd /d "C:\Users\Administrator\Desktop\Project-X-main"

:: 启动后端服务
echo [1/2] 正在启动 Project-X 后端服务...
start "Project-X Backend" "C:\Users\Administrator\AppData\Local\Programs\kimi-desktop\resources\resources\runtime\node.exe" "node_modules\tsx\dist\cli.mjs" "src\apps\answer-card\server\index.ts"

:: 等待后端启动
timeout /t 4 >nul

:: 启动 Cloudflare Tunnel
echo [2/2] 正在启动 Cloudflare Tunnel...
start "Cloudflare Tunnel" "C:\Users\Administrator\Desktop\Project-X-main\cloudflared.exe" "tunnel" "--url" "http://127.0.0.1:5174"

timeout /t 3 >nul
echo.
echo =========================================
echo  Project-X 服务已启动！
echo  请查看 Cloudflare Tunnel 窗口获取公网 URL
echo  本地访问: http://127.0.0.1:5174
echo =========================================
echo.
pause
