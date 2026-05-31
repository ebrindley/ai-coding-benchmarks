# Python Services App Fixture

Benchmark fixture for testing Python refactoring capabilities.

## Task: Extract Duplicate Validation Logic

**Task ID**: `brownfield-007-python-refactor-duplicate-logic`

### Current State (Before Refactoring)

The codebase has duplicate validation logic across three service files:

| Function | user_service.py | order_service.py | admin_service.py |
|----------|-----------------|------------------|------------------|
| `validate_email` | ✓ | ✓ | ✓ |
| `validate_phone` | ✓ | - | ✓ |
| `validate_address` | ✓ | ✓ | ✓ |

### Target State (After Refactoring)

- Create `src/shared/validators.py` with canonical implementations
- Services import from shared module instead of defining their own
- All 32 existing tests pass WITHOUT modification
- Public API unchanged

### Refactor Constraints

1. **No test modifications** - All 32 tests must pass as-is
2. **No API changes** - Method signatures must remain identical
3. **Behavior preservation** - Validation logic must work the same way

## Quick Start

```bash
# Install dependencies
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

# Run tests (should pass)
.venv/bin/pytest tests/ -v

# Check API compatibility
.venv/bin/python scripts/check_api_compat.py

# Check for duplication (will show 8 duplications)
.venv/bin/python scripts/check_no_duplication.py
```

## File Structure

```
python-services-app/
├── src/
│   ├── services/
│   │   ├── user_service.py      # Has validate_email, validate_phone, validate_address
│   │   ├── order_service.py     # Has validate_email, validate_address
│   │   └── admin_service.py     # Has validate_email, validate_phone, validate_address
│   └── shared/
│       └── __init__.py          # Target: validators.py should be created here
├── tests/
│   ├── test_user_service.py     # 10 tests
│   ├── test_order_service.py    # 10 tests
│   ├── test_admin_service.py    # 8 tests
│   └── test_integration.py      # 4 tests
├── baseline/
│   └── api_symbols.json         # API baseline for compatibility check
├── scripts/
│   ├── check_no_test_edits.py   # Gate: no test files modified
│   ├── check_api_compat.py      # Gate: API unchanged
│   ├── check_shared_module.py   # Must-have: shared module exists
│   ├── check_no_duplication.py  # Must-have: no duplicate functions
│   ├── check_type_hints.py      # Nice-to-have: type hints present
│   └── check_docstrings.py      # Nice-to-have: docstrings present
└── pyproject.toml
```

## Eligibility Gates

In order, all must pass:

1. `pytest tests/` - All 32 tests pass
2. `scripts/check_no_test_edits.py` - No test files modified
3. `scripts/check_api_compat.py` - API matches baseline
4. `ruff check .` - No lint errors

## Success Criteria

- `scripts/check_shared_module.py` exits 0 (shared module created)
- `scripts/check_no_duplication.py` exits 0 (no duplicate functions)
- All 32 tests pass

## Exit Codes & Error IDs

All scripts emit grep-able error IDs in format `[ERROR_ID] message` to stderr.

### check_no_test_edits.py
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_NO_TEST_EDITS` | No test files modified |
| 10 | `FAIL_TEST_FILES_MODIFIED` | Test files were modified |
| 11 | `FAIL_GIT_ERROR` | Could not determine modified files |

### check_api_compat.py
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_API_COMPAT` | API is compatible |
| 20 | `FAIL_MISSING_CLASS` | Required class not found |
| 21 | `FAIL_MISSING_METHOD` | Required method not found |
| 22 | `FAIL_SIGNATURE_CHANGED` | Method signature changed |
| 23 | `FAIL_MISSING_MODULE` | Module file not found |
| 24 | `FAIL_BASELINE_ERROR` | Could not load baseline |

### check_shared_module.py
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_SHARED_MODULE` | Shared module exists with all functions |
| 30 | `FAIL_MODULE_NOT_FOUND` | shared/validators.py does not exist |
| 31 | `FAIL_SYNTAX_ERROR` | shared/validators.py has syntax errors |
| 32 | `FAIL_MISSING_FUNCTIONS` | Required functions not found |

### check_no_duplication.py
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_NO_DUPLICATION` | No duplication detected |
| 40 | `FAIL_DUPLICATE_EMAIL` | validate_email still duplicated |
| 41 | `FAIL_DUPLICATE_PHONE` | validate_phone still duplicated |
| 42 | `FAIL_DUPLICATE_ADDRESS` | validate_address still duplicated |
| 43 | `FAIL_MULTIPLE_DUPLICATES` | Multiple functions duplicated |

### check_type_hints.py (nice-to-have)
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_TYPE_HINTS` | All functions have type hints |
| 50 | `FAIL_MISSING_RETURN_HINT` | Missing return type hint |
| 51 | `FAIL_MISSING_PARAM_HINT` | Missing parameter type hint |
| 52 | `FAIL_MODULE_NOT_FOUND` | Module not found |

### check_docstrings.py (nice-to-have)
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_DOCSTRINGS` | All functions have docstrings |
| 60 | `FAIL_MISSING_DOCSTRING` | Function missing docstring |
| 61 | `FAIL_MODULE_NOT_FOUND` | Module not found |

## CI Usage

```bash
# Run all gates and grep for specific failures
python scripts/check_shared_module.py 2>&1 | grep -E "^\[FAIL"
echo "Exit code: $?"

# Extract error ID programmatically
python scripts/check_no_duplication.py 2>&1 | grep -oE "^\[[A-Z_]+\]"
```
