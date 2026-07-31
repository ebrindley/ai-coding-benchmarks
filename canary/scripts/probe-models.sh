#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
catalog="$root/canary/config/models.json"
probe_dir="$root/canary/logs/model-probe"
mkdir -p "$probe_dir"

for command in curl jq; do
  command -v "$command" >/dev/null || {
    printf 'Error: required command not found: %s\n' "$command" >&2
    exit 1
  }
done

pids=()
identifiers=()
while IFS= read -r identifier; do
  output="$probe_dir/$identifier.json"
  payload="$(
    jq -nc --arg model "$identifier" '{
      model: $model,
      messages: [{role: "user", content: "Reply with exactly READY and nothing else."}],
      max_tokens: 256,
      temperature: 0
    }'
  )"
  curl --fail --silent --show-error \
    --max-time 600 \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    http://127.0.0.1:1234/v1/chat/completions > "$output" &
  pids+=("$!")
  identifiers+=("$identifier")
done < <(jq -r '.models[].identifier' "$catalog")

failed=0
for index in "${!pids[@]}"; do
  identifier="${identifiers[$index]}"
  if ! wait "${pids[$index]}"; then
    printf 'Error: concurrent API probe failed: %s\n' "$identifier" >&2
    failed=1
    continue
  fi
  output="$probe_dir/$identifier.json"
  response_model="$(jq -r '.model // empty' "$output")"
  response_text="$(jq -r '.choices[0].message.content // empty' "$output")"
  if [[ -z "$response_text" ]]; then
    printf 'Error: empty API response from %s\n' "$identifier" >&2
    failed=1
    continue
  fi
  printf 'OK: %s responded concurrently (reported model: %s)\n' \
    "$identifier" "${response_model:-unreported}"
done

exit "$failed"
