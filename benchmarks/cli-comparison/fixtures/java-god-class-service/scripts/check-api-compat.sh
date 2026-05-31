#!/usr/bin/env bash
set -euo pipefail

baseline="baseline/order-service-public-api.txt"
srcFile="src/main/java/com/example/service/OrderService.java"

if [[ ! -f "$baseline" ]]; then
  echo "[MISSING_BASELINE] $baseline not found" >&2
  exit 21
fi
if [[ ! -f "$srcFile" ]]; then
  echo "[MISSING_SOURCE] $srcFile not found" >&2
  exit 22
fi

current="$(mktemp)"

python3 - "$srcFile" >"$current" <<'PY'
import re
import sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding="utf-8")
method_re = re.compile(r"^\s*public\s+(?!class\b)(?!OrderService\s*\()\S+(?:\s*<[^>]+>)?\s+(\w+)\s*\(([^)]*)\)\s*\{", re.M)

def norm_type(part: str) -> str:
  part = part.strip()
  if not part:
    return ""
  part = re.sub(r"@\w+(\([^)]*\))?\s*", "", part)
  token = part.split()[0]
  if token == "String":
    return "java.lang.String"
  return token

out = []
for name, params in method_re.findall(src):
  params = params.strip()
  if not params:
    out.append(f"{name}()")
    continue
  types = [norm_type(p) for p in params.split(",")]
  out.append(f"{name}({','.join(types)})")

for line in sorted(out):
  print(line)
PY

if ! diff -u <(sort "$baseline") "$current" >/dev/null; then
  echo "[API_CHANGED] public OrderService API does not match baseline" >&2
  diff -u <(sort "$baseline") "$current" >&2 || true
  rm -f "$current"
  exit 23
fi

rm -f "$current"
echo "[OK] API unchanged"

