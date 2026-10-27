#!/usr/bin/env bash
# Starts the expressCart work copy (port 1111) with sandbox credentials written into its local, gitignored
# config/payment/config/paypal.json (mode 600, under out/). Mongo: docker cp-mongo on 127.0.0.1:27018.
set -e
H=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$H/../../.." && pwd)
APP="$ROOT/out/work/${1:-expressCart}"
set -a; . "$ROOT/.env"; set +a
cd "$APP"
umask 077
node -e '
const fs=require("fs");const p="config/payment/config/paypal.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));
c.mode="sandbox";c.client_id=process.env.PAYPAL_CLIENT_ID;c.client_secret=process.env.PAYPAL_CLIENT_SECRET;c.paypalCurrency="EUR";
fs.writeFileSync(p,JSON.stringify(c,null,4));'
PP_LOG="$ROOT/out/s3/logs/pp-expressCart.jsonl" MOCK_FILE="$ROOT/out/s3/mock-1111.json" exec node -r "$H/preload.cjs" app.js > "$ROOT/out/s3/logs/app-expressCart.log" 2>&1
