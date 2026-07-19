# Ecosystem documentation — Code Review tracer

## Objective

Make Code Review a complete, repository-native member of the seven-product AgentsKit ecosystem without adding Fumadocs or an embedded chat surface.

## Acceptance criteria

- The canonical ecosystem manifest lists AgentsKit, Registry, Chat, Playbook, Doc Bridge, Code Review, and AKOS with stable public URLs.
- The README remains concise, keeps its verified examples and maturity contract, and presents all six sibling products as contextual next steps.
- Documentation-related guidance points to Doc Bridge, conversational UI guidance points to AgentsKit Chat, and enterprise operation guidance points to AKOS.
- `llms.txt` is a compact discovery map with human, agent, raw-source, and ecosystem routes.
- `llms-full.txt` exposes the complete repository documentation corpus without bloating `llms.txt`.
- `docs/for-agents/` identifies ownership, change routes, ecosystem hooks, and required checks.
- Doc Bridge remains exactly 100/100 with fresh committed artifacts.

## Test plan

### Unit and contract tests

- Verify the canonical manifest contains seven unique products in the expected order.
- Verify Code Review resolves exactly six siblings and that every public URL is HTTPS.
- Verify `llms.txt` stays concise and links `llms-full.txt`, raw sources, for-agents, and all six siblings.
- Verify `llms-full.txt` contains the README, operations guide, and agent handoffs.
- Verify the README contains the six-peer continuation table and the three strategic hooks.

### Integration and regression

- Run TypeScript typecheck, build, offline CLI review, Action/documentation contract tests, and README Standard v1.
- Run Doc Bridge index, gate, and doctor; require 100/100 and fresh artifacts.
- Run `npm pack --dry-run` and confirm the two LLM surfaces, ecosystem manifest, and agent handoffs ship.
- Preserve provider neutrality, advisory-by-default behavior, and the repository-native no-Fumadocs/no-AgentsChat-runtime boundary.

### Edge cases

- Reject duplicate or missing ecosystem product identifiers.
- Keep secrets and provider keys out of generated machine-readable docs.
- Avoid claims of stable npm or `v1` Action distribution while the project remains pre-v1.
- Ensure GitHub raw-source links are pinned to the public `main` path and do not expose local filesystem paths.

## Documentation impact

- `README.md`
- `llms.txt` and `llms-full.txt`
- `docs/for-agents/`
- `docs/OPERATIONS.md`
- `ecosystem.json`
- Doc Bridge generated artifacts and README freshness hash

## Definition of Done

- All acceptance criteria are implemented.
- `npm run check` passes.
- `npm pack --dry-run` passes with the required documentation payload.
- Doc Bridge reports 100/100 A with all gates passing.
- No commit, push, release, or PR is created without explicit user authorization.

## Upstream adoption record

- Reuse the approved seven-product ecosystem manifest and documentation-quality language from the central AgentsKit documentation contract.
- Keep review primitives on AgentsKit adapters/runtime and the Registry-sourced review agent; no local model or agent abstraction is introduced.
