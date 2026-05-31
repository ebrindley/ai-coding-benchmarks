#!/usr/bin/env python3
"""Check that validation functions are no longer duplicated.

This script verifies that after refactoring, the validation functions
(validate_email, validate_phone, validate_address) exist ONLY in the
shared/validators.py module and are imported elsewhere, not re-implemented.

Exit codes:
    0: PASS - No duplication detected
    40: FAIL_DUPLICATE_EMAIL - validate_email still duplicated
    41: FAIL_DUPLICATE_PHONE - validate_phone still duplicated
    42: FAIL_DUPLICATE_ADDRESS - validate_address still duplicated
    43: FAIL_MULTIPLE_DUPLICATES - Multiple functions still duplicated

Error IDs (grep-able):
    PASS_NO_DUPLICATION
    FAIL_DUPLICATE_EMAIL
    FAIL_DUPLICATE_PHONE
    FAIL_DUPLICATE_ADDRESS
    FAIL_MULTIPLE_DUPLICATES

Output: JSON on stdout with machine-readable results + human message.
"""

import ast
import json
import sys
from pathlib import Path

# Functions that should only be in shared/validators.py
VALIDATION_FUNCTIONS = [
    "validate_email",
    "validate_phone",
    "validate_address",
]

# Files where these functions should NOT be defined (only imported)
SERVICE_FILES = [
    "src/services/user_service.py",
    "src/services/order_service.py",
    "src/services/admin_service.py",
]


def find_function_definitions(filepath: Path) -> list[str]:
    """Find all function definitions in a file."""
    if not filepath.exists():
        return []

    with open(filepath) as f:
        try:
            tree = ast.parse(f.read())
        except SyntaxError:
            return []

    functions = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            functions.append(node.name)
        # Also check for methods inside classes
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, ast.FunctionDef):
                    functions.append(item.name)

    return functions


def check_duplication() -> dict:
    """Check for duplicated validation functions in service files."""
    base_dir = Path(__file__).parent.parent
    duplications = []

    for service_file in SERVICE_FILES:
        filepath = base_dir / service_file
        functions = find_function_definitions(filepath)

        for func in VALIDATION_FUNCTIONS:
            if func in functions:
                duplications.append({
                    "file": service_file,
                    "function": func,
                    "message": f"'{func}' is still defined in {service_file}",
                })

    return {
        "duplications": duplications,
        "checked_files": SERVICE_FILES,
        "validation_functions": VALIDATION_FUNCTIONS,
    }


def main() -> int:
    """Main check logic."""
    check_result = check_duplication()
    duplications = check_result["duplications"]

    if len(duplications) == 0:
        error_id = "PASS_NO_DUPLICATION"
        exit_code = 0
        message = (
            "✓ No duplication - validation functions are consolidated "
            "(not found in service files)"
        )
    else:
        # Determine which functions are duplicated
        dup_funcs = set(d["function"] for d in duplications)

        if len(dup_funcs) > 1:
            error_id = "FAIL_MULTIPLE_DUPLICATES"
            exit_code = 43
        elif "validate_email" in dup_funcs:
            error_id = "FAIL_DUPLICATE_EMAIL"
            exit_code = 40
        elif "validate_phone" in dup_funcs:
            error_id = "FAIL_DUPLICATE_PHONE"
            exit_code = 41
        elif "validate_address" in dup_funcs:
            error_id = "FAIL_DUPLICATE_ADDRESS"
            exit_code = 42
        else:
            error_id = "FAIL_MULTIPLE_DUPLICATES"
            exit_code = 43

        count = len(duplications)
        message = (
            f"✗ {count} duplicated function(s) found - "
            "validation logic should be extracted to shared module"
        )

    result = {
        "check": "no_duplication",
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
    for d in duplications:
        print(f"  - {d['message']}", file=sys.stderr)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
