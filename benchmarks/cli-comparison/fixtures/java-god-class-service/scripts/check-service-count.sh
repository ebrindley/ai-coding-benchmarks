#!/usr/bin/env bash
# Structural oracle for the god-class refactor.
# Empty or near-empty *Service.java shells must not satisfy the requirement:
# extracted services need real methods, and OrderService must wire them in.
set -euo pipefail

SERVICE_DIR="src/main/java/com/example/service"
ORDER_SERVICE="${SERVICE_DIR}/OrderService.java"

if [[ ! -f "$ORDER_SERVICE" ]]; then
  echo "[SERVICE_COUNT] missing OrderService.java" >&2
  exit 31
fi

# Portable (macOS Bash 3.2): no mapfile.
extracted=()
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  extracted+=("$file")
done < <(
  find "$SERVICE_DIR" -maxdepth 1 -type f -name '*Service.java' ! -name 'OrderService.java' | sort
)

count="${#extracted[@]}"
if [[ "$count" -lt 3 ]]; then
  echo "[SERVICE_COUNT] expected >= 3 extracted services, got $count" >&2
  exit 31
fi

# Count non-empty, non-comment source lines (// and /* */ stripped coarsely).
substance_lines() {
  python3 - "$1" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
lines = []
for line in text.splitlines():
    s = re.sub(r"//.*$", "", line).strip()
    if not s:
        continue
    if s in ("{", "}", "};"):
        continue
    if s.startswith("package ") or s.startswith("import "):
        continue
    lines.append(s)
print(len(lines))
PY
}

public_method_count() {
  python3 - "$1" <<'PY'
import re, sys
from pathlib import Path
src = Path(sys.argv[1]).read_text(encoding="utf-8")
pat = re.compile(
    r"^\s*public\s+(?!class\b)(?:static\s+)?(?![\w.]+\s*\()\S+(?:\s*<[^>]+>)?\s+(\w+)\s*\([^;]*\)\s*\{",
    re.M,
)
print(len(pat.findall(src)))
PY
}

for file in "${extracted[@]}"; do
  base="$(basename "$file" .java)"
  if ! grep -qE "class[[:space:]]+${base}[[:space:]]" "$file"; then
    echo "[SERVICE_COUNT] $file does not declare class ${base}" >&2
    exit 31
  fi

  lines="$(substance_lines "$file")"
  methods="$(public_method_count "$file")"
  # Reject empty/near-empty shells; a real collaborator typically has fields + methods.
  if [[ "$lines" -lt 8 ]]; then
    echo "[SERVICE_COUNT] $file is too thin ($lines substantive lines; need >= 8)" >&2
    exit 31
  fi
  if [[ "$methods" -lt 1 ]]; then
    echo "[SERVICE_COUNT] $file has no public methods (empty shell)" >&2
    exit 31
  fi

  # OrderService must actually use the extracted collaborator (not a dead file).
  if ! grep -qE "${base}" "$ORDER_SERVICE"; then
    echo "[SERVICE_COUNT] OrderService.java does not reference extracted ${base}" >&2
    exit 31
  fi
done

echo "[OK] extracted service count: $count (each substantive and wired into OrderService)"
