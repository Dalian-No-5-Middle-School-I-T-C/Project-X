#!/usr/bin/env bash
# Run as root (or with socket-authenticated MariaDB administration privileges).
set -euo pipefail

db=${MARIADB_APP_DB:-projectx}
user=${MARIADB_APP_USER:-projectx_app}
password=${MARIADB_APP_PASSWORD:-}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
schema=${MARIADB_SCHEMA_PATH:-"$root/dist/server/schema.mariadb.sql"}
if [[ ! -f $schema && -z ${MARIADB_SCHEMA_PATH:-} ]]; then schema="$root/src/server/db/schema.mariadb.sql"; fi
[[ -r $schema ]] || { echo "Missing MariaDB schema: $schema" >&2; exit 1; }
[[ $db =~ ^[a-zA-Z0-9_]+$ && $user =~ ^[a-zA-Z0-9_]+$ ]] || { echo 'Use letters, digits or underscores for database and user names.' >&2; exit 1; }
client=$(command -v mariadb || command -v mysql)
if [[ -z $password ]]; then
  existing=$("$client" -u root -NB -e "SELECT COUNT(*) FROM mysql.user WHERE User='$user' AND Host IN ('127.0.0.1','localhost')")
  [[ $existing == 0 ]] || { echo 'Supply the existing MARIADB_APP_PASSWORD to reuse this account.' >&2; exit 1; }
  password=$(openssl rand -hex 24)
fi
# Scope grants to the literal database name, including underscores.
grant_db=${db//_/\\_}
literal=${password//\'/\'\'}
"$client" -u root <<SQL
SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';
CREATE DATABASE IF NOT EXISTS \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$user'@'127.0.0.1' IDENTIFIED BY '$literal';
CREATE USER IF NOT EXISTS '$user'@'localhost' IDENTIFIED BY '$literal';
GRANT ALL PRIVILEGES ON \`$grant_db\`.* TO '$user'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`$grant_db\`.* TO '$user'@'localhost';
SQL
# Import with the application account. The distributed schema also supports standalone use.
sed -e "/^CREATE DATABASE IF NOT EXISTS projectx$/,/;/d" -e '/^USE projectx;$/d' "$schema" |
    MYSQL_PWD="$password" "$client" --protocol=tcp -h 127.0.0.1 -u "$user" "$db"
echo "MariaDB schema ready in $db for $user on 127.0.0.1:3306."
if [[ -z ${MARIADB_APP_PASSWORD:-} ]]; then printf 'Generated application password: %s\n' "$password"; fi
