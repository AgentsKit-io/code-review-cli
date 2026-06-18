# code-review-cli

A thin local CLI over the agentskit [`code-review`](https://github.com/AgentsKit-io/agentskit-registry/tree/main/registry/code-review) agent. **LLM-agnostic**: defaults to your **local `claude -p`** (no key); `--provider <name>` runs it on any `@agentskit/adapters` provider (anthropic, openai, gemini, grok, ollama, …).

The agent is **vendored** under `agents/code-review/` (shadcn-style — copied from the registry, we own it). This repo is just the CLI + the `claude -p` adapter.

## Setup

```sh
npm install
```

## Use

```sh
# review the local diff vs origin/main → Markdown report, exit 1 on a surviving blocker
npm run review

# tune
npm run review -- --base main --votes 5 --min-severity high
npm run review -- --pr owner/repo#42 --post           # batched PR review (needs GITHUB_TOKEN)
npm run review -- --paths src --max-files 30 --sarif out.sarif
echo "const x = a.b" | npm run review -- --stdin --lang ts
npm run review -- --provider openai --model gpt-4o     # any provider (key: --api-key / OPENAI_API_KEY / LLM_API_KEY)
npm run review -- --provider ollama --model llama3 --base-url http://localhost:11434
```

### Flags

| flag | meaning |
|---|---|
| `--base <ref>` | git-diff base (default `origin/main`) |
| `--pr owner/repo#N` | review a GitHub PR (needs `GITHUB_TOKEN`) |
| `--paths <p…>` | review whole files/dirs (architectural pass; pair with `--max-files`) |
| `--stdin [--lang ts]` | review piped source |
| `--post` | (with `--pr`) post a batched inline review + summary comment |
| `--sarif <file>` | also write SARIF |
| `--votes <n>` | adversarial verify votes (default 3) |
| `--min-severity` / `--min-confidence` | thresholds |
| `--max-files <n>` / `--concurrency <n>` | budget / parallel model calls |
| `--validate-patch` | `git apply --check` each suggested patch |
| `--block <severity>` | CI gate floor (default `blocker`) |
| `--conventions <path>` | inject a conventions doc (else auto-detects CONVENTIONS/CONTRIBUTING/AGENTS) |
| `--provider <name>` | LLM provider: `claude-cli` (default) or any `@agentskit/adapters` factory (anthropic, openai, gemini, grok, ollama, …) |
| `--api-key <key>` | provider key (else `LLM_API_KEY` / `<PROVIDER>_API_KEY` env) |
| `--base-url <url>` | provider base URL (ollama / openrouter / gateway) |
| `--api` | back-compat alias for `--provider anthropic` |

### CI gate

Exit code is `1` when a finding at/above `--block` survives verify+threshold, `0` otherwise, `2` on error. Drop it in a CI step:

```sh
npm run review -- --base "$GITHUB_BASE_REF" --api --block high
```

## Use as a GitHub Action (review every PR)

This repo is also a composite Action. Add a workflow to any repo (`.github/workflows/code-review.yml`):

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
          provider: 'anthropic'      # or openai / gemini / grok / groq / openrouter / ollama / …
          model: 'claude-opus-4-8'
          api-key: ${{ secrets.LLM_API_KEY }}
          # fail-on-block: 'true'    # gate merges (default: advisory — posts only)
          # block: 'high'
```

**LLM-agnostic.** `provider` is any `@agentskit/adapters` factory (`anthropic`, `openai`, `gemini`, `grok`, `ollama`, `deepseek`, `mistral`, `groq`, `openrouter`, `together`, …) or `claude-cli` for the local `claude -p`. Inputs: `provider`, `api-key` (passed via env, not the command line), `base-url` (for ollama/openrouter/gateways), `model`, `github-token` (default `${{ github.token }}`), `block`, `fail-on-block`, `votes`, `max-files`. It fetches the PR diff via the API and posts a batched inline review + summary. **Advisory by default** — set `fail-on-block: 'true'` to fail the check (and block merge with branch protection).

> Cost: every PR open/push runs 7 lenses × files × votes against the API. Tune `max-files` / `votes`, or scope the trigger, to control spend.

### Run it locally on a self-hosted runner (claude -p, no API cost)

Point a [self-hosted runner](https://docs.github.com/actions/hosting-your-own-runners) at your machine where Claude Code is logged in, then set `provider: 'claude-cli'` and `runs-on: self-hosted` — the review runs through your local `claude -p` (no API key, no cost). See `examples/pull-request-selfhosted.yml`. The example adds `$HOME/.local/bin` to `PATH` so a launchd-started runner can find `claude`.

## Updating the vendored agent

```sh
cp ../agentskit-registry/registry/code-review/{agent,lenses,sources,reporters}.ts agents/code-review/
```
