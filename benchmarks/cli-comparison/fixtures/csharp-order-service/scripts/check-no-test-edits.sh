#!/usr/bin/env bash
set -euo pipefail

# Verify that no test files were modified while fixing the bug. C#-aware:
# test files live under tests/ and follow the *Test.cs / *Tests.cs conventions,
# and test projects are named *.Tests.
#
# Exit codes:
#   0  PASS  - no test files modified
#   10 FAIL  - one or more test files modified
#
# Grep-able error IDs: PASS_NO_TEST_EDITS, FAIL_TEST_FILES_MODIFIED

changed="$( { git diff --name-only; git diff --cached --name-only; } | sort -u )"

test_edits="$(printf '%s\n' "$changed" | grep -E '(^|/)tests/|\.Tests\.csproj$|Tests?\.cs$' || true)"

if [[ -n "$test_edits" ]]; then
  echo "[FAIL_TEST_FILES_MODIFIED] test files were modified:" >&2
  printf '%s\n' "$test_edits" >&2
  exit 10
fi

echo "[PASS_NO_TEST_EDITS] no test files modified"
