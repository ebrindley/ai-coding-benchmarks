#!/usr/bin/env python3
"""Check that the fix uses asyncio synchronization primitives.

This script verifies that the race condition fix uses proper asyncio
primitives (Lock, Semaphore, etc.) rather than other approaches.

Exit codes:
    0: PASS - asyncio.Lock or similar found in claim_task
    70: FAIL_NO_LOCK - No asyncio synchronization primitive found
    71: FAIL_WRONG_PRIMITIVE - Wrong primitive used (e.g., threading.Lock)
    72: FAIL_FILE_NOT_FOUND - processor.py not found
    73: FAIL_AWAIT_IN_LOCK - Await detected inside lock-protected section

Error IDs (grep-able):
    PASS_ASYNCIO_PRIMITIVES
    FAIL_NO_LOCK
    FAIL_WRONG_PRIMITIVE
    FAIL_FILE_NOT_FOUND
    FAIL_AWAIT_IN_LOCK

Output: JSON on stdout with machine-readable results + human message.
"""

import ast
import json
import sys
from pathlib import Path

# Valid asyncio synchronization primitives
VALID_PRIMITIVES = [
    "asyncio.Lock",
    "asyncio.Semaphore",
    "asyncio.BoundedSemaphore",
    "asyncio.Condition",
    "asyncio.Event",
]

# Invalid primitives (threading, multiprocessing)
INVALID_PRIMITIVES = [
    "threading.Lock",
    "threading.RLock",
    "threading.Semaphore",
    "multiprocessing.Lock",
]


def collect_imports(tree: ast.AST) -> dict[str, str]:
    """Collect import bindings -> fully-qualified module."""
    bindings: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bindings[alias.asname or alias.name] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                bindings[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    return bindings


def collect_primitives(tree: ast.AST, bindings: dict[str, str]) -> tuple[list[str], list[str]]:
    valid: set[str] = set()
    invalid: set[str] = set()

    valid_names = {p.split(".", 1)[1] for p in VALID_PRIMITIVES}
    invalid_names = {p.split(".", 1)[1] for p in INVALID_PRIMITIVES}

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue

        func = node.func
        # asyncio.Lock()
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            qual = bindings.get(func.value.id, func.value.id)
            if qual == "asyncio" and func.attr in valid_names:
                valid.add(f"asyncio.{func.attr}")
            if qual == "threading" and func.attr in invalid_names:
                invalid.add(f"threading.{func.attr}")
            if qual == "multiprocessing" and func.attr in invalid_names:
                invalid.add(f"multiprocessing.{func.attr}")

        # from asyncio import Lock; Lock()
        if isinstance(func, ast.Name):
            qual = bindings.get(func.id)
            if qual and qual.startswith("asyncio.") and func.id in valid_names:
                valid.add(qual)
            if qual and qual.startswith("threading.") and func.id in invalid_names:
                invalid.add(qual)
            if qual and qual.startswith("multiprocessing.") and func.id in invalid_names:
                invalid.add(qual)

    return sorted(valid), sorted(invalid)


def find_primitives_in_file(filepath: Path) -> dict:
    """Find synchronization primitives used in a Python file."""
    if not filepath.exists():
        return {"exists": False, "path": str(filepath)}

    with open(filepath) as f:
        content = f.read()

    try:
        tree = ast.parse(content)
    except SyntaxError as e:
        return {"exists": True, "path": str(filepath), "parse_error": str(e)}

    bindings = collect_imports(tree)
    found_valid, found_invalid = collect_primitives(tree, bindings)
    lock_in_claim_task = False
    await_in_lock_in_claim_task = False

    # Check if lock is used in claim_task method
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "claim_task":
            # Check for "async with" statements in claim_task
            for child in ast.walk(node):
                if isinstance(child, ast.AsyncWith):
                    lock_in_claim_task = True
                    # Detect any await inside the async-with body. Awaiting while holding
                    # the lock can lead to deadlocks in deterministic race tests.
                    for stmt in child.body:
                        for inner in ast.walk(stmt):
                            if isinstance(inner, ast.Await):
                                await_in_lock_in_claim_task = True
                    break

    return {
        "exists": True,
        "path": str(filepath),
        "found_valid_primitives": found_valid,
        "found_invalid_primitives": found_invalid,
        "lock_in_claim_task": lock_in_claim_task,
        "await_in_lock_in_claim_task": await_in_lock_in_claim_task,
    }


def main() -> int:
    """Main check logic."""
    processor_file = Path(__file__).parent.parent / "src" / "processor.py"
    result_data = find_primitives_in_file(processor_file)

    if not result_data.get("exists"):
        error_id = "FAIL_FILE_NOT_FOUND"
        exit_code = 72
        message = f"✗ processor.py not found at {result_data['path']}"
    elif result_data.get("parse_error"):
        error_id = "FAIL_FILE_NOT_FOUND"
        exit_code = 72
        message = f"✗ Parse error in processor.py: {result_data['parse_error']}"
    elif result_data["found_invalid_primitives"]:
        error_id = "FAIL_WRONG_PRIMITIVE"
        exit_code = 71
        message = (
            f"✗ Wrong synchronization primitive(s) found: "
            f"{', '.join(result_data['found_invalid_primitives'])}. "
            "Use asyncio primitives instead."
        )
    elif not result_data["found_valid_primitives"]:
        error_id = "FAIL_NO_LOCK"
        exit_code = 70
        message = "✗ No asyncio synchronization primitive found. Add asyncio.Lock to claim_task()."
    elif not result_data["lock_in_claim_task"]:
        error_id = "FAIL_NO_LOCK"
        exit_code = 70
        message = (
            f"✗ asyncio primitive found but not used in claim_task(). "
            f"Found: {', '.join(result_data['found_valid_primitives'])}"
        )
    elif result_data.get("await_in_lock_in_claim_task"):
        error_id = "FAIL_AWAIT_IN_LOCK"
        exit_code = 73
        message = (
            "✗ Detected `await` inside the lock-protected section of claim_task(). "
            "Avoid awaiting while holding the lock; make the claim atomic and remove/move yields."
        )
    else:
        error_id = "PASS_ASYNCIO_PRIMITIVES"
        exit_code = 0
        message = (
            f"✓ asyncio synchronization primitive properly used in claim_task(): "
            f"{', '.join(result_data['found_valid_primitives'])}"
        )

    result = {
        "check": "asyncio_primitives",
        "error_id": error_id,
        "exit_code": exit_code,
        "passed": exit_code == 0,
        "message": message,
        **result_data,
    }

    # Output JSON for machine parsing
    print(json.dumps(result, indent=2))

    # Human-readable summary to stderr (grep-able error ID)
    print(f"[{error_id}] {message}", file=sys.stderr)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
