#!/usr/bin/env bash
# Ensure MariaDB is running in cloud/dev environments where systemd may be unavailable.
set -euo pipefail

SOCKET_DIR="/run/mysqld"
SOCKET_PATH="${SOCKET_DIR}/mysqld.sock"

if mariadb -e "SELECT 1" &>/dev/null || sudo mariadb -e "SELECT 1" &>/dev/null; then
  exit 0
fi

if ! command -v mariadbd &>/dev/null && ! command -v mysqld &>/dev/null; then
  echo "MariaDB server is not installed. Run: sudo apt install -y mariadb-server mariadb-client"
  exit 1
fi

sudo mkdir -p /var/run/mysqld "${SOCKET_DIR}"
if [ ! -S "${SOCKET_PATH}" ] && [ -S /var/run/mysqld/mysqld.sock ]; then
  sudo ln -sf /var/run/mysqld/mysqld.sock "${SOCKET_PATH}"
fi

if ! pgrep -x mariadbd >/dev/null 2>&1; then
  echo "Starting MariaDB..."
  sudo mysqld_safe \
    --datadir=/var/lib/mysql \
    --pid-file=/var/run/mysqld/mysqld.pid \
    --socket=/var/run/mysqld/mysqld.sock \
    >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    if mariadb -e "SELECT 1" &>/dev/null || sudo mariadb -e "SELECT 1" &>/dev/null; then
      break
    fi
    sleep 1
  done
fi

if ! mariadb -e "SELECT 1" &>/dev/null && ! sudo mariadb -e "SELECT 1" &>/dev/null; then
  echo "MariaDB failed to start."
  exit 1
fi

if [ ! -S "${SOCKET_PATH}" ] && [ -S /var/run/mysqld/mysqld.sock ]; then
  sudo ln -sf /var/run/mysqld/mysqld.sock "${SOCKET_PATH}"
fi
