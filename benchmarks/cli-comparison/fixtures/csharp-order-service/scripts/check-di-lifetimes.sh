#!/usr/bin/env bash
set -euo pipefail

# Static check of service registrations. Comments are stripped before matching.
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
  echo "[FAIL_ORDER_PROCESSOR_NOT_SINGLETON] OrderProcessor must stay Singleton; effective registration was: ${effective_processor_reg}" >&2
  exit 42
fi

echo "[PASS_DI_LIFETIMES] ITenantContext Scoped and OrderProcessor Singleton"
