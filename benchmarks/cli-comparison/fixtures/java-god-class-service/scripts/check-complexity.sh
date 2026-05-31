#!/usr/bin/env bash
set -euo pipefail

# Minimal proxy metric: ensure OrderService is smaller than 300 lines after refactor.
lines="$(wc -l < src/main/java/com/example/service/OrderService.java | tr -d ' ')"
if [[ "$lines" -gt 300 ]]; then
  echo "[ORDER_SERVICE_TOO_LARGE] OrderService.java has $lines lines (> 300)" >&2
  exit 51
fi

echo "[OK] OrderService size proxy: $lines"

