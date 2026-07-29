# Contributing

Thanks for helping make AI code review more useful and less noisy.

## Start here

1. Fork and clone the repository.
2. Create a focused branch from `main`.
3. Run `npm install`.
4. Make the smallest change that solves the issue.
5. Run `npm run check` before opening a pull request.

Node.js 20 or newer is required.

## Project map

- `src/cli.ts` — arguments, providers, review policy, and reporters.
- `src/*-adapter.ts` — adapters for logged-in local CLIs.
- `agents/code-review/` — vendored review agent, lenses, sources, and reporters.
- `action.yml` — GitHub Action interface.
- `examples/` — copy-ready workflows.

## Good contributions

- Reduce a reproducible false positive.
- Add a provider through the existing adapter contract.
- Add a focused review lens with clear evidence requirements.
- Improve a reporter or source without tying it to one model.
- Add provider-neutral examples and documentation.

Please open an issue before a large architectural change. Small fixes and documentation improvements can go straight to a pull request.

## Pull requests

- Keep one concern per PR.
- Explain the user-visible behavior and how you tested it.
- Add or update tests for behavior changes.
- Preserve provider neutrality: provider-specific behavior belongs in its adapter.
- Never commit API keys, model output containing private code, or review tokens.
- Update README or examples when changing the public CLI or Action interface.

Project decisions, maintainer responsibilities, and the release process are
documented in [GOVERNANCE.md](GOVERNANCE.md).

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
