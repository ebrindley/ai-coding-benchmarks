#!/usr/bin/env bash

#
# Oracle Test: HTTP Endpoint Validation
#
# Validates that the Spring Boot service endpoints work end-to-end.
# This catches latent bugs that unit tests might miss:
# - Application doesn't start
# - Endpoints return wrong status codes
# - JSON serialization broken
# - Exception handling misconfigured
#
# Usage:
#   WORKSPACE_DIR=/path/to/workspace bash check-http-endpoints.sh
#
# Exit codes:
#   0 - All checks passed
#   1 - HTTP endpoint validation failed
#

set -e
set -u
set -o pipefail

WORKSPACE_DIR="${WORKSPACE_DIR:-.}"
cd "$WORKSPACE_DIR"

echo "Oracle Test: HTTP Endpoint Validation"
echo "Workspace: $WORKSPACE_DIR"
echo ""

# Check if Maven is available
if ! command -v mvn &>/dev/null; then
  echo "ERROR: Maven not found in PATH"
  exit 1
fi

# Check if curl is available
if ! command -v curl &>/dev/null; then
  echo "ERROR: curl not found in PATH"
  exit 1
fi

# Build the application
echo "Building application..."
BUILD_LOG="target/oracle-build.log"
mkdir -p target
if ! mvn clean package -DskipTests -q >"$BUILD_LOG" 2>&1; then
  echo "ERROR: Maven build failed"
  echo ""
  echo "Build log (last 50 lines):"
  tail -50 "$BUILD_LOG" || true
  exit 1
fi

# Find the JAR file
JAR_FILE=$(find target -name "*.jar" | grep -v "original" | head -1)
if [[ -z "$JAR_FILE" ]]; then
  echo "ERROR: No JAR file found in target/"
  exit 1
fi

echo "✓ Build successful: $JAR_FILE"
echo ""

# Start the application in background
echo "Starting Spring Boot application..."
PORT="${PORT:-18080}"
APP_LOG="target/oracle-spring-boot.log"
java -jar "$JAR_FILE" --server.port="$PORT" >"$APP_LOG" 2>&1 &
APP_PID=$!

# Wait for application to be ready (max 30 seconds)
echo "Waiting for application to start..."
MAX_WAIT=30
WAIT_COUNT=0
while [[ $WAIT_COUNT -lt $MAX_WAIT ]]; do
  if curl -s "http://localhost:${PORT}/actuator/health" &>/dev/null || \
     curl -s "http://localhost:${PORT}/books" &>/dev/null; then
    echo "✓ Application started successfully"
    break
  fi
  sleep 1
  WAIT_COUNT=$((WAIT_COUNT + 1))
done

if [[ $WAIT_COUNT -ge $MAX_WAIT ]]; then
  echo "ERROR: Application failed to start within ${MAX_WAIT}s"
  echo ""
  echo "Application log (last 50 lines):"
  tail -50 "$APP_LOG" || true
  kill $APP_PID 2>/dev/null || true
  exit 1
fi

# Cleanup function
cleanup() {
  echo ""
  echo "Shutting down application..."
  kill $APP_PID 2>/dev/null || true
  wait $APP_PID 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "Testing HTTP endpoints..."
echo ""

# Test 1: GET /books (should return empty list or array)
echo "Test 1: GET /books"
RESPONSE=$(curl -s -w "\n%{http_code}" "http://localhost:${PORT}/books")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: GET /books returned HTTP $HTTP_CODE (expected 200)"
  echo "Response body: $BODY"
  exit 1
fi

# Check if response is valid JSON array
if ! echo "$BODY" | python3 -m json.tool &>/dev/null; then
  echo "ERROR: GET /books returned invalid JSON"
  echo "Response: $BODY"
  exit 1
fi

echo "✓ GET /books returns HTTP 200 with valid JSON"

# Test 2: POST /books (create a book)
echo ""
echo "Test 2: POST /books"
PAYLOAD='{"id":1,"title":"Test Book","author":"Test Author"}'
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "http://localhost:${PORT}/books")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" != "201" ]] && [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: POST /books returned HTTP $HTTP_CODE (expected 201 or 200)"
  echo "Response body: $BODY"
  exit 1
fi

echo "✓ POST /books creates book (HTTP $HTTP_CODE)"

# Test 3: GET /books/{id} (retrieve created book)
echo ""
echo "Test 3: GET /books/1"
RESPONSE=$(curl -s -w "\n%{http_code}" "http://localhost:${PORT}/books/1")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: GET /books/1 returned HTTP $HTTP_CODE (expected 200)"
  echo "Response body: $BODY"
  exit 1
fi

# Check if response contains the book data
if ! echo "$BODY" | grep -q "Test Book"; then
  echo "ERROR: GET /books/1 response doesn't contain expected book"
  echo "Response: $BODY"
  exit 1
fi

echo "✓ GET /books/1 returns book with correct data"

# Test 4: GET /books/{id} for non-existent book (should return 404)
echo ""
echo "Test 4: GET /books/999 (non-existent)"
RESPONSE=$(curl -s -w "\n%{http_code}" "http://localhost:${PORT}/books/999")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [[ "$HTTP_CODE" != "404" ]]; then
  echo "ERROR: GET /books/999 returned HTTP $HTTP_CODE (expected 404)"
  exit 1
fi

echo "✓ GET /books/999 returns HTTP 404 for non-existent book"

# Test 5: DELETE /books/{id}
echo ""
echo "Test 5: DELETE /books/1"
RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE "http://localhost:${PORT}/books/1")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [[ "$HTTP_CODE" != "200" ]] && [[ "$HTTP_CODE" != "204" ]]; then
  echo "ERROR: DELETE /books/1 returned HTTP $HTTP_CODE (expected 200 or 204)"
  exit 1
fi

echo "✓ DELETE /books/1 successful (HTTP $HTTP_CODE)"

# Test 6: Verify book was deleted
echo ""
echo "Test 6: GET /books/1 after delete (should be 404)"
RESPONSE=$(curl -s -w "\n%{http_code}" "http://localhost:${PORT}/books/1")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [[ "$HTTP_CODE" != "404" ]]; then
  echo "ERROR: GET /books/1 after delete returned HTTP $HTTP_CODE (expected 404)"
  exit 1
fi

echo "✓ GET /books/1 after delete returns HTTP 404"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ HTTP Endpoint Validation PASSED"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "All endpoints working correctly:"
echo "  • GET /books - List books"
echo "  • POST /books - Create book (HTTP 201)"
echo "  • GET /books/{id} - Get book by ID"
echo "  • GET /books/{id} (404) - Proper error handling"
echo "  • DELETE /books/{id} - Delete book"
echo ""

exit 0
