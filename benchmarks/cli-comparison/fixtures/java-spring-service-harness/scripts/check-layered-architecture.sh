#!/usr/bin/env bash
#
# Static check: Verify layered architecture (Controller → Service → Repository)
#
# Exit 0 if architecture is correct, exit 1 otherwise

set -e

WORKSPACE="${1:-.}"
cd "$WORKSPACE"

# Check that required layers exist
REQUIRED_FILES=(
  "src/main/java/com/example/BookController.java"
  "src/main/java/com/example/BookService.java"
  "src/main/java/com/example/BookRepository.java"
)

for file in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: Missing required file: $file"
    exit 1
  fi
done

# Verify Controller doesn't directly use Repository (should go through Service)
if grep -q "BookRepository" src/main/java/com/example/BookController.java 2>/dev/null; then
  echo "ERROR: BookController directly imports/uses BookRepository (should use BookService)"
  exit 1
fi

# Verify Service uses Repository
if ! grep -q "BookRepository" src/main/java/com/example/BookService.java 2>/dev/null; then
  echo "ERROR: BookService doesn't use BookRepository"
  exit 1
fi

echo "✓ Layered architecture verified: Controller → Service → Repository"
exit 0
