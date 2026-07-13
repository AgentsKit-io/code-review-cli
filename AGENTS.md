# AGENTS.md — AgentsKit Code Review

Read [`docs/for-agents/code-review-cli.md`](docs/for-agents/code-review-cli.md) before editing. It owns the module map, public boundaries, change routes, and verification commands.

## Non-negotiable boundaries

- Keep provider behavior behind the AgentsKit adapter contract.
- Keep the GitHub Action advisory by default; blocking is explicit policy.
- Never place API keys in arguments, fixtures, logs, documentation examples, or review output.
- Keep this product repository-native: do not add Fumadocs or embedded AgentsChat.
- Update public docs and offline tests with any CLI, provider, reporter, or Action contract change.

## Verification

Run both commands before shipping:

```bash
npm run check
npm pack --dry-run
```
