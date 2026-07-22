#!/usr/bin/env bash
set -euo pipefail

# Static heuristic: a correct fix for the lost-update race must make the
# read-check-write of stock atomic. This does not prove correctness (the tests
# do that) but flags a fix that ships without any concurrency-control mechanism,
# which is almost certainly still racy.
#
# Accepts any of the common correct approaches:
#   - a synchronized block/method or an explicit Lock
#   - an atomic compute on the repository map (compute/computeIfPresent/merge)
#   - a compare-and-set / optimistic retry loop
#   - a lock-free atomic update (updateAndGet/getAndUpdate/accumulateAndGet)
mainSrc="src/main/java/com/example"

if [[ ! -d "$mainSrc" ]]; then
  echo "[MISSING_SOURCE] $mainSrc not found" >&2
  exit 41
fi

if grep -rEq \
  '\bsynchronized\b|ReentrantLock|\bLock\b|computeIfPresent|\bcompute\b|\bmerge\b|\breplace\b|compareAndSet|updateAndGet|getAndUpdate|accumulateAndGet|StampedLock|ReadWriteLock' \
  "$mainSrc"; then
  echo "[OK] concurrency-control mechanism present"
  exit 0
fi

echo "[NO_SYNCHRONIZATION] no locking/atomic mechanism found in $mainSrc" >&2
echo "the stock read-check-write is still unsynchronized" >&2
exit 42
