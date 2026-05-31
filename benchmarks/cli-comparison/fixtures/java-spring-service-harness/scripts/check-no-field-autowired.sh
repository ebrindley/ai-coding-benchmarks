#!/usr/bin/env bash
#
# Static check: Verify no field injection (@Autowired on fields)
# Constructor injection is preferred over field injection
#
# Exit 0 if no field @Autowired found, exit 1 otherwise

set -e

WORKSPACE="${1:-.}"
cd "$WORKSPACE"

# Check for @Autowired on fields (field injection is discouraged)
if find src/main/java -name "*.java" -exec grep -l "@Autowired.*private\|@Autowired.*protected\|@Autowired.*public" {} + 2>/dev/null | grep -q .; then
  echo "ERROR: Found @Autowired field injection (use constructor injection instead)"
  find src/main/java -name "*.java" -exec grep -H -n "@Autowired.*private\|@Autowired.*protected\|@Autowired.*public" {} + 2>/dev/null || true
  exit 1
fi

echo "✓ No field injection found (constructor injection verified)"
exit 0
