#!/usr/bin/env bash
# ============================================================
# Project-X MariaDB 一键建库建表脚本
# 适用: Ubuntu 24 / Debian 12 / CentOS 8+ (需 MariaDB 10.11)
#
# 用法:
#   sudo bash scripts/setup-mariadb.sh
#     或指定密码:
#   MARIADB_APP_PASSWORD=your_password sudo bash scripts/setup-mariadb.sh
# ============================================================
set -euo pipefail

APP_DB="projectx"
APP_USER="${MARIADB_APP_USER:-projectx_app}"
APP_PASSWORD="${MARIADB_APP_PASSWORD:-}"
SCHEMA_FILE="src/server/db/schema.mariadb.sql"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "================================================"
echo " Project-X MariaDB 一键建库建表"
echo "================================================"

# ── 1. 检查 MariaDB 服务 ──────────────────────
if ! command -v mariadb &>/dev/null && ! command -v mysql &>/dev/null; then
    echo -e "${RED}❌ 未找到 mariadb/mysql 命令。请先安装 MariaDB:${NC}"
    echo "   sudo apt install -y mariadb-server"
    exit 1
fi

MYSQL_CMD="mariadb"
if ! command -v mariadb &>/dev/null; then
    MYSQL_CMD="mysql"
fi

if ! systemctl is-active --quiet mariadb 2>/dev/null && ! systemctl is-active --quiet mysql 2>/dev/null; then
    echo -e "${YELLOW}⚠ MariaDB 未运行，尝试启动...${NC}"
    sudo systemctl start mariadb 2>/dev/null || sudo systemctl start mysql 2>/dev/null || true
    sleep 2
fi

echo -e "${GREEN}✅ MariaDB 服务已运行${NC}"

# ── 2. 生成密码 ────────────────────────────────
if [ -z "$APP_PASSWORD" ]; then
    APP_PASSWORD=$(openssl rand -base64 18 2>/dev/null || date +%s | sha256sum | head -c 18)
    echo -e "${YELLOW}🔑 自动生成密码: ${APP_PASSWORD}${NC}"
    echo "   请妥善保存此密码！"
fi

# ── 3. 创建数据库 ──────────────────────────────
echo ""
echo "📦 创建数据库 ${APP_DB}..."
sudo $MYSQL_CMD -e "CREATE DATABASE IF NOT EXISTS \`${APP_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || \
    $MYSQL_CMD -u root -e "CREATE DATABASE IF NOT EXISTS \`${APP_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo -e "${GREEN}✅ 数据库 ${APP_DB} 已创建${NC}"

# ── 4. 创建用户 ────────────────────────────────
echo ""
echo "👤 创建应用账户 ${APP_USER}..."
# 删除旧用户（如果存在）
sudo $MYSQL_CMD -e "DROP USER IF EXISTS '${APP_USER}'@'127.0.0.1';" 2>/dev/null || \
    $MYSQL_CMD -u root -e "DROP USER IF EXISTS '${APP_USER}'@'127.0.0.1';" 2>/dev/null || true
sudo $MYSQL_CMD -e "DROP USER IF EXISTS '${APP_USER}'@'localhost';" 2>/dev/null || \
    $MYSQL_CMD -u root -e "DROP USER IF EXISTS '${APP_USER}'@'localhost';" 2>/dev/null || true

sudo $MYSQL_CMD -e "CREATE USER '${APP_USER}'@'127.0.0.1' IDENTIFIED BY '${APP_PASSWORD}';" 2>/dev/null || \
    $MYSQL_CMD -u root -e "CREATE USER '${APP_USER}'@'127.0.0.1' IDENTIFIED BY '${APP_PASSWORD}';"
sudo $MYSQL_CMD -e "CREATE USER '${APP_USER}'@'localhost' IDENTIFIED BY '${APP_PASSWORD}';" 2>/dev/null || \
    $MYSQL_CMD -u root -e "CREATE USER '${APP_USER}'@'localhost' IDENTIFIED BY '${APP_PASSWORD}';"

echo -e "${GREEN}✅ 用户 ${APP_USER} 已创建${NC}"

# ── 5. 授权 ─────────────────────────────────────
echo ""
echo "🔑 授权 ${APP_USER} 对 ${APP_DB} 的读写权限..."
sudo $MYSQL_CMD -e "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON \`${APP_DB}\`.* TO '${APP_USER}'@'127.0.0.1';" 2>/dev/null || \
    $MYSQL_CMD -u root -e "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON \`${APP_DB}\`.* TO '${APP_USER}'@'127.0.0.1';"
sudo $MYSQL_CMD -e "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON \`${APP_DB}\`.* TO '${APP_USER}'@'localhost';" 2>/dev/null || \
    $MYSQL_CMD -u root -e "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON \`${APP_DB}\`.* TO '${APP_USER}'@'localhost';"
sudo $MYSQL_CMD -e "FLUSH PRIVILEGES;" 2>/dev/null || \
    $MYSQL_CMD -u root -e "FLUSH PRIVILEGES;"

echo -e "${GREEN}✅ 权限已授予${NC}"

# ── 6. 运行建表 SQL ────────────────────────────
echo ""
echo "📝 运行建表脚本 ${SCHEMA_FILE}..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCHEMA_PATH="${PROJECT_ROOT}/${SCHEMA_FILE}"

if [ ! -f "$SCHEMA_PATH" ]; then
    echo -e "${RED}❌ schema 文件不存在: ${SCHEMA_PATH}${NC}"
    exit 1
fi

# 过滤掉 CREATE DATABASE 整块与 USE 语句（已在上面执行过）
awk 'BEGIN{skip=0} /^CREATE DATABASE/{skip=1; next} skip && /;/{skip=0; next} skip{next} /^USE /{next} {print}' "$SCHEMA_PATH" | \
    sudo $MYSQL_CMD "${APP_DB}" 2>/dev/null || \
    $MYSQL_CMD -u root "${APP_DB}"

echo -e "${GREEN}✅ 数据表已创建${NC}"

# ── 7. 验证 ─────────────────────────────────────
echo ""
TABLE_COUNT=$(sudo $MYSQL_CMD -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${APP_DB}';" 2>/dev/null || \
    $MYSQL_CMD -u root -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${APP_DB}';")
echo -e "${GREEN}✅ 共 ${TABLE_COUNT} 张表创建成功${NC}"

# ── 8. 输出连接信息 ────────────────────────────
echo ""
echo "================================================"
echo -e " ${GREEN}✅ MariaDB 配置完成！${NC}"
echo "================================================"
echo ""
echo "请在服务器启动前设置以下环境变量："
echo ""
echo "  export PROJECTX_MARIADB_HOST=127.0.0.1"
echo "  export PROJECTX_MARIADB_PORT=3306"
echo "  export PROJECTX_MARIADB_USER=${APP_USER}"
echo "  export PROJECTX_MARIADB_PASSWORD=${APP_PASSWORD}"
echo "  export PROJECTX_MARIADB_DATABASE=${APP_DB}"
echo ""
echo "或写入 config.yml（在管理后台「账号设置 → 数据存储」操作）："
echo ""
echo "  database:"
echo "    mode: remote"
echo "    remote:"
echo "      host: 127.0.0.1"
echo "      port: 3306"
echo "      database: ${APP_DB}"
echo "      user: ${APP_USER}"
echo "      password: ${APP_PASSWORD}"
echo ""
echo "如从 SQLite 迁移已有数据："
echo "  npx tsx scripts/migrate-to-mariadb.ts"
echo ""
