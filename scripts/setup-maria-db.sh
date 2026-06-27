#!/usr/bin/env bash
# ============================================================
# Project-X MariaDB one-shot database setup for server package
# Works when executed as root or through sudo on Ubuntu 24/Debian.
#
# Usage:
#   bash sh/setup-mariadb.sh
#   MARIADB_APP_PASSWORD=your_password bash sh/setup-mariadb.sh
# ============================================================
set -euo pipefail

APP_DB="${MARIADB_APP_DB:-projectx}"
APP_USER="${MARIADB_APP_USER:-projectx_app}"
APP_PASSWORD="${MARIADB_APP_PASSWORD:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SCHEMA_PATH="${MARIADB_SCHEMA_PATH:-${PACKAGE_ROOT}/dist/server/schema.mariadb.sql}"

echo "================================================"
echo " Project-X MariaDB setup"
echo "================================================"

if command -v mariadb >/dev/null 2>&1; then
  MYSQL_CMD="mariadb"
elif command -v mysql >/dev/null 2>&1; then
  MYSQL_CMD="mysql"
else
  echo -e "${RED}MariaDB/mysql client not found. Install MariaDB first:${NC}"
  echo "  apt install -y mariadb-server"
  exit 1
fi

if ! systemctl is-active --quiet mariadb 2>/dev/null && ! systemctl is-active --quiet mysql 2>/dev/null; then
  echo -e "${YELLOW}MariaDB is not running; attempting to start it...${NC}"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl start mariadb 2>/dev/null || systemctl start mysql 2>/dev/null || true
  fi
  sleep 2
fi

if ! systemctl is-active --quiet mariadb 2>/dev/null && ! systemctl is-active --quiet mysql 2>/dev/null; then
  echo -e "${RED}MariaDB service is not active.${NC}"
  exit 1
fi

echo -e "${GREEN}MariaDB service is active.${NC}"

if [ -z "$APP_PASSWORD" ]; then
  APP_PASSWORD="$(openssl rand -base64 24 2>/dev/null | tr -d '/+=' | head -c 24 || date +%s | sha256sum | head -c 24)"
  echo -e "${YELLOW}Generated application password. Store it securely.${NC}"
fi

if [ ! -f "$SCHEMA_PATH" ]; then
  echo -e "${RED}Schema file not found: ${SCHEMA_PATH}${NC}"
  exit 1
fi

run_root_sql() {
  "$MYSQL_CMD" -u root "$@"
}

echo ""
echo "Creating database ${APP_DB}..."
run_root_sql -e "CREATE DATABASE IF NOT EXISTS \`${APP_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
echo -e "${GREEN}Database ${APP_DB} is ready.${NC}"

echo ""
echo "Creating application account ${APP_USER}..."
run_root_sql -e "DROP USER IF EXISTS '${APP_USER}'@'127.0.0.1';"
run_root_sql -e "DROP USER IF EXISTS '${APP_USER}'@'localhost';"
run_root_sql -e "CREATE USER '${APP_USER}'@'127.0.0.1' IDENTIFIED BY '${APP_PASSWORD}';"
run_root_sql -e "CREATE USER '${APP_USER}'@'localhost' IDENTIFIED BY '${APP_PASSWORD}';"
echo -e "${GREEN}Application account ${APP_USER} is ready.${NC}"

echo ""
echo "Granting privileges on ${APP_DB}..."
PRIVILEGES="SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES"
run_root_sql -e "GRANT ${PRIVILEGES} ON \`${APP_DB}\`.* TO '${APP_USER}'@'127.0.0.1';"
run_root_sql -e "GRANT ${PRIVILEGES} ON \`${APP_DB}\`.* TO '${APP_USER}'@'localhost';"
run_root_sql -e "FLUSH PRIVILEGES;"
echo -e "${GREEN}Privileges granted.${NC}"

echo ""
echo "Importing schema from ${SCHEMA_PATH}..."
run_root_sql --force < "$SCHEMA_PATH"
echo -e "${GREEN}Schema imported.${NC}"

echo ""
TABLE_COUNT="$(run_root_sql -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${APP_DB}';")"
echo -e "${GREEN}${TABLE_COUNT} tables found in ${APP_DB}.${NC}"

echo ""
echo "================================================"
echo -e " ${GREEN}MariaDB setup complete.${NC}"
echo "================================================"
echo "PROJECTX_MARIADB_HOST=127.0.0.1"
echo "PROJECTX_MARIADB_PORT=3306"
echo "PROJECTX_MARIADB_USER=${APP_USER}"
echo "PROJECTX_MARIADB_PASSWORD=${APP_PASSWORD}"
echo "PROJECTX_MARIADB_DATABASE=${APP_DB}"
