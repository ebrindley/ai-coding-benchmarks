#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
models="$root/canary/config/models.json"
tasks="$root/canary/config/tasks.json"
selected_task="${1:-}"

if "$root/canary/scripts/preflight.sh"; then
  :
else
  status=$?
  if [[ "$status" -eq 2 ]]; then
    printf 'Error: install the missing deterministic gate toolchains before running.\n' >&2
  fi
  exit "$status"
fi

variants=()
while IFS= read -r variant; do
  variants[${#variants[@]}]="$variant"
done < <(jq -r '.models[].buildVariant' "$models")
if [[ "${#variants[@]}" -ne 3 ]]; then
  printf 'Error: expected exactly three model variants.\n' >&2
  exit 1
fi

run_task() {
  local task_id="$1"
  local workspace="$root/canary/workspaces/$task_id"
  local started_at
  local log
  started_at="$(date -u +%Y%m%dT%H%M%SZ)"
  log="$root/canary/logs/${started_at}-${task_id}.log"

  printf '\nRunning %s with all three model arms.\n' "$task_id"
  (
    cd "$workspace"
    build run competition \
      --task-file .canary/task.yaml \
      --variant "${variants[0]}" \
      --variant "${variants[1]}" \
      --variant "${variants[2]}" \
      --max-concurrent 3 \
      --profile code-strict \
      --judge-run ai,multi-lens \
      --judge-primary ai \
      --lab=HEAD \
      --completion-mode isolated \
      --preserve-worktrees \
      --timeout 90
  ) 2>&1 | tee "$log"
}

if [[ -n "$selected_task" ]]; then
  if ! jq -e --arg id "$selected_task" '.tasks[] | select(.taskId == $id)' \
    "$tasks" >/dev/null; then
    printf 'Error: unknown task id: %s\n' "$selected_task" >&2
    exit 1
  fi
  run_task "$selected_task"
  exit 0
fi

while IFS= read -r task_id; do
  run_task "$task_id"
done < <(jq -r '.tasks[].taskId' "$tasks")
