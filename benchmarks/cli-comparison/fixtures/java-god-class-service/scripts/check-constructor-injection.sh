#!/usr/bin/env bash
set -euo pipefail

# This fixture doesn't use Spring; treat "constructor injection" as "no static singletons" for extracted services.
if grep -R -n -E 'static[[:space:]]+final[[:space:]]+.*Service' src/main/java/com/example/service/*.java >/dev/null 2>&1; then
  echo "[STATIC_SERVICE] avoid static service singletons" >&2
  exit 41
fi

echo "[OK] no static service singletons detected"

