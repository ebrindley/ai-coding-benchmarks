# Security Policy

This repository **intentionally contains buggy and insecure code**. The
fixtures, tasks, and oracles include deliberate bugs, vulnerabilities, and
insecure patterns because they are benchmark material for evaluating AI coding
tools.

## Do not report fixture bugs as vulnerabilities

Please **do not** report benchmark fixture bugs or intentionally vulnerable
examples as security vulnerabilities. They are part of the test material, not
defects in this repository.

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
