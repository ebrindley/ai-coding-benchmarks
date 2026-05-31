#!/usr/bin/env bash
set -euo pipefail

fail=0
while IFS= read -r -d '' file; do
  lines="$(wc -l < "$file" | tr -d ' ')"
  if [[ "$lines" -gt 500 ]]; then
    echo "[CLASS_TOO_LARGE] $file has $lines lines (> 500)" >&2
    fail=1
  fi
done < <(find src/main/java/com/example/service -maxdepth 1 -type f -name '*Service.java' -print0)

if [[ "$fail" -ne 0 ]]; then
  exit 32
fi

echo "[OK] all service classes <= 500 lines"

