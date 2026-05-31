#!/usr/bin/env python3
"""Check that shared validators module exists with required functions.

This script verifies that the refactoring has created the expected
shared/validators.py module with the canonical validation functions.

Exit codes:
    0: PASS - Shared module exists with all required functions
    30: FAIL_MODULE_NOT_FOUND - shared/validators.py does not exist
    31: FAIL_SYNTAX_ERROR - shared/validators.py has syntax errors
    32: FAIL_MISSING_FUNCTIONS - Required functions not found in module

Error IDs (grep-able):
    PASS_SHARED_MODULE
    FAIL_MODULE_NOT_FOUND
    FAIL_SYNTAX_ERROR
    FAIL_MISSING_FUNCTIONS

Output: JSON on stdout with machine-readable results + human message.
"""

import ast
import json
import sys
from pathlib import Path

# Required functions that should be in the shared module
REQUIRED_FUNCTIONS = [
    "validate_email",
    "validate_phone",
    "validate_address",
]


def check_shared_module() -> dict:
    """Check if shared/validators.py exists and has required functions."""
    shared_dir = Path(__file__).parent.parent / "src" / "shared"
    validators_file = shared_dir / "validators.py"

    if not validators_file.exists():
        return {
            "exists": False,
            "path": str(validators_file),
            "found_functions": [],
            "missing_functions": REQUIRED_FUNCTIONS,
        }

    # Parse the file and find function definitions
    with open(validators_file) as f:
        try:
            tree = ast.parse(f.read())
        except SyntaxError as e:
            return {
                "exists": True,
                "path": str(validators_file),
                "parse_error": str(e),
                "found_functions": [],
                "missing_functions": REQUIRED_FUNCTIONS,
            }

    found_functions = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            found_functions.append(node.name)

    missing_functions = [f for f in REQUIRED_FUNCTIONS if f not in found_functions]

    return {
        "exists": True,
        "path": str(validators_file),
        "found_functions": found_functions,
        "missing_functions": missing_functions,
        "required_functions": REQUIRED_FUNCTIONS,
    }


def main() -> int:
    """Main check logic."""
    check_result = check_shared_module()

    # Determine error ID and exit code based on failure type
    if not check_result["exists"]:
        error_id = "FAIL_MODULE_NOT_FOUND"
        exit_code = 30
        message = f"✗ Shared validators module not found at {check_result['path']}"
    elif check_result.get("parse_error"):
        error_id = "FAIL_SYNTAX_ERROR"
        exit_code = 31
        message = f"✗ Shared validators module has syntax error: {check_result['parse_error']}"
    elif check_result["missing_functions"]:
        error_id = "FAIL_MISSING_FUNCTIONS"
        exit_code = 32
        message = (
            f"✗ Shared validators module missing functions: "
            f"{', '.join(check_result['missing_functions'])}"
        )
    else:
        error_id = "PASS_SHARED_MODULE"
        exit_code = 0
        message = (
            f"✓ Shared validators module exists with all required functions: "
            f"{', '.join(REQUIRED_FUNCTIONS)}"
        )

    result = {
        "check": "shared_module_created",
        "error_id": error_id,
        "exit_code": exit_code,
        "passed": exit_code == 0,
        "message": message,
        **check_result,
    }

    # Output JSON for machine parsing
    print(json.dumps(result, indent=2))

    # Human-readable summary to stderr (grep-able error ID)
    print(f"[{error_id}] {message}", file=sys.stderr)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
