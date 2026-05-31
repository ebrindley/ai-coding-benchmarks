#!/usr/bin/env bash
set -euo pipefail

if git diff --name-only | grep -q '^src/test/'; then
  echo "[TEST_EDITS] test files were modified" >&2
  exit 11
fi

echo "[OK] no test edits"

