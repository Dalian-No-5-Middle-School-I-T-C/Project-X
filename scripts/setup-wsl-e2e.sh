#!/usr/bin/env bash
set -euo pipefail
root=/var/tmp/projectx-e2e-20260905
repo=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$root/node-v22.22.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
printf '[mysqld]\nport=3308\n' > /etc/mysql/mariadb.conf.d/99-projectx-e2e.cnf
service mariadb start
mariadb <<'SQL'
CREATE DATABASE IF NOT EXISTS projectx_e2e_20260905 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'projectx_e2e'@'127.0.0.1' IDENTIFIED BY 'Local-E2e-Only-2026';
GRANT ALL ON projectx_e2e_20260905.* TO 'projectx_e2e'@'127.0.0.1';
SQL
cp "$repo/dist/server/index.mjs" "$root/server/dist/server/index.mjs"
cp "$repo/llmclient/.env" "$root/server/llmclient/.env"
chmod 600 "$root/server/llmclient/.env"
cd "$root/server"
python3 -m venv .venv
.venv/bin/python -m pip install -r llmclient/requirements.txt > "$root/pip-install.log" 2>&1
cat > "$root/run-server.sh" <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
cd /var/tmp/projectx-e2e-20260905/server
export PATH=/var/tmp/projectx-e2e-20260905/node-v22.22.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
export PORT=5187 PROJECTX_AUTH_ENFORCE=1 PROJECTX_ENABLE_SCANNER=0 PROJECTX_ENABLE_SCANNER_CLIENT_API=1
export PROJECTX_MARIADB_HOST=127.0.0.1 PROJECTX_MARIADB_PORT=3308 PROJECTX_MARIADB_USER=projectx_e2e
export PROJECTX_MARIADB_PASSWORD=Local-E2e-Only-2026 PROJECTX_MARIADB_DATABASE=projectx_e2e_20260905
export PROJECTX_DB_PATH=/var/tmp/projectx-e2e-20260905/server/data/projectx.db
export ANSWER_CARD_DATA_DIR=/var/tmp/projectx-e2e-20260905/server/data/answer-card
export ANSWER_CARD_CLIENT_DIST=/var/tmp/projectx-e2e-20260905/server/dist/web
export LLMCLIENT_URL=http://127.0.0.1:8768
export LLMCLIENT_PYTHON=/var/tmp/projectx-e2e-20260905/server/.venv/bin/python
exec node dist/server/index.mjs
RUN
chmod +x "$root/run-server.sh"
cat > "$root/nginx.conf" <<'NGINX'
pid /var/tmp/projectx-e2e-20260905/nginx.pid;
error_log /var/tmp/projectx-e2e-20260905/nginx-error.log;
events { worker_connections 128; }
http {
  access_log /var/tmp/projectx-e2e-20260905/nginx-access.log;
  client_max_body_size 100m;
  server {
    listen 5189;
    location / {
      proxy_pass http://127.0.0.1:5187;
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 300s;
      proxy_buffering off;
    }
  }
}
NGINX
nginx -t -c "$root/nginx.conf"
echo 'WSL isolated deployment prepared'
