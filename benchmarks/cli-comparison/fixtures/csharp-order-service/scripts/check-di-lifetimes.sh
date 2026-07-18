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

if grep -E 'AddSingleton<\s*ITenantContext' "$src" >/dev/null 2>&1; then
  echo "[FAIL_TENANT_CONTEXT_SINGLETON] ITenantContext must be Scoped, not Singleton" >&2
  exit 40
fi

if ! grep -E 'AddScoped<\s*ITenantContext' "$src" >/dev/null 2>&1; then
  echo "[FAIL_TENANT_CONTEXT_REGISTRATION_MISSING] no AddScoped<ITenantContext...> registration found" >&2
  exit 41
fi

# OrderProcessor must stay Singleton. Evaluate the EFFECTIVE registration, not
# mere presence: strip // line comments first (a commented AddSingleton must not
# count), then take the LAST OrderProcessor registration (.NET resolves the last
# Add* wins) and require it to be AddSingleton. This rejects both a commented-out
# singleton and a competing later AddScoped/AddTransient<OrderProcessor>.
effective_processor_reg="$(
  { sed 's://.*::' "$src" \
      | grep -Eo 'Add(Singleton|Scoped|Transient)<\s*OrderProcessor' \
      || true; } \
    | tail -n 1
)"

if [[ -z "$effective_processor_reg" ]]; then
  echo "[FAIL_ORDER_PROCESSOR_NOT_SINGLETON] no active OrderProcessor registration found (must stay Singleton)" >&2
  exit 42
fi

if [[ "$effective_processor_reg" != AddSingleton* ]]; then
  echo "[FAIL_ORDER_PROCESSOR_NOT_SINGLETON] OrderProcessor must stay Singleton (fix opens a scope per order via IServiceScopeFactory, not by demoting the processor); effective registration was: ${effective_processor_reg}" >&2
  exit 42
fi

echo "[PASS_DI_LIFETIMES] ITenantContext Scoped and OrderProcessor Singleton"
