---
type: package
package: code-review-cli
editRoot: .
checks: [npm run check, npm pack --dry-run]
---

# Code Review CLI handoff

## Purpose

Provider-neutral, low-noise AI code review for local Git diffs, files/stdin, and GitHub pull requests. Seven focused lenses propose findings; adversarial votes remove weak findings; reporters emit Markdown, GitHub reviews, and SARIF.

## Ownership map

- `src/cli.ts`: public flags, source selection, provider selection, exit policy.
- `src/*-adapter.ts`: logged-in local CLI adapters.
- `agents/code-review/`: review pipeline, lenses, input normalization, reporters.
- `action.yml`: composite GitHub Action contract.
- `.github/workflows/release.yml`: Changesets version-pull-request workflow.
- `.github/workflows/publish.yml`: version-PR-gated npm Trusted Publishing and GitHub Release workflow.
- `examples/`: copy-ready Action workflows.
- `README.md` and `docs/OPERATIONS.md`: public adoption and operations guidance.
- `ecosystem.json`, `llms.txt`, and `llms-full.txt`: canonical product graph and machine-readable discovery/full-corpus surfaces.
- `test/`: credential-free CLI, Action, and documentation contract proofs.

## Boundaries

- Depend on AgentsKit adapter/runtime/tool contracts; do not create a second model abstraction.
- Preserve provider neutrality and advisory-by-default Action behavior.
- Never expose provider keys in arguments, docs fixtures, logs, or PR output.
- This product intentionally has no Fumadocs site and no embedded AgentsChat.
- The vendored review agent tracks the AgentsKit Registry source; keep divergences explicit.

## Change routes

- CLI flag/provider behavior: start at `src/cli.ts`, then update README, operations docs, and tests.
- Local CLI subprocess behavior: start at the matching `src/*-adapter.ts` and add an offline fixture.
- Review logic or noise reduction: start at `agents/code-review/agent.ts` and the relevant lens; prove both survival and rejection behavior.
- GitHub comments/SARIF: start at `agents/code-review/reporters.ts` and verify permissions/failure docs.
- Action input: update `action.yml`, `examples/pull-request.yml`, README, and contract tests together.
- Release automation: update `.github/workflows/release.yml`, `.github/workflows/publish.yml`, Changesets configuration, and the automated publishing section in `docs/OPERATIONS.md` together.

## Verification

```bash
npm ci
npm run check
npm pack --dry-run
```

`npm run check` includes typecheck, build, an end-to-end offline stdin review, Action/documentation tests, Doc Bridge gates, and CLI help.

## Ecosystem routes

- AgentsKit — runtime, adapters, and custom review agents: https://www.agentskit.io/docs
- Registry — ready-made agent source: https://registry.agentskit.io/docs
- AgentsKit Chat — conversational delivery; do not embed a chat runtime here: https://chat.agentskit.io/docs
- Playbook — engineering discipline before verification: https://playbook.agentskit.io/docs
- Doc Bridge — documentation ownership, freshness, and handoff generation: https://agentskit-io.github.io/doc-bridge/
- AKOS — enterprise orchestration and production governance: https://akos.agentskit.io/docs

Use `llms.txt` for discovery and `llms-full.txt` only when the complete public, operational, and agent-handoff context is required.

## Human guide

- README: https://raw.githubusercontent.com/AgentsKit-io/code-review/main/README.md
- Operations guide: https://raw.githubusercontent.com/AgentsKit-io/code-review/main/docs/OPERATIONS.md
- Contributing: https://raw.githubusercontent.com/AgentsKit-io/code-review/main/CONTRIBUTING.md
- Security: https://raw.githubusercontent.com/AgentsKit-io/code-review/main/SECURITY.md
