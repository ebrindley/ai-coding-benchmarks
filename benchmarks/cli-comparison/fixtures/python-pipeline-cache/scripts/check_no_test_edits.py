#!/usr/bin/env python3
"""Check that no test files have been modified.

This script verifies that a bug-fix task has not modified any test files,
ensuring the fix is proven by the tests as shipped rather than by editing them.

Exit codes:
    0: PASS - No test files modified
    10: FAIL_TEST_FILES_MODIFIED - Test files were modified
    11: FAIL_GIT_ERROR - Could not determine modified files

Error IDs (grep-able):
    PASS_NO_TEST_EDITS
    FAIL_TEST_FILES_MODIFIED
    FAIL_GIT_ERROR

Output: JSON on stdout with machine-readable results + human message.
"""

import json
import subprocess
import sys
from pathlib import Path

# Test file patterns (repo-convention aware)
TEST_PATTERNS = [
    "tests/**/*.py",
    "test_*.py",
    "*_test.py",
    "tests/*.py",
]

# Directories considered test directories
TEST_DIRS = ["tests", "test", "__tests__"]


class GitUnavailableError(RuntimeError):
    """Raised when the modified-file set cannot be determined from git."""


def get_modified_files() -> list[str]:
    """Get list of modified files from git within the fixture directory.

    Raises:
        GitUnavailableError: if git cannot compute the diff (e.g. the fixture is
            not inside a git worktree, or git is missing). The caller fails
            closed rather than reporting a spurious "no test edits" pass.
    """
    fixture_dir = Path(__file__).parent.parent
    try:
        # Get staged changes relative to fixture directory
        staged = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "--", str(fixture_dir)],
            capture_output=True,
            text=True,
            check=True,
            cwd=fixture_dir,
        )
        # Get unstaged changes relative to fixture directory
        unstaged = subprocess.run(
            ["git", "diff", "--name-only", "--", str(fixture_dir)],
            capture_output=True,
            text=True,
            check=True,
            cwd=fixture_dir,
        )
        # Get untracked (but not gitignored) files so an agent cannot slip in a
        # new test file undetected.
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard", "--", str(fixture_dir)],
            capture_output=True,
            text=True,
            check=True,
            cwd=fixture_dir,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        # Fail closed: an unverifiable state must not be reported as clean.
        raise GitUnavailableError(str(exc)) from exc

    files = set(
        staged.stdout.strip().split("\n")
        + unstaged.stdout.strip().split("\n")
        + untracked.stdout.strip().split("\n")
    )
    # Filter empty strings and .venv directory
    return [f for f in files if f and ".venv" not in f]


def is_test_file(filepath: str) -> bool:
    """Determine if a file is a test file based on repo conventions."""
    path = Path(filepath)

    # Check if in test directory
    for part in path.parts:
        if part in TEST_DIRS:
            return True

    # Check filename patterns
    name = path.name
    if name.startswith("test_") and name.endswith(".py"):
        return True
    if name.endswith("_test.py"):
        return True

    return False


def main() -> int:
    """Main check logic."""
    try:
        modified_files = get_modified_files()
    except GitUnavailableError as exc:
        error_id = "FAIL_GIT_ERROR"
        message = f"✗ Could not determine modified files from git: {exc}"
        result = {
            "check": "no_test_edits",
            "error_id": error_id,
            "exit_code": 11,
            "passed": False,
            "modified_test_files": [],
            "total_modified_files": 0,
            "message": message,
        }
        print(json.dumps(result, indent=2))
        print(f"[{error_id}] {message}", file=sys.stderr)
        return 11

    modified_test_files = [f for f in modified_files if is_test_file(f)]

    if len(modified_test_files) == 0:
        error_id = "PASS_NO_TEST_EDITS"
        exit_code = 0
        message = "✓ No test files modified - bug-fix constraint satisfied"
    else:
        error_id = "FAIL_TEST_FILES_MODIFIED"
        exit_code = 10
        message = (
            f"✗ {len(modified_test_files)} test file(s) modified - "
            f"bug-fix constraint violated: {', '.join(modified_test_files)}"
        )

    result = {
        "check": "no_test_edits",
        "error_id": error_id,
        "exit_code": exit_code,
        "passed": exit_code == 0,
        "modified_test_files": modified_test_files,
        "total_modified_files": len(modified_files),
        "message": message,
    }

    # Output JSON for machine parsing
    print(json.dumps(result, indent=2))

    # Human-readable summary to stderr (grep-able error ID)
    print(f"[{error_id}] {message}", file=sys.stderr)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
