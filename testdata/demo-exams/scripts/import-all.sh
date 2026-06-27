#!/usr/bin/env bash
# 演示考试数据一键导入
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MODE="${1:-restore}"
API="${PROJECTX_API_BASE:-http://127.0.0.1:5174}"
ZIP="$ROOT/testdata/demo-exams/backup/projectx-demo.zip"

cd "$ROOT"

case "$MODE" in
  seed)
    echo "==> 写入演示数据到当前数据库"
    npx tsx testdata/demo-exams/scripts/seed.ts
  ;;
  restore)
    if [[ ! -f "$ZIP" ]]; then
      echo "备份包不存在，正在生成..."
      npx tsx testdata/demo-exams/scripts/build-backup.ts
    fi
    echo "==> 通过 API 恢复备份 (需服务已启动)"
    TOKEN=$(curl -sf -X POST "$API/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d '{"identifier":"admin","password":"admin123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
    curl -sf -X POST "$API/api/db/restore" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/zip' \
      --data-binary @"$ZIP"
    echo ""
    echo "恢复完成，建议重启 dev 服务"
  ;;
  build)
    npx tsx testdata/demo-exams/scripts/build-backup.ts
  ;;
  verify)
    npx tsx testdata/demo-exams/scripts/verify.ts
  ;;
  *)
    echo "用法: $0 [seed|restore|build|verify]"
    exit 1
  ;;
esac
