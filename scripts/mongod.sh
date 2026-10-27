#!/usr/bin/env bash
# Standalone MongoDB 6.0 for expressCart (no Docker): binary under out/vendor/mongodb, data under out/mongo,
# 127.0.0.1:27018 only. The expressCart adapter starts it on demand; this script fetches, starts, stops or checks it.
#   scripts/mongod.sh fetch|start|stop|status
set -euo pipefail
cd "$(dirname "$0")/.."
V=6.0.24; T=mongodb-linux-x86_64-ubuntu2204-$V
BIN=out/vendor/mongodb/$T/bin/mongod
case "${1:-status}" in
  fetch)
    mkdir -p out/vendor/mongodb && cd out/vendor/mongodb
    curl -sSLo m.tgz "https://fastdl.mongodb.org/linux/$T.tgz"
    echo "$(curl -sSL "https://fastdl.mongodb.org/linux/$T.tgz.sha256" | cut -d' ' -f1)  m.tgz" | sha256sum -c -
    tar xzf m.tgz && rm m.tgz ;;
  start)
    mkdir -p out/mongo/data
    "$BIN" --fork --dbpath out/mongo/data --logpath out/mongo/mongod.log --port 27018 --bind_ip 127.0.0.1 ;;
  stop)
    "$BIN" --shutdown --dbpath out/mongo/data ;;
  status)
    timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/27018" 2>/dev/null && echo "mongod up on 127.0.0.1:27018" || echo "mongod not running" ;;
esac
