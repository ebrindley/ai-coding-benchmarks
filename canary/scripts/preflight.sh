#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
expected_sha="9eef589959858af368b168e674685ef597468fa1"
models="$root/canary/config/models.json"
tasks="$root/canary/config/tasks.json"
missing_gate_tools=()

for command in git jq lms curl opencode poetic node npm; do
  command -v "$command" >/dev/null || {
    printf 'Error: required command not found: %s\n' "$command" >&2
    exit 1
  }
done

if ! git -C "$root" cat-file -e "$expected_sha^{commit}"; then
  printf 'Error: pinned corpus commit is unavailable: %s\n' "$expected_sha" >&2
  exit 1
fi
if ! git -C "$root" diff --quiet "$expected_sha" -- \
  benchmarks/cli-comparison schemas harness; then
  printf 'Error: corpus or harness differs from pinned commit %s\n' "$expected_sha" >&2
  exit 1
fi

while IFS=$'\t' read -r identifier expected_path; do
  actual="$(
    lms ps --json |
      jq -r --arg id "$identifier" '.[] | select(.identifier == $id) | .indexedModelIdentifier'
  )"
  if [[ "$actual" != "$expected_path" ]]; then
    printf 'Error: model %s is not loaded as %s\n' "$identifier" "$expected_path" >&2
    exit 1
  fi
done < <(
  jq -r '.models[] | [.identifier, .indexedModelIdentifier] | @tsv' "$models"
)

while IFS= read -r task_id; do
  workspace="$root/canary/workspaces/$task_id"
  if [[ ! -d "$workspace/.git" ]]; then
    printf 'Error: missing prepared workspace: %s\n' "$workspace" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$workspace" status --porcelain)" ]]; then
    printf 'Error: workspace is dirty: %s\n' "$workspace" >&2
    exit 1
  fi
  if [[ "$(cat "$workspace/.canary/corpus-sha")" != "$expected_sha" ]]; then
    printf 'Error: workspace corpus SHA mismatch: %s\n' "$task_id" >&2
    exit 1
  fi
done < <(jq -r '.tasks[].taskId' "$tasks")

opencode_models="$(
  cd "$root/canary/workspaces/brownfield-008-js-to-ts-migration"
  opencode models lmstudio
)"
while IFS= read -r identifier; do
  if ! grep -Fq "lmstudio/$identifier" <<<"$opencode_models"; then
    printf 'Error: OpenCode does not expose lmstudio/%s\n' "$identifier" >&2
    exit 1
  fi
done < <(jq -r '.models[].identifier' "$models")

command -v go >/dev/null || missing_gate_tools+=("go")
command -v mvn >/dev/null || missing_gate_tools+=("maven")
if ! /usr/libexec/java_home >/dev/null 2>&1; then
  missing_gate_tools+=("java-17")
fi

printf 'OK: corpus, workspaces, model identities, and OpenCode routing are valid.\n'
if (( ${#missing_gate_tools[@]} > 0 )); then
  printf 'Warning: deterministic gate tools missing: %s\n' \
    "$(IFS=,; printf '%s' "${missing_gate_tools[*]}")" >&2
  exit 2
fi
printf 'OK: all deterministic benchmark gate toolchains are available.\n'
