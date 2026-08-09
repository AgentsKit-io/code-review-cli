# Code Review operations guide

This guide is the repository-native reference for running AgentsKit Code Review locally and in CI. The CLI is the source of truth for flags; run `agentskit-review --help` against the version or commit you use.

## Provider and credential choices

| Provider class | Examples | Secret or login | Network boundary |
|---|---|---|---|
| Logged-in local CLI | `codex-cli`, `claude-cli` | Existing local login | Provider CLI policy |
| Hosted API | `openai`, `anthropic`, `gemini`, `mistral`, `groq` | Repository/org secret | Selected code reaches provider |
| Local model | `ollama` | Usually none | Host or runner network only |
| Gateway | `openrouter`, custom `--base-url` | Gateway secret | Gateway policy and routing |

Credential precedence is `--api-key`, `LLM_API_KEY`, then `<PROVIDER>_API_KEY`. Prefer environment variables and GitHub secrets: process arguments may be visible to other processes or captured by diagnostics. The composite Action forwards its secret through `LLM_API_KEY` and never adds it to CLI arguments.

Do not run hosted review on code whose policy forbids external processing. A local model reduces external disclosure but does not remove the need to secure the runner, logs, cache, and generated SARIF.

## pre-commit integration

The root `.pre-commit-hooks.yaml` exposes `agentskit-review` as a Node hook. It uses `pass_filenames: false` because the CLI reviews a Git diff, explicit paths, a pull request, or stdin rather than interpreting positional filenames. It is confined to the `manual` stage by default so cloning the hook does not silently add model calls to every commit.

Consumer configuration must select a provider through `args`. Keep credentials in the provider login or environment; never place API keys in `.pre-commit-config.yaml`. Before overriding the hook to `stages: [pre-push]`, decide whether findings are advisory, set a file budget, and confirm that provider latency and data handling are appropriate for every contributor.

The default diff base remains `origin/main`. A pre-commit invocation does not mean the input is limited to the Git staging area. Set `--base` explicitly when the repository uses another integration branch.

## GitHub Action permissions

The copy-ready workflow in [`examples/pull-request.yml`](../examples/pull-request.yml) requires:

```yaml
permissions:
  contents: read
  pull-requests: write
```

`contents: read` loads the PR source. `pull-requests: write` posts the batched review. Do not grant repository administration, package write, or workflow write. Fork PRs do not receive normal repository secrets; do not switch to `pull_request_target` merely to expose a model key, because that can execute or process untrusted contributions with privileged context.

Use environment protection or organization secrets for sensitive providers. Rotate a secret after suspected exposure and review provider usage plus GitHub audit logs.

## Advisory and blocking behavior

The Action is advisory by default: `fail-on-block: 'false'` adds `--no-fail`. Findings still post, but surviving blocker/high findings do not fail the job. `--no-fail` never suppresses provider, source, reporter, or review-execution errors. For enforcement:

```yaml
with:
  block: high
  fail-on-block: 'true'
```

Then require the workflow check in branch protection. CLI exit codes are:

| Exit | Meaning | Operator action |
|---:|---|---|
| `0` | Review completed; no blocking finding, or advisory mode | Inspect posted/report output |
| `1` | A finding at or above `--block` survived | Fix, dismiss with evidence, or change policy intentionally |
| `2` | Configuration, provider, source, or reporter failure | Inspect stderr; do not interpret as a clean review |

A model response that is malformed may drop one lens while other lenses continue; progress output and the final summary report successful and failed primary-lens counts. If any reviewable file cannot be ingested or has zero successful primary lenses, the pipeline stops before reporters run and exits `2`, including in advisory mode. Treat missing output or exit `2` as unavailable review, not approval.

## Cost and latency controls

Seven lenses fan out over selected files; candidate findings then receive adversarial votes. The primary controls are:

- `--max-files`: positive hard file budget;
- `--votes`: verification depth and cost;
- `--concurrency`: simultaneous model/subprocess calls;
- `--paths` or workflow path filters: narrow scope;
- `--min-severity` and `--min-confidence`: output noise, not input-token cost.

Start advisory with a small file budget, measure provider usage, and raise depth only where it improves signal. Never present an unmeasured cost estimate as a guaranteed price.

## SARIF

`--sarif out.sarif` writes SARIF 2.1.0 alongside Markdown. Each surviving finding includes a `code-review/<category>` rule, severity level, message, file, and line. Uploading SARIF to GitHub code scanning requires the separate `security-events: write` permission and `github/codeql-action/upload-sarif`; the bundled Action does not request that permission or upload automatically.

SARIF can contain source paths and model-generated explanations. Apply the same retention and access policy as CI logs.

## Failure scenarios

- **Unknown provider or missing model:** validate with `--list-providers`; API/local-server adapters require `--model`.
- **Authentication failure:** verify only the provider-specific secret/login and avoid printing its value.
- **Rate limit or timeout:** reduce concurrency/file budget or use an approved gateway; retry only when provider policy makes the operation safe.
- **No PR comments:** confirm `pull-requests: write`, token availability, and fork restrictions. The Markdown report still appears in logs.
- **Inline comment rejected:** the reporter falls back to a non-approving comment for GitHub 422 restrictions.
- **Large diff:** cap `--max-files` and split review by paths; unreviewed files must not be described as reviewed.
- **Provider unavailable:** fail or mark the check unavailable according to team policy; never silently convert it to approval.

## Releases and maturity

The current package is `0.1.x` and the project is pre-v1. Before immutable releases exist:

- GitHub-source CLI commands can pin a commit SHA after `github:AgentsKit-io/code-review-cli#<sha>`;
- Actions can pin a full commit SHA instead of `@main`;
- `@main` follows repository updates and is suitable only when that mutability is accepted;
- the documented future `@agentskit/code-review` npm command and `@v1` Action tag must not be treated as released until published.

Release work updates [`CHANGELOG.md`](../CHANGELOG.md), [`ROADMAP.md`](../ROADMAP.md), package version, immutable tag guidance, and signed/provenance evidence when available. Run `npm run check` and `npm pack --dry-run` before publishing.

## Contribution and security

Start with [`CONTRIBUTING.md`](../CONTRIBUTING.md). Provider integrations must preserve the AgentsKit adapter contract and keep secrets out of arguments/logs. Review lenses need reproducible evidence and false-positive fixtures. Report vulnerabilities privately through [`SECURITY.md`](../SECURITY.md).

For adjacent work, use [AgentsKit](https://www.agentskit.io/docs) for runtime and adapters, [Registry](https://registry.agentskit.io/docs) for the vendored agent, [AgentsKit Chat](https://chat.agentskit.io/docs) when review belongs inside a conversational application, [Playbook](https://playbook.agentskit.io/docs) for engineering patterns, [Doc Bridge](https://agentskit-io.github.io/doc-bridge/) for documentation ownership handoffs, and [AKOS](https://akos.agentskit.io/docs) for enterprise orchestration and production governance.

Machine readers should start with [`llms.txt`](../llms.txt), escalate to [`llms-full.txt`](../llms-full.txt) only when the complete corpus is required, and use [`docs/for-agents`](./for-agents/index.md) before changing an owned module.
