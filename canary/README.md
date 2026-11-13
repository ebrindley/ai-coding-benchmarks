# Qwen3.6 Build Canary

This disposable canary compares three locally hosted Qwen3.6 configurations:

- Qwen3.6 27B MLX 6-bit
- Qwen3.6 27B UD Q4_K_XL GGUF
- Qwen3.6 35B-A3B MLX 6-bit

Each task runs sequentially. Within a task, all three model arms run
simultaneously through OpenCode and Build with a concurrency limit of three.
Build uses an anonymized AI primary judge and the multi-lens secondary judge.
Lab mode preserves every variant worktree and never applies a winner.

The installed MLX OptiQ 4-bit model is excluded because LM Studio MLX 1.10.1
rejects its embedded MTP tensors. The verified installed Q4_K_XL GGUF is used
instead. Therefore the 27B 6-bit versus 4-bit result includes a runtime-format
contrast (MLX versus GGUF) in addition to quantization.

The four tasks are:

1. `brownfield-008-js-to-ts-migration`
2. `brownfield-015-ts-event-store-snapshot-bug`
3. `brownfield-013-java-order-concurrency-bug`
4. `greenfield-007-go-kv-http-service`

Prepare and verify:

```bash
canary/scripts/load-models.sh
canary/scripts/prepare-workspaces.sh
canary/scripts/probe-models.sh
canary/scripts/preflight.sh
```

Run one task:

```bash
canary/scripts/run-canary.sh brownfield-008-js-to-ts-migration
```

Run all four sequentially:

```bash
canary/scripts/run-canary.sh
```

The corpus is pinned to commit
`9eef589959858af368b168e674685ef597468fa1`. Runtime logs and generated fixture
repositories remain under ignored `canary/logs/` and `canary/workspaces/`.

Preparation reads fixture and task bytes directly from that commit, even when
the checkout has newer files. Preflight checks those prepared bytes and rejects
additional meaningful files; ignored dependencies and build artifacts are allowed.
It also requires the checkout's corpus and harness to match the pin. Preparing
pinned workspaces does not bypass that check or update the pin.

Only the OpenCode model-list probe uses the ignored `canary/.config/` directory
as its XDG configuration home. Build and the canary run keep their existing
configuration resolution.
