# Changelog

All notable changes will be documented here. This project follows Semantic Versioning.

## [Unreleased]

### Changed

- Added strict versioned `.agentskit-review.json` policy with lens coverage, budgets, thresholds, context, and safe CI precedence; incomplete profiles require explicit local opt-in.
- Made reviews fail closed when any reviewable file has no successful primary lens or cannot be ingested; advisory mode now suppresses finding-based failures only, never source/provider/execution failures.
- Added primary-lens execution coverage to review summaries so partial provider degradation is visible.
- Repositioned the CLI and GitHub Action as provider-neutral.
- Made provider selection explicit and removed provider-specific model defaults.
- Added package metadata, CLI help, open-source governance, and contribution guidance.
