#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tasks="$root/canary/config/tasks.json"
opencode_config="$root/canary/config/opencode.json"
corpus_sha="9eef589959858af368b168e674685ef597468fa1"

for command in jq rsync git; do
  command -v "$command" >/dev/null || {
    printf 'Error: required command not found: %s\n' "$command" >&2
    exit 1
  }
done

while IFS=$'\t' read -r task_id task_file fixture; do
  workspace="$root/canary/workspaces/$task_id"
  if [[ -e "$workspace/.git" ]]; then
    printf 'OK: workspace already prepared: %s\n' "$task_id"
    continue
  fi
  if [[ -e "$workspace" ]]; then
    printf 'Error: refusing to overwrite non-repository path: %s\n' "$workspace" >&2
    exit 1
  fi

  mkdir -p "$workspace/.canary"
  rsync -a "$root/$fixture/" "$workspace/"
  cp "$root/$task_file" "$workspace/.canary/task.yaml"
  cp "$opencode_config" "$workspace/opencode.json"
  printf '%s\n' "$task_id" > "$workspace/.canary/task-id"
  printf '%s\n' "$corpus_sha" > "$workspace/.canary/corpus-sha"

  git -C "$workspace" init --quiet
  git -C "$workspace" switch --create "validation/$task_id" --quiet
  git -C "$workspace" add .
  git -C "$workspace" commit --quiet -m "Prepare $task_id canary baseline"
  printf 'OK: prepared %s\n' "$workspace"
done < <(
  jq -r '.tasks[] | [.taskId, .taskFile, .fixture] | @tsv' "$tasks"
)
