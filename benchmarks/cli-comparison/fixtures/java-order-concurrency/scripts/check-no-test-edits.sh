#!/usr/bin/env bash
set -euo pipefail

# Fail if any JUnit test file was modified. Bug-fix must be proven by the shipped
# tests, not by editing them. Matches src/test/**, *Test.java, and *Tests.java.
changed="$(git diff --name-only; git diff --cached --name-only)"

if echo "$changed" | grep -Eq '(^|/)src/test/|Test\.java$|Tests\.java$'; then
  echo "[TEST_EDITS] test files were modified" >&2
  echo "$changed" | grep -E '(^|/)src/test/|Test\.java$|Tests\.java$' >&2 || true
  exit 11
fi

echo "[OK] no test edits"
