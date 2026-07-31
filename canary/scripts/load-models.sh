#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
catalog="$root/canary/config/models.json"

for command in lms jq; do
  command -v "$command" >/dev/null || {
    printf 'Error: required command not found: %s\n' "$command" >&2
    exit 1
  }
done

if ! lms server status 2>&1 | grep -qi 'server is running'; then
  lms server start --port 1234
fi

context_length="$(jq -r '.contextLength' "$catalog")"
parallel="$(jq -r '.parallelPerModel' "$catalog")"

while IFS=$'\t' read -r key identifier expected_path disable_mtp; do
  loaded_path="$(
    lms ps --json |
      jq -r --arg id "$identifier" '.[] | select(.identifier == $id) | .indexedModelIdentifier'
  )"
  if [[ "$loaded_path" == "$expected_path" ]]; then
    printf 'OK: %s already loaded as %s\n' "$expected_path" "$identifier"
    continue
  fi
  if [[ -n "$loaded_path" ]]; then
    printf 'Error: identifier %s is bound to unexpected model %s\n' \
      "$identifier" "$loaded_path" >&2
    exit 1
  fi

  load_args=()
  if [[ "$disable_mtp" == "true" ]]; then
    load_args+=("--no-speculative-draft-mtp")
  fi
  lms load "$key" \
    --context-length "$context_length" \
    --parallel "$parallel" \
    --identifier "$identifier" \
    "${load_args[@]}" \
    --yes

  actual_path="$(
    lms ps --json |
      jq -r --arg id "$identifier" '.[] | select(.identifier == $id) | .indexedModelIdentifier'
  )"
  if [[ "$actual_path" != "$expected_path" ]]; then
    printf 'Error: %s resolved to %s, expected %s\n' \
      "$identifier" "${actual_path:-<missing>}" "$expected_path" >&2
    exit 1
  fi
done < <(
  jq -r '.models[] |
    [.lmStudioKey, .identifier, .indexedModelIdentifier, (.disableMtp // false)] |
    @tsv' "$catalog"
)

printf 'OK: all three Qwen models are loaded with verified physical identities.\n'
lms ps --json |
  jq '[.[] | select(.identifier | startswith("qwen36-")) |
    {identifier, indexedModelIdentifier, contextLength, parallel, status}]'
