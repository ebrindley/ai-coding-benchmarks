# Security Policy

This repository **intentionally contains buggy and insecure code**. The
fixtures, tasks, and oracles include deliberate bugs, vulnerabilities, and
insecure patterns because they are benchmark material for evaluating AI coding
tools.

## Do not report fixture bugs as vulnerabilities

Please **do not** report benchmark fixture bugs or intentionally vulnerable
examples as security vulnerabilities. They are part of the test material, not
defects in this repository.

## Optional harness and untrusted execution

This repository includes an **optional** local harness under `harness/`. When
you run it:

- Fixtures and task-declared gates/oracles may execute **untrusted or
  intentionally vulnerable code**.
- Gate/oracle commands are intended to run only under a **static confinement
  adapter**. If the platform confinement primitive is unavailable, the harness
  fails closed (marks execution unavailable) rather than running gate content
  bare by accident.
- Isolated trial workspaces are temporary git trees copied from fixtures into a
  **separate execution root** (not under the campaign control tree). They must
  not inherit this repository's agent instruction files as trusted policy for
  the model under test.
- **Provider invocations** (poetic-adapter, native-cli, poetic-system) are
  wrapped in an OS confinement layer while the process tree is alive:
  - macOS: `sandbox-exec` with `(allow default)` plus explicit **deny** of
    `file-read*` / `file-write*` on the canonical campaign tree.
  - Linux: `bwrap` with a tmpfs mask over the campaign path.
  - If the primitive is unavailable, the harness **fails closed**
    (`execution_unavailable`) and does **not** spawn unconfined providers.
  - Invocation request/output/prompt scratch lives only under the execution
    workspace; the trusted harness copies/quarantines into campaign storage
    **after** the provider exits.
  - Honesty: this denies access to the campaign path under the outer
    confinement; it does not claim full multi-tenant isolation, and nested
    sandboxes inside Poetic (if any) run *within* this outer restriction.
- Raw provider output is **secret-bearing**. It is quarantined under the
  campaign directory, excluded from sanitized export by default, and must not be
  committed. The `export` command produces a sanitized bundle; upload/publish is
  out of scope for this repository.

Pull-request and governance posture are unchanged: this is still a fixed
reference corpus with optional tooling, not an invitation to run unreviewed
third-party automation against production systems.

## Scope of security tooling

Security tooling here is limited to **secret-leak prevention** (e.g. secret
scanning, push protection, and a local pre-commit secret scan). This repository
does **not** run general vulnerability or code-bug scanning, and such reports
will be closed.

## Reporting an actual secret or private data exposure

If you find a genuinely sensitive exposure — an exposed secret, credential,
token, private file, or personal data accidentally committed here — please
report it via [Issues](../../issues), or through GitHub's private security
advisory path if enabled. These reports are taken seriously.
