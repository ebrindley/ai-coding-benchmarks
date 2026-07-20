# rust-rpn-calc fixture

Greenfield Rust fixture: implement a reverse-Polish-notation (RPN) calculator
from a stub. Zero third-party dependencies — standard library and `cargo test`
only (the `[dependencies]` table in `Cargo.toml` is empty).

- Implement `eval` in `src/lib.rs` so all tests under `tests/` pass.
- `src/main.rs` is a thin CLI wrapper that reads an expression from argv and
  prints the result; it is provided and should not need changes.
- Do not edit files under `tests/` (baseline-diff protected).

Run:

```sh
cargo test
```
