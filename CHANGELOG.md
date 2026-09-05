# Changelog

All notable changes will be documented here. This project follows Semantic Versioning.

## [Unreleased]

## [0.4.0] - 2026-09-05

### Added

- Added machine-readable preflight manifests for reviewable and unreviewed files, with stable file-batch planning for external orchestration.
- Added private JSON review-result artifacts and SHA/policy-bound batch-coverage primitives for safe Orca aggregation.
- Added fail-closed consolidation: every batch artifact must match the immutable PR/SHA/policy/file manifest and have complete lens evidence before a single review can be published.
- Added CLI consolidation and publication gates so Orca can create exactly one review only from a current, complete consolidated artifact.

### Changed

- Expanded reviewable product files to include HTML, CSS, Markdown, and MDX.
- Made GitHub inline findings agent-actionable with correction rationale, required change, acceptance check, and verification confidence.
- Reworked the persistent PR walkthrough into a compact CodeRabbit-style status card; finding detail now lives only on the relevant inline review comments.

### Security

- Reject GitHub publication from a partial review batch; only a complete consolidated review may post.
- Document the intentionally local, private batch-artifact writes so CodeQL does not misclassify serialized PR metadata as executable file access.

## [0.3.0] - 2026-08-30

### Added

- Added global cancellation deadlines, provider health preflight, a circuit breaker, and bounded execution evidence.
- Added the explicit `fast` profile with a single required-lens batch for lower latency and predictable calls.
- Added CI Action inputs for profile, deadline, and health-check policy.

## [0.2.3] - 2026-08-30

### Fixed

- Stop issuing additional provider calls after a terminal authentication failure; reviews still fail closed without spending one failed call per lens.

## [0.2.2] - 2026-08-29

### Added

- Added a GitHub Release workflow for tag-verified npm Trusted Publishing with OIDC and provenance.

### Fixed

- Prevented Codex authentication, timeout, and process failures from being retried as output-schema compatibility failures.
- Documented and exposed explicit trusted-local mode for logged-in Codex/Claude CLI workflows.
- Raised the default Codex local-worker deadline to five minutes and made GitHub PR file budgets enforceable and fail-closed.
- Bounded GitHub Action calls, propagated Claude OAuth credentials, made review fingerprints version-aware, paginated comment reconciliation with a fail-closed cap, and bounded GitHub API responses.

## [0.2.1] - 2026-08-29

### Fixed

- Applied Codex timeout defaults in direct library usage, bounded GitHub PR metadata/content ingestion, and transient-only GitHub GET retries.
- Added Ollama request deadlines and integration coverage for rate limits, posting failures, stalled requests, and large PR limits.

## [0.2.0] - 2026-08-29

### Changed

- Added strict versioned `.agentskit-review.json` policy with lens coverage, budgets, thresholds, context, and safe CI precedence; incomplete profiles require explicit local opt-in.
- Hardened the shared local CLI worker with cancellation, process-tree cleanup, isolated temporary environments, bounded output, and redacted diagnostics.
- Added bounded source snapshots with infrastructure/configuration file support, denylisted sensitive paths, symlink checks, input limits, and data-boundary-aware secret redaction.
- Added provider-free `--plan`/`--dry-run` preflight with explicit file/byte/call budgets, bounded retries, CLI concurrency defaults, and fail-closed required-lens coverage.
- Made reviews fail closed when any reviewable file has no successful primary lens or cannot be ingested; advisory mode now suppresses finding-based failures only, never source/provider/execution failures.
- Added primary-lens execution coverage to review summaries so partial provider degradation is visible.
- Repositioned the CLI and GitHub Action as provider-neutral.
- Made provider selection explicit and removed provider-specific model defaults.
- Added bounded GitHub review reconciliation with SHA/policy fingerprints, incremental compare scope when the prior SHA is an ancestor, fork-safe skip behavior, and idempotent summary updates.
- Added experimental Grok Build CLI ACP support with isolated capability denial, versioned output validation, bounded invalid-output retry, and offline lifecycle fixtures.
- Added experimental OpenCode CLI ACP support with the same isolated, versioned, bounded worker contract and offline lifecycle fixtures.
- Added provider-specific Grok/OpenCode headless transports with explicit local-only ACP fallback via `--transport auto`.
- Added package metadata, CLI help, open-source governance, and contribution guidance.
