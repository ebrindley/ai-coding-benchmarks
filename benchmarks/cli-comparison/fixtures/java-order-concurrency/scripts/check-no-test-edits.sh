#!/usr/bin/env bash
set -euo pipefail

# Fail if any JUnit test file was modified. Bug-fix must be proven by the shipped
# tests, not by editing them. Matches src/test/**, *Test.java, and *Tests.java.
# Includes untracked files so an agent cannot slip in a new test file undetected.
changed="$( { git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | sort -u )"

if echo "$changed" | grep -Eq '(^|/)src/test/|Test\.java$|Tests\.java$'; then
  echo "[TEST_EDITS] test files were modified" >&2
  echo "$changed" | grep -E '(^|/)src/test/|Test\.java$|Tests\.java$' >&2 || true
  exit 11
fi

echo "[OK] no test edits"
