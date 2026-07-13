# AgentsKit Code Review

**Deep, low-noise AI code review with the model you already use.**

[![CI](https://github.com/AgentsKit-io/code-review-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/AgentsKit-io/code-review-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)

Run code review locally or on every pull request. Bring Claude, Codex, OpenAI, Gemini, Ollama, OpenRouter, or another AgentsKit adapter. Seven specialized review lenses find potential problems; adversarial verification filters weak findings before they reach your team.

## Why this exists

Most AI reviewers are easy to start and hard to trust: they produce long lists of stylistic opinions, repeat the same concern, and bury the issue that can actually break production.

AgentsKit Code Review is built around a different contract:

- **Bring your own model.** Use an existing CLI subscription, an API provider, a local model, or your own gateway.
- **Low noise by design.** Findings are challenged by independent verification votes before they survive.
- **Local first, CI ready.** Review a diff before pushing, inspect complete paths, read stdin, or comment directly on a GitHub PR.
- **Control cost and policy.** Set file budgets, concurrency, thresholds, project conventions, and blocking severity.

## Quickstart

Clone the repository and choose the provider you already have:

```sh
npm install

# Use a logged-in local CLI — no API key
npm run review -- --provider codex-cli
npm run review -- --provider claude-cli

# Use an API provider
OPENAI_API_KEY=... npm run review -- --provider openai --model gpt-4o

# Keep code on your machine with Ollama
npm run review -- --provider ollama --model llama3 --base-url http://localhost:11434
```

By default, the CLI reviews your local diff against `origin/main`, prints Markdown, and exits with `1` only when a surviving finding reaches the configured blocking severity.

> The npm package metadata is ready for `@agentskit/code-review`, but the package is not available until the first release is published. Until then, use the cloned repository or the GitHub Action.

## Use the GitHub Action

Add `.github/workflows/code-review.yml` to any repository:

```yaml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: AgentsKit-io/code-review-cli@main
        with:
          provider: openai
          model: gpt-4o
          api-key: ${{ secrets.LLM_API_KEY }}
          # fail-on-block: 'true' # advisory by default
          # block: high
```

The Action fetches the PR diff and posts one batched inline review plus a summary. It is advisory by default. Enable `fail-on-block` and branch protection when you are ready to use it as a merge gate.

Use `@main` while the project is pre-release. After the first stable release, pin `@v1` or a full release tag when reproducibility matters most.

## Choose how to run

| Mode | Provider examples | Credentials | Best for |
|---|---|---|---|
| Local CLI | `codex-cli`, `claude-cli` | Existing CLI login | Local development or self-hosted runners |
| Hosted API | `openai`, `anthropic`, `gemini`, `mistral`, `groq` | Provider API key | Managed CI |
| Local model | `ollama` | Usually none | Privacy and predictable cost |
| Gateway | `openrouter` or a custom `--base-url` | Gateway-specific | Central routing and policy |

Provider names other than the two local CLIs resolve to factories exported by [`@agentskit/adapters`](https://www.npmjs.com/package/@agentskit/adapters). Run `npm run review -- --list-providers` for common choices.

Credentials resolve in this order:

1. `--api-key`
2. `LLM_API_KEY`
3. `<PROVIDER>_API_KEY`, such as `OPENAI_API_KEY`

Secrets passed to the GitHub Action are forwarded through the environment, not included in command-line arguments.

## How review works

```text
diff / PR / paths / stdin
          ↓
   normalize targets
          ↓
  7 specialized lenses
          ↓
 adversarial verification
          ↓
 thresholds + CI policy
          ↓
Markdown / GitHub / SARIF
```

The review agent lives in `agents/code-review/` and is vendored from the [AgentsKit registry](https://github.com/AgentsKit-io/agentskit-registry/tree/main/registry/code-review). The CLI owns provider selection, input sources, policy, and reporting.

## Common commands

```sh
# Tune verification and severity
npm run review -- --provider codex-cli --base main --votes 5 --min-severity high

# Review a GitHub PR and post the result
GITHUB_TOKEN=... npm run review -- --provider openai --model gpt-4o \
  --pr owner/repo#42 --post

# Review complete files or directories
npm run review -- --provider claude-cli --paths src --max-files 30

# Review piped source and also write SARIF
echo 'const x = a.b' | npm run review -- --provider ollama --model llama3 \
  --base-url http://localhost:11434 --stdin --lang ts --sarif out.sarif
```

## CLI reference

| Flag | Meaning |
|---|---|
| `--provider <name>` | Required provider: local CLI or `@agentskit/adapters` factory |
| `--model <id>` | Model id; required for API/local-server providers |
| `--api-key <key>` | Provider key; environment variables are preferred |
| `--base-url <url>` | Provider endpoint, local server, or gateway |
| `--base <ref>` | Git diff base; default `origin/main` |
| `--pr owner/repo#N` | GitHub PR source; requires `GITHUB_TOKEN` |
| `--paths <p...>` | Complete files or directories |
| `--stdin [--lang ts]` | Source read from stdin |
| `--post` | Post a batched review when the source is a PR |
| `--sarif <file>` | Also write SARIF |
| `--votes <n>` | Adversarial verification votes; default `3` |
| `--min-severity <level>` | Minimum reported severity |
| `--min-confidence <n>` | Minimum reported confidence |
| `--max-files <n>` | File budget |
| `--concurrency <n>` | Parallel model calls; default `4` |
| `--validate-patch` | Run `git apply --check` on suggested patches |
| `--block <severity>` | CI gate floor; default `blocker` |
| `--no-fail` | Keep findings advisory |
| `--conventions <path>` | Inject project conventions |
| `--api` | Back-compatible alias for `--provider anthropic` |
| `--help` | Full command help |

When no conventions path is supplied, the CLI looks for `CONVENTIONS.md`, `CONTRIBUTING.md`, `.cursorrules`, or `AGENTS.md`.

## Cost and privacy

A full review runs seven lenses across selected files and then verifies candidate findings. Control usage with `--max-files`, `--votes`, `--concurrency`, paths, and workflow triggers. For sensitive code, use a local model or an approved private gateway; provider data policies still apply to hosted APIs.

## Contributing

Providers, review lenses, reporters, fixtures, documentation, and false-positive reductions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), browse issues labeled `good first issue`, or propose a new provider/lens with the issue templates.

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Roadmap

The near-term roadmap focuses on a stable `v1` Action, npm distribution, provider smoke tests, better cost visibility, and more community-owned review lenses. See [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE) © AgentsKit contributors.
