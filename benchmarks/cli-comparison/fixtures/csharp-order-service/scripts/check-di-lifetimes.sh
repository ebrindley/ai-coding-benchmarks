#!/usr/bin/env bash
set -euo pipefail

# Static check for the seeded dependency-injection lifetime bug.
#
# The per-request ITenantContext must be registered with a Scoped lifetime, not
# Singleton — a singleton tenant context leaks state across requests. This is the
# load-bearing registration invariant behind the bug; the captive-dependency half
# of the fix is covered by the ValidateOnBuild test in the test suite.
#
# Exit codes:
#   0  PASS  - ITenantContext registered as Scoped, not Singleton
#   40 FAIL  - ITenantContext still registered as Singleton
#   41 FAIL  - ITenantContext registration not found (removed or renamed)
#
# Grep-able error IDs: PASS_DI_LIFETIMES, FAIL_TENANT_CONTEXT_SINGLETON,
#                      FAIL_TENANT_CONTEXT_REGISTRATION_MISSING

src="src/OrderService/ServiceCollectionExtensions.cs"

if [[ ! -f "$src" ]]; then
  echo "[FAIL_TENANT_CONTEXT_REGISTRATION_MISSING] $src not found" >&2
  exit 41
fi

if grep -E 'AddSingleton<\s*ITenantContext' "$src" >/dev/null 2>&1; then
  echo "[FAIL_TENANT_CONTEXT_SINGLETON] ITenantContext must be Scoped, not Singleton" >&2
  exit 40
fi

if ! grep -E 'AddScoped<\s*ITenantContext' "$src" >/dev/null 2>&1; then
  echo "[FAIL_TENANT_CONTEXT_REGISTRATION_MISSING] no AddScoped<ITenantContext...> registration found" >&2
  exit 41
fi

echo "[PASS_DI_LIFETIMES] ITenantContext registered as Scoped"
