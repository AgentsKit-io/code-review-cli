# code-review-cli

A thin local CLI over the agentskit [`code-review`](https://github.com/AgentsKit-io/agentskit-registry/tree/main/registry/code-review) agent. Default LLM is your **local `claude -p`** (no API key); `--api` switches to the Anthropic API for CI.

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
npm run review -- --api --model claude-opus-4-8        # use the Anthropic API instead of claude -p
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
| `--api [--model m]` | use the Anthropic API (`ANTHROPIC_API_KEY`) instead of `claude -p` |

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
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # fail-on-block: 'true'   # gate merges (default: advisory — posts only)
          # block: 'high'
```

Add `ANTHROPIC_API_KEY` as a repo/org secret. In CI the LLM is the **Anthropic API** (no `claude -p`). Inputs: `anthropic-api-key` (required), `github-token` (default `${{ github.token }}`), `model`, `block`, `fail-on-block`, `votes`, `max-files`. It fetches the PR diff via the API and posts a batched inline review + summary. **Advisory by default** — set `fail-on-block: 'true'` to fail the check (and block merge with branch protection).

> Cost: every PR open/push runs 7 lenses × files × votes against the API. Tune `max-files` / `votes`, or scope the trigger, to control spend.

## Updating the vendored agent

```sh
cp ../agentskit-registry/registry/code-review/{agent,lenses,sources,reporters}.ts agents/code-review/
```
