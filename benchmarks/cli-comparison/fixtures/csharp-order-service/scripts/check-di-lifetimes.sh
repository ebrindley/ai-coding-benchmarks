#!/usr/bin/env bash
set -euo pipefail

# Static check for the seeded dependency-injection lifetime bug.
#
# Two registration invariants are load-bearing for this task's DI-scoping model:
#   1. The per-request ITenantContext must be Scoped, not Singleton — a singleton
#      tenant context leaks state across requests.
#   2. OrderProcessor must remain a Singleton. The intended fix keeps it a
#      singleton and opens a fresh scope per order via IServiceScopeFactory;
#      demoting OrderProcessor to Scoped/Transient is a way to sidestep the
#      captive-dependency problem without adopting the required scope-per-order
#      model, so it is rejected here.
# The captive-dependency half of the fix (no scoped service captured in a
# singleton constructor) is covered by the ValidateOnBuild test in the suite, and
# the per-call scope behavior is pinned by ProcessOrder_DoesNotBleedTenantState.
#
# Registrations are evaluated on the source with BOTH // line comments and
# /* ... */ block comments stripped (so a commented-out registration never
# counts), and each service is matched in both the generic (`AddX<Service>`) and
# the reflection (`AddX(typeof(Service))`) registration forms. For OrderProcessor
# the LAST active registration wins (.NET resolves the last Add* registration).
#
# Exit codes:
#   0  PASS  - ITenantContext Scoped and OrderProcessor Singleton
#   40 FAIL  - ITenantContext still registered as Singleton
#   41 FAIL  - ITenantContext registration not found (removed or renamed)
#   42 FAIL  - OrderProcessor not registered as Singleton
#
# Grep-able error IDs: PASS_DI_LIFETIMES, FAIL_TENANT_CONTEXT_SINGLETON,
#                      FAIL_TENANT_CONTEXT_REGISTRATION_MISSING,
#                      FAIL_ORDER_PROCESSOR_NOT_SINGLETON

src="src/OrderService/ServiceCollectionExtensions.cs"

if [[ ! -f "$src" ]]; then
  echo "[FAIL_TENANT_CONTEXT_REGISTRATION_MISSING] $src not found" >&2
  exit 41
fi

# Strip C# comments (// line and /* ... */ block, including multi-line) so that a
# commented-out registration is never treated as active. String literals are not
# a concern for a DI composition-root file.
strip_comments() {
  awk '
    BEGIN { inblock = 0 }
    {
      line = $0; out = ""; n = length(line); i = 1
      while (i <= n) {
        if (inblock) {
          rest = substr(line, i); p = index(rest, "*/")
          if (p == 0) { i = n + 1 } else { inblock = 0; i = i + p + 1 }
        } else {
          two = substr(line, i, 2)
          if (two == "/*") { inblock = 1; i = i + 2 }
          else if (two == "//") { i = n + 1 }
          else { out = out substr(line, i, 1); i = i + 1 }
        }
      }
      print out
    }
  ' "$1"
}

active="$(strip_comments "$src")"

# Match a service registration in both generic and typeof forms, e.g.
#   AddSingleton<ITenantContext, TenantContext>()   AddScoped(typeof(ITenantContext), ...)
tenant_singleton='AddSingleton\s*(<\s*ITenantContext\b|\(\s*typeof\s*\(\s*ITenantContext\b)'
tenant_scoped='AddScoped\s*(<\s*ITenantContext\b|\(\s*typeof\s*\(\s*ITenantContext\b)'
processor_any='Add(Singleton|Scoped|Transient)\s*(<\s*OrderProcessor\b|\(\s*typeof\s*\(\s*OrderProcessor\b)'

if printf '%s\n' "$active" | grep -Eq "$tenant_singleton"; then
  echo "[FAIL_TENANT_CONTEXT_SINGLETON] ITenantContext must be Scoped, not Singleton" >&2
  exit 40
fi

if ! printf '%s\n' "$active" | grep -Eq "$tenant_scoped"; then
  echo "[FAIL_TENANT_CONTEXT_REGISTRATION_MISSING] no active AddScoped ITenantContext registration found" >&2
  exit 41
fi

# Effective OrderProcessor lifetime = the last active registration's Add* verb.
effective_processor_reg="$(
  { printf '%s\n' "$active" | grep -Eo "$processor_any" \
      | grep -Eo 'Add(Singleton|Scoped|Transient)' \
      || true; } \
    | tail -n 1
)"

if [[ -z "$effective_processor_reg" ]]; then
  echo "[FAIL_ORDER_PROCESSOR_NOT_SINGLETON] no active OrderProcessor registration found (must stay Singleton)" >&2
  exit 42
fi

if [[ "$effective_processor_reg" != "AddSingleton" ]]; then
  echo "[FAIL_ORDER_PROCESSOR_NOT_SINGLETON] OrderProcessor must stay Singleton (fix opens a scope per order via IServiceScopeFactory, not by demoting the processor); effective registration was: ${effective_processor_reg}" >&2
  exit 42
fi

echo "[PASS_DI_LIFETIMES] ITenantContext Scoped and OrderProcessor Singleton"
