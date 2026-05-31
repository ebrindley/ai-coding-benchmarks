#!/usr/bin/env python3
"""Check that the race condition fix is documented (nice-to-have).

This script verifies that the developer added comments explaining
the race condition and the fix.

Exit codes:
    0: PASS - Documentation found near the fix
    80: FAIL_NO_DOCUMENTATION - No explanatory comments found
    81: FAIL_FILE_NOT_FOUND - processor.py not found

Error IDs (grep-able):
    PASS_FIX_DOCUMENTED
    FAIL_NO_DOCUMENTATION
    FAIL_FILE_NOT_FOUND

Output: JSON on stdout with machine-readable results + human message.
"""

import json
import sys
from pathlib import Path

# Keywords that indicate documentation of the fix
DOCUMENTATION_KEYWORDS = [
    "race condition",
    "race-condition",
    "concurrent",
    "thread safe",
    "thread-safe",
    "atomic",
    "lock",
    "synchronization",
    "critical section",
    "mutual exclusion",
    "mutex",
]


def check_documentation(filepath: Path) -> dict:
    """Check for documentation about the race condition fix."""
    if not filepath.exists():
        return {"exists": False, "path": str(filepath)}

    with open(filepath) as f:
        content = f.read()
        lines = content.split("\n")

    # Find comments and docstrings
    comments = []
    in_docstring = False
    docstring_content = []

    for i, line in enumerate(lines, 1):
        stripped = line.strip()

        # Track docstrings
        if '"""' in stripped or "'''" in stripped:
            if in_docstring:
                docstring_content.append(stripped)
                comments.append({
                    "line": i,
                    "type": "docstring",
                    "content": " ".join(docstring_content),
                })
                docstring_content = []
                in_docstring = False
            else:
                in_docstring = True
                docstring_content = [stripped]
        elif in_docstring:
            docstring_content.append(stripped)

        # Track single-line comments
        if "#" in stripped:
            comment_start = stripped.find("#")
            comment_text = stripped[comment_start + 1:].strip()
            comments.append({
                "line": i,
                "type": "comment",
                "content": comment_text,
            })

    # Check for documentation keywords
    found_keywords = []
    documented_locations = []

    for comment in comments:
        content_lower = comment["content"].lower()
        for keyword in DOCUMENTATION_KEYWORDS:
            if keyword in content_lower:
                found_keywords.append(keyword)
                documented_locations.append({
                    "line": comment["line"],
                    "type": comment["type"],
                    "keyword": keyword,
                    "excerpt": comment["content"][:100],
                })

    return {
        "exists": True,
        "path": str(filepath),
        "found_keywords": list(set(found_keywords)),
        "documented_locations": documented_locations,
        "total_comments": len(comments),
    }


def main() -> int:
    """Main check logic."""
    processor_file = Path(__file__).parent.parent / "src" / "processor.py"
    result_data = check_documentation(processor_file)

    if not result_data.get("exists"):
        error_id = "FAIL_FILE_NOT_FOUND"
        exit_code = 81
        message = f"✗ processor.py not found at {result_data['path']}"
    elif not result_data["found_keywords"]:
        error_id = "FAIL_NO_DOCUMENTATION"
        exit_code = 80
        message = (
            "⚠ No documentation found explaining the race condition fix "
            "(nice-to-have, not required)"
        )
    else:
        error_id = "PASS_FIX_DOCUMENTED"
        exit_code = 0
        message = (
            f"✓ Fix documented with keywords: {', '.join(result_data['found_keywords'])}"
        )

    result = {
        "check": "fix_documented",
        "error_id": error_id,
        "exit_code": exit_code,
        "passed": exit_code == 0,
        "nice_to_have": True,
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
