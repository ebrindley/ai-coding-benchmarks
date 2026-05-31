#!/usr/bin/env bash
set -euo pipefail

count="$(find src/main/java/com/example/service -maxdepth 1 -type f -name '*Service.java' ! -name 'OrderService.java' | wc -l | tr -d ' ')"

if [[ "$count" -lt 3 ]]; then
  echo "[SERVICE_COUNT] expected >= 3 extracted services, got $count" >&2
  exit 31
fi

echo "[OK] extracted service count: $count"

