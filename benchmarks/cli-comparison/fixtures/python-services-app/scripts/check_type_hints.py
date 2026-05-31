#!/usr/bin/env python3
"""Check that extracted functions have type hints (nice-to-have).

This script verifies that the functions in shared/validators.py
have proper type hints for parameters and return types.

Exit codes:
    0: PASS - All functions have type hints
    50: FAIL_MISSING_RETURN_HINT - Function missing return type hint
    51: FAIL_MISSING_PARAM_HINT - Function missing parameter type hint
    52: FAIL_MODULE_NOT_FOUND - shared/validators.py does not exist

Error IDs (grep-able):
    PASS_TYPE_HINTS
    FAIL_MISSING_RETURN_HINT
    FAIL_MISSING_PARAM_HINT
    FAIL_MODULE_NOT_FOUND

Output: JSON on stdout with machine-readable results + human message.
"""

import ast
import json
import sys
from pathlib import Path


def check_type_hints() -> dict:
    """Check type hints in shared/validators.py."""
    validators_file = Path(__file__).parent.parent / "src" / "shared" / "validators.py"

    if not validators_file.exists():
        return {
            "exists": False,
            "path": str(validators_file),
            "functions_checked": [],
            "missing_hints": [],
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
                "missing_hints": [],
            }

    functions_checked = []
    missing_hints = []

    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            func_name = node.name
            if func_name.startswith("_"):
                continue  # Skip private functions

            func_info = {
                "name": func_name,
                "has_return_hint": node.returns is not None,
                "params_with_hints": [],
                "params_without_hints": [],
            }

            for arg in node.args.args:
                if arg.arg == "self":
                    continue
                if arg.annotation:
                    func_info["params_with_hints"].append(arg.arg)
                else:
                    func_info["params_without_hints"].append(arg.arg)

            functions_checked.append(func_info)

            if not func_info["has_return_hint"]:
                missing_hints.append(f"{func_name}: missing return type hint")
            if func_info["params_without_hints"]:
                missing_hints.append(
                    f"{func_name}: parameters without hints: "
                    f"{', '.join(func_info['params_without_hints'])}"
                )

    return {
        "exists": True,
        "path": str(validators_file),
        "functions_checked": functions_checked,
        "missing_hints": missing_hints,
    }


def main() -> int:
    """Main check logic."""
    check_result = check_type_hints()
    missing_hints = check_result.get("missing_hints", [])

    if not check_result.get("exists"):
        error_id = "FAIL_MODULE_NOT_FOUND"
        exit_code = 52
        message = "⚠ Shared validators module not found (cannot check type hints)"
    elif check_result.get("parse_error"):
        error_id = "FAIL_MODULE_NOT_FOUND"
        exit_code = 52
        message = f"⚠ Parse error: {check_result['parse_error']}"
    elif len(missing_hints) == 0:
        error_id = "PASS_TYPE_HINTS"
        exit_code = 0
        message = "✓ All functions have type hints"
    else:
        # Determine specific failure type
        has_return_issue = any("return type" in h for h in missing_hints)
        has_param_issue = any("parameters" in h for h in missing_hints)

        if has_return_issue:
            error_id = "FAIL_MISSING_RETURN_HINT"
            exit_code = 50
        elif has_param_issue:
            error_id = "FAIL_MISSING_PARAM_HINT"
            exit_code = 51
        else:
            error_id = "FAIL_MISSING_RETURN_HINT"
            exit_code = 50

        message = (
            f"⚠ {len(missing_hints)} type hint(s) missing "
            "(nice-to-have, not required)"
        )

    result = {
        "check": "type_hints",
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
