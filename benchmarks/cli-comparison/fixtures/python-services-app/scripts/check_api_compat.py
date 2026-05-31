#!/usr/bin/env python3
"""Check API compatibility against baseline snapshot.

This script verifies that public API signatures have not changed after
a refactoring, ensuring it's a true behavior-preserving refactor.

Exit codes:
    0: PASS - API is compatible
    20: FAIL_MISSING_CLASS - Required class not found
    21: FAIL_MISSING_METHOD - Required method not found
    22: FAIL_SIGNATURE_CHANGED - Method signature changed
    23: FAIL_MISSING_MODULE - Module file not found
    24: FAIL_BASELINE_ERROR - Could not load baseline

Error IDs (grep-able):
    PASS_API_COMPAT
    FAIL_MISSING_CLASS
    FAIL_MISSING_METHOD
    FAIL_SIGNATURE_CHANGED
    FAIL_MISSING_MODULE
    FAIL_BASELINE_ERROR

Output: JSON on stdout with machine-readable results + human message.
"""

import ast
import json
import sys
from pathlib import Path
from typing import Any


def load_baseline() -> dict[str, Any]:
    """Load the API baseline from JSON file."""
    baseline_path = Path(__file__).parent.parent / "baseline" / "api_symbols.json"
    with open(baseline_path) as f:
        return json.load(f)


def extract_class_signatures(module_path: Path) -> dict[str, Any]:
    """Extract class and method signatures from a Python file using AST."""
    with open(module_path) as f:
        tree = ast.parse(f.read())

    classes = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            class_info = {"methods": {}}

            for item in node.body:
                if isinstance(item, ast.FunctionDef):
                    # Build signature string from arguments
                    args = item.args
                    params = []

                    # Handle self/cls
                    for arg in args.args:
                        param = arg.arg
                        if arg.annotation:
                            param += f": {ast.unparse(arg.annotation)}"
                        params.append(param)

                    # Handle defaults
                    num_defaults = len(args.defaults)
                    if num_defaults > 0:
                        default_start = len(params) - num_defaults
                        for i, default in enumerate(args.defaults):
                            idx = default_start + i
                            params[idx] += f" = {ast.unparse(default)}"

                    signature = f"({', '.join(params)})"

                    # Get return type
                    return_type = "None"
                    if item.returns:
                        return_type = ast.unparse(item.returns)

                    class_info["methods"][item.name] = {
                        "signature": signature,
                        "return": return_type,
                    }

            classes[node.name] = class_info

    return classes


def compare_signatures(
    baseline_module: dict[str, Any], current_classes: dict[str, Any]
) -> list[dict[str, str]]:
    """Compare current signatures against baseline."""
    violations = []

    baseline_classes = baseline_module.get("classes", {})

    for class_name, class_info in baseline_classes.items():
        if class_info.get("type") not in ["class"]:
            continue  # Skip dataclasses, enums, exceptions for method checking

        if class_name not in current_classes:
            violations.append({
                "type": "missing_class",
                "class": class_name,
                "message": f"Class '{class_name}' is missing",
            })
            continue

        baseline_methods = class_info.get("methods", {})
        current_methods = current_classes[class_name].get("methods", {})

        for method_name, method_info in baseline_methods.items():
            if method_name not in current_methods:
                violations.append({
                    "type": "missing_method",
                    "class": class_name,
                    "method": method_name,
                    "message": f"Method '{class_name}.{method_name}' is missing",
                })
                continue

            baseline_sig = method_info["signature"]
            current_sig = current_methods[method_name]["signature"]

            # Normalize signatures for comparison (handle whitespace, etc.)
            baseline_normalized = baseline_sig.replace(" ", "").replace("Optional", "Optional")
            current_normalized = current_sig.replace(" ", "").replace("Optional", "Optional")

            if baseline_normalized != current_normalized:
                violations.append({
                    "type": "signature_change",
                    "class": class_name,
                    "method": method_name,
                    "expected": baseline_sig,
                    "actual": current_sig,
                    "message": (
                        f"Signature of '{class_name}.{method_name}' changed: "
                        f"expected {baseline_sig}, got {current_sig}"
                    ),
                })

    return violations


def main() -> int:
    """Main check logic."""
    try:
        baseline = load_baseline()
    except (FileNotFoundError, json.JSONDecodeError) as e:
        error_id = "FAIL_BASELINE_ERROR"
        result = {
            "check": "api_compat",
            "error_id": error_id,
            "exit_code": 24,
            "passed": False,
            "message": f"Could not load baseline: {e}",
        }
        print(json.dumps(result, indent=2))
        print(f"[{error_id}] {result['message']}", file=sys.stderr)
        return 24

    violations = []
    src_dir = Path(__file__).parent.parent / "src"

    for module_name, module_info in baseline.get("modules", {}).items():
        # Convert module name to file path
        module_path = src_dir.parent / module_name.replace(".", "/")
        module_file = module_path.with_suffix(".py")

        if not module_file.exists():
            violations.append({
                "type": "missing_module",
                "module": module_name,
                "message": f"Module '{module_name}' file not found at {module_file}",
            })
            continue

        current_classes = extract_class_signatures(module_file)
        module_violations = compare_signatures(module_info, current_classes)
        violations.extend(module_violations)

    # Determine primary error type for exit code
    if len(violations) == 0:
        error_id = "PASS_API_COMPAT"
        exit_code = 0
        message = "✓ API is compatible with baseline - no breaking changes"
    else:
        # Use first violation type to determine exit code
        first_type = violations[0].get("type", "unknown")
        if first_type == "missing_module":
            error_id = "FAIL_MISSING_MODULE"
            exit_code = 23
        elif first_type == "missing_class":
            error_id = "FAIL_MISSING_CLASS"
            exit_code = 20
        elif first_type == "missing_method":
            error_id = "FAIL_MISSING_METHOD"
            exit_code = 21
        elif first_type == "signature_change":
            error_id = "FAIL_SIGNATURE_CHANGED"
            exit_code = 22
        else:
            error_id = "FAIL_API_COMPAT"
            exit_code = 1
        message = (
            f"✗ {len(violations)} API incompatibility(ies) found - "
            "refactor constraint violated"
        )

    result = {
        "check": "api_compat",
        "error_id": error_id,
        "exit_code": exit_code,
        "passed": exit_code == 0,
        "violations": violations,
        "baseline_version": baseline.get("$schema", "unknown"),
        "message": message,
    }

    # Output JSON for machine parsing
    print(json.dumps(result, indent=2))

    # Human-readable summary to stderr (grep-able error ID)
    print(f"[{error_id}] {message}", file=sys.stderr)
    for v in violations:
        print(f"  - {v['message']}", file=sys.stderr)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
