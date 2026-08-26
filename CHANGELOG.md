# Changelog

All notable changes will be documented here. This project follows Semantic Versioning.

## [Unreleased]

### Changed

- Added strict versioned `.agentskit-review.json` policy with lens coverage, budgets, thresholds, context, and safe CI precedence; incomplete profiles require explicit local opt-in.
- Hardened the shared local CLI worker with cancellation, process-tree cleanup, isolated temporary environments, bounded output, and redacted diagnostics.
- Added bounded source snapshots with infrastructure/configuration file support, denylisted sensitive paths, symlink checks, input limits, and data-boundary-aware secret redaction.
- Added provider-free `--plan`/`--dry-run` preflight with explicit file/byte/call budgets, bounded retries, CLI concurrency defaults, and fail-closed required-lens coverage.
- Made reviews fail closed when any reviewable file has no successful primary lens or cannot be ingested; advisory mode now suppresses finding-based failures only, never source/provider/execution failures.
- Added primary-lens execution coverage to review summaries so partial provider degradation is visible.
- Repositioned the CLI and GitHub Action as provider-neutral.
- Made provider selection explicit and removed provider-specific model defaults.
- Added package metadata, CLI help, open-source governance, and contribution guidance.
