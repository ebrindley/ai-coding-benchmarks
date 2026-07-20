#!/usr/bin/env bash
# Static contract: POST /books must be implemented and tested as HTTP 201 only.
# Rejects generic 2xx / status().isOk() create paths and missing CREATED usage.
set -euo pipefail

CTRL="src/main/java/com/example/BookController.java"
TEST="src/test/java/com/example/BookControllerTest.java"

if [[ ! -f "$CTRL" ]]; then
  echo "[POST_201] missing $CTRL" >&2
  exit 1
fi
if [[ ! -f "$TEST" ]]; then
  echo "[POST_201] missing $TEST" >&2
  exit 1
fi

if ! grep -Eq 'HttpStatus\.CREATED|status\s*\(\s*201\s*\)|\.CREATED' "$CTRL"; then
  echo "[POST_201] BookController must return HTTP 201 (HttpStatus.CREATED) for create" >&2
  exit 1
fi

# createBook test must assert exact 201 / isCreated — not isOk / is2xxSuccessful.
if ! python3 - "$TEST" <<'PY'
from pathlib import Path
import re, sys
src = Path(sys.argv[1]).read_text(encoding="utf-8")
# Isolate createBook test method body roughly
m = re.search(r"void\s+createBook\s*\([^)]*\)\s*throws[^{]*\{", src)
if not m:
    print("createBook test method not found", file=sys.stderr)
    sys.exit(1)
start = m.end()
# naive brace match
depth = 1
i = start
while i < len(src) and depth:
    if src[i] == "{":
        depth += 1
    elif src[i] == "}":
        depth -= 1
    i += 1
body = src[start:i]
if re.search(r"is2xxSuccessful|isOk\s*\(", body):
    print("createBook must not accept generic 2xx/200", file=sys.stderr)
    sys.exit(1)
if not re.search(r"status\(\)\.is\(201\)|status\(\)\.isCreated\s*\(", body):
    print("createBook must assert status().is(201) or status().isCreated()", file=sys.stderr)
    sys.exit(1)
sys.exit(0)
PY
then
  exit 1
fi

echo "[OK] POST /books contract requires HTTP 201"
