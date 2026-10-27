#!/usr/bin/env bash
# Usage: run-scs.sh <app dir> <port> <stub port> [DEMO=1|0] ; starts Printful stub + app with the harness preload.
set -e
H=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$H/../../.." && pwd)
APP=$1; PORT=$2; SP=$3; DEMOV=${4:-1}
set -a; . "$ROOT/.env"; set +a
NAME=$(basename "$APP")-$PORT
node "$H/printful-stub.mjs" "$SP" > "$ROOT/out/s3/logs/stub-$NAME.log" 2>&1 &
sleep 0.5
cd "$APP"
if [ "$DEMOV" = 1 ]; then export DEMO=1; else unset DEMO; fi
PRINTFUL_STUB_PORT=$SP PORT=$PORT PP_LOG="$ROOT/out/s3/logs/pp-$NAME.jsonl" MOCK_FILE="$ROOT/out/s3/mock-$PORT.json" \
  exec node -r "$H/preload.cjs" server.js > "$ROOT/out/s3/logs/app-$NAME.log" 2>&1
