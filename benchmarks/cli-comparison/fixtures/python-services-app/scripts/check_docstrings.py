#!/usr/bin/env python3
"""Check that extracted functions have docstrings (nice-to-have).

This script verifies that the functions in shared/validators.py
have proper docstrings documenting their behavior.

Exit codes:
    0: PASS - All functions have docstrings
    60: FAIL_MISSING_DOCSTRING - Function missing docstring
    61: FAIL_MODULE_NOT_FOUND - shared/validators.py does not exist

Error IDs (grep-able):
    PASS_DOCSTRINGS
    FAIL_MISSING_DOCSTRING
    FAIL_MODULE_NOT_FOUND

Output: JSON on stdout with machine-readable results + human message.
"""

import ast
import json
import sys
from pathlib import Path


def check_docstrings() -> dict:
    """Check docstrings in shared/validators.py."""
    validators_file = Path(__file__).parent.parent / "src" / "shared" / "validators.py"

    if not validators_file.exists():
        return {
            "exists": False,
            "path": str(validators_file),
            "functions_checked": [],
            "missing_docstrings": [],
        }

    with open(validators_file) as f:
        try:
            tree = ast.parse(f.read())
        except SyntaxError as e:
            return {
                "exists": True,
                "path": str(validators_file),
                "parse_error": str(e),
                "functions_checked": [],
                "missing_docstrings": [],
            }

    functions_checked = []
    missing_docstrings = []

    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            func_name = node.name
            if func_name.startswith("_"):
                continue  # Skip private functions

            docstring = ast.get_docstring(node)
            has_docstring = docstring is not None and len(docstring.strip()) > 0

            func_info = {
                "name": func_name,
                "has_docstring": has_docstring,
                "docstring_preview": (
                    docstring[:100] + "..." if docstring and len(docstring) > 100 else docstring
                ),
            }

            functions_checked.append(func_info)

            if not has_docstring:
                missing_docstrings.append(func_name)

    return {
        "exists": True,
        "path": str(validators_file),
        "functions_checked": functions_checked,
        "missing_docstrings": missing_docstrings,
    }


def main() -> int:
    """Main check logic."""
    check_result = check_docstrings()
    missing = check_result.get("missing_docstrings", [])

    if not check_result.get("exists"):
        error_id = "FAIL_MODULE_NOT_FOUND"
        exit_code = 61
        message = "⚠ Shared validators module not found (cannot check docstrings)"
    elif check_result.get("parse_error"):
        error_id = "FAIL_MODULE_NOT_FOUND"
        exit_code = 61
        message = f"⚠ Parse error: {check_result['parse_error']}"
    elif len(missing) == 0:
        error_id = "PASS_DOCSTRINGS"
        exit_code = 0
        message = "✓ All functions have docstrings"
    else:
        error_id = "FAIL_MISSING_DOCSTRING"
        exit_code = 60
        message = (
            f"⚠ {len(missing)} function(s) missing docstrings "
            f"(nice-to-have, not required): {', '.join(missing)}"
        )

    result = {
        "check": "docstrings",
        "error_id": error_id,
        "exit_code": exit_code,
        "passed": exit_code == 0,
        "nice_to_have": True,  # This is a quality check, not a hard requirement
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
