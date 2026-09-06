#!/usr/bin/env bash
# Only the benchmark's own run directory and processes are managed here.
set -euo pipefail
action=$1
run_id=$2
[[ "$run_id" =~ ^[a-z0-9-]+$ ]] || exit 2
root=/var/tmp/projectx-repair-benchmark
run=$root/runs/$run_id
cache=$root/cache
if [[ "$action" == logs ]]; then
  for name in node mysql nginx-error provider npm pip; do
    if [[ -f "$run/$name.log" ]]; then cp "$run/$name.log" "$3/wsl-$name.log"; fi
  done
  exit 0
fi
if [[ "$action" == stop ]]; then
  if [[ -f "$run/nginx.pid" && -f "$run/nginx.conf" ]]; then nginx -c "$run/nginx.conf" -s stop 2>/dev/null || true; fi
  for entry in /proc/[0-9]*/environ; do
    if [[ -r "$entry" ]] && tr '\0' '\n' < "$entry" 2>/dev/null | grep -qx "PROJECTX_BENCH_RUN=$run_id"; then
      pid=${entry#/proc/}; pid=${pid%/environ}
      [[ "$pid" != "$$" ]] && kill "$pid" 2>/dev/null || true
    fi
  done
  for name in node ai nginx mysql; do
    if [[ -f "$run/$name.pid" ]]; then
      pid=$(cat "$run/$name.pid")
      if [[ "$pid" =~ ^[0-9]+$ && -r /proc/$pid/environ ]] && tr '\0' '\n' < /proc/$pid/environ | grep -qx "PROJECTX_BENCH_RUN=$run_id"; then
        kill "$pid" 2>/dev/null || true
      fi
    fi
  done
  if [[ -f "$run/server/llmclient/.env" ]]; then rm -f "$run/server/llmclient/.env"; fi
  exit 0
fi
if [[ "$action" == probe ]]; then
  cd "$run/server"
  export PROJECTX_MARIADB_HOST=127.0.0.1 PROJECTX_MARIADB_PORT=3397 PROJECTX_MARIADB_USER=root PROJECTX_MARIADB_DATABASE=projectx_bench PROJECTX_MARIADB_PASSWORD=benchmark-database-only
  export PYTHONPATH="$run/server"
  exec "$cache/venv/bin/python" "$3" "$4"
fi
[[ "$action" == start ]] || exit 2
package=$3
source=$4
probe_dir=$5
mkdir -p "$run" "$cache"
export PROJECTX_BENCH_RUN=$run_id
if ! command -v mariadbd >/dev/null || ! command -v nginx >/dev/null || ! python3 -m venv --help >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y mariadb-server nginx python3-venv curl xz-utils fonts-noto-cjk build-essential
fi
if [[ ! -x "$cache/node/bin/node" ]]; then
  curl -fL --retry 3 https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz -o "$cache/node.tar.xz"
  mkdir -p "$cache/node"
  tar -xJf "$cache/node.tar.xz" --strip-components=1 -C "$cache/node"
fi
export PATH="$cache/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cp -r "$package" "$run/server"
# Packaging is tested before this explicit fixture supplement, which allows
# independent Python probes even when the old deployment omitted llmclient.
if [[ ! -d "$run/server/llmclient" ]]; then cp -r "$source/llmclient" "$run/server/llmclient"; fi
dep_hash=$(sha256sum "$run/server/package.json" | cut -d' ' -f1)
deps=$cache/deps-$dep_hash
if [[ ! -f "$deps/ready" ]]; then
  mkdir -p "$deps"
  cp "$run/server/package.json" "$deps/package.json"
  (cd "$deps" && npm_config_nodedir="$cache/node" npm install --omit=dev --no-audit --no-fund) > "$run/npm.log" 2>&1
  touch "$deps/ready"
fi
ln -s "$deps/node_modules" "$run/server/node_modules"
if [[ ! -x "$cache/venv/bin/python" ]]; then python3 -m venv "$cache/venv"; fi
req_hash=$(sha256sum "$run/server/llmclient/requirements.txt" | cut -d' ' -f1)
if [[ ! -f "$cache/requirements-$req_hash" ]]; then
  "$cache/venv/bin/python" -m pip install -r "$run/server/llmclient/requirements.txt" > "$run/pip.log" 2>&1
  touch "$cache/requirements-$req_hash"
fi
if [[ -f "$probe_dir/real-ai.env" ]]; then cp "$probe_dir/real-ai.env" "$run/server/llmclient/.env"; chmod 600 "$run/server/llmclient/.env"; fi
mkdir -p "$run/mysql"
mariadb-install-db --no-defaults --datadir="$run/mysql" --auth-root-authentication-method=normal > "$run/mysql-init.log" 2>&1
mariadbd --no-defaults --user=root --datadir="$run/mysql" --bind-address=127.0.0.1 --port=3397 --socket="$run/mysql.sock" --pid-file="$run/mysql.pid" --log-error="$run/mysql.log" &
for attempt in {1..60}; do [[ -S "$run/mysql.sock" ]] && mariadb --no-defaults --socket="$run/mysql.sock" -uroot -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
mariadb --no-defaults --socket="$run/mysql.sock" -uroot -e 'CREATE DATABASE projectx_bench CHARACTER SET utf8mb4'
mariadb --no-defaults --socket="$run/mysql.sock" -uroot -e "ALTER USER 'root'@'localhost' IDENTIFIED BY 'benchmark-database-only'"
cat > "$run/nginx.conf" <<NGINX
env PROJECTX_BENCH_RUN;
pid $run/nginx.pid;
error_log $run/nginx-error.log;
events { worker_connections 128; }
http { access_log $run/nginx-access.log; client_max_body_size 100m;
 server { listen 127.0.0.1:5291; location / { proxy_pass http://127.0.0.1:5290; proxy_set_header Host \$http_host; proxy_read_timeout 300s; proxy_buffering off; } } }
NGINX
nginx -c "$run/nginx.conf"
cd "$run/server"
export PORT=5290 PROJECTX_AUTH_ENFORCE=1 PROJECTX_ENABLE_SCANNER=0 PROJECTX_ENABLE_SCANNER_CLIENT_API=1
export PROJECTX_MARIADB_HOST=127.0.0.1 PROJECTX_MARIADB_PORT=3397 PROJECTX_MARIADB_USER=root PROJECTX_MARIADB_DATABASE=projectx_bench PROJECTX_MARIADB_PASSWORD=benchmark-database-only
export PROJECTX_DB_PATH="$run/server/data/projectx.db" ANSWER_CARD_DATA_DIR="$run/server/data/answer-card" ANSWER_CARD_CLIENT_DIST="$run/server/dist/web"
export LLMCLIENT_URL=http://127.0.0.1:8791 LLMCLIENT_PYTHON="$cache/venv/bin/python"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
# Deterministic provider fixture: no real key, no billable requests by default.
if [[ ! -f llmclient/.env ]]; then
  export OPENAI_API_KEY=benchmark-fixture-only OPENAI_BASE_URL=http://127.0.0.1:5293
  "$cache/venv/bin/python" "$probe_dir/provider-stub.py" "$probe_dir/fixture.json" > "$run/provider.log" 2>&1 &
fi
id projectx-bench >/dev/null 2>&1 || useradd --system --create-home --home-dir "$cache/home" projectx-bench
mkdir -p "$run/home"
chown projectx-bench "$run/home"
usermod --home "$run/home" projectx-bench
chown -R projectx-bench "$run/server"
runuser -u projectx-bench -- node dist/server/index.mjs > "$run/node.log" 2>&1 &
echo $! > "$run/node.pid"
echo "BENCH_RUNTIME_READY $run"
wait "$(cat "$run/node.pid")"
