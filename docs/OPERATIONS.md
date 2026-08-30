# Code Review operations guide

This guide is the repository-native reference for running AgentsKit Code Review locally and in CI. The CLI is the source of truth for flags; run `agentskit-review --help` against the version or commit you use.

## Provider and credential choices

| Provider class | Examples | Secret or login | Network boundary |
|---|---|---|---|
| Logged-in local CLI | `codex-cli`, `claude-cli`, `grok-cli`, `opencode-cli` | Existing local login | Provider CLI policy |
| Hosted API | `openai`, `anthropic`, `gemini`, `mistral`, `groq` | Repository/org secret | Selected code reaches provider |
| Local model | `ollama` | Usually none | Host or runner network only |
| Gateway | `openrouter`, custom `--base-url` | Gateway secret | Gateway policy and routing |

Credential precedence is `--api-key`, `LLM_API_KEY`, then `<PROVIDER>_API_KEY`. Prefer environment variables and GitHub secrets: process arguments may be visible to other processes or captured by diagnostics. The composite Action forwards its secret through `LLM_API_KEY` and never adds it to CLI arguments.

Do not run hosted review on code whose policy forbids external processing. A local model reduces external disclosure but does not remove the need to secure the runner, logs, cache, and generated SARIF.

## Provider registry and doctor

Provider IDs are versioned registry entries. `grok` is the xAI API adapter, while `grok-cli` and `opencode-cli` are stable local CLI providers. `--list-providers` prints registry metadata and dynamically discovered API factories, including each support level (`stable`, `experimental`, or `unsupported`), transport, and model requirement.

Use the offline doctor before execution:

```sh
npx --yes github:AgentsKit-io/code-review-cli doctor --provider codex-cli
npx --yes github:AgentsKit-io/code-review-cli doctor --provider openai --model gpt-4o --json
```

It checks the named executable and version, transport, model requirement, configuration mode, and credential presence without making a model request. API keys are represented only as `configured` or `missing`; they are never printed. Local CLI credentials are represented as login-managed because login storage is provider-specific. `doctor --live` is the explicit provider smoke-test path. Unknown local CLI versions warn during local runs and fail in CI. Doctor exits `0` when checks pass, `1` when a provider check fails, and `2` for invalid usage.

## First local setup

```sh
git clone https://github.com/AgentsKit-io/code-review-cli.git
cd code-review-cli
npm install
npm run check
npx --yes github:AgentsKit-io/code-review-cli --provider opencode-cli --transport acp --model openai/gpt-4o --no-fail
```

The last command requires an installed and authenticated OpenCode CLI. For a
credential-free verification, `npm run check` uses only the committed offline
fixtures. Precedence is explicit CLI flags, then the repository's
`.agentskit-review.json` policy, then safe defaults; the project file never
selects a trusted execution mode or carries credentials.

## Grok Build CLI via ACP

`grok-cli` is stable and uses `--transport acp` by default. It
starts `grok agent stdio --no-auto-update`, performs the ACP initialize,
authentication (when advertised), session, prompt, update, shutdown, and exit
sequence, then emits one `submit_findings` tool call. The worker accepts only a
`schemaVersion: 1` envelope with valid findings; malformed output gets one
bounded retry.

In the default `isolated` mode, provide `XAI_API_KEY` through the environment
or `--api-key`; the selected key is copied only into the temporary worker
environment. Existing `grok login` state is available only with explicit
local-only `--mode trusted-local`. Filesystem writes, terminal, MCP, plugin,
and subagent requests are denied, and the worker never uses the checkout as
its working directory. `doctor --provider grok-cli` checks executable/version
availability without making a model request. Headless mode is documented below
and must be selected explicitly.

## OpenCode CLI via ACP

`opencode-cli` is stable and uses `--transport acp` by default.
It starts `opencode acp`, performs the ACP initialize, session, prompt, update,
shutdown, and exit sequence, then emits one validated `submit_findings` tool
call. When `--model` is provided it is passed as OpenCode's `--model` option.
The worker allows no filesystem writes, terminal, MCP, plugin, or subagent
requests and retries malformed output once.

In the default `isolated` mode, provide `OPENCODE_API_KEY` through the
environment or `--api-key`; the selected key is copied only into the temporary
worker environment. Existing OpenCode login/configuration state is available
only with explicit local-only `--mode trusted-local`. The CLI does not install
OpenCode automatically.
`doctor --provider opencode-cli` checks executable/version availability without
making a model request. Headless mode is documented below and must be selected
explicitly.

## Grok and OpenCode headless transport

Headless mode is explicit with `--transport headless`. Grok uses
`grok --no-auto-update -p <prompt> --output-format json`; OpenCode uses
`opencode run --format json [--model provider/model] <prompt>`. Their output
framings are parsed separately and normalized to the same strict
`schemaVersion: 1` envelope. Surrounding logs are bounded and tolerated only
when the validated envelope can still be recovered.

`--transport auto` is a local convenience for these two providers:
it tries ACP first, reports the reason on stderr, then tries the provider's
headless command. It is rejected in CI so a pipeline cannot silently change
transport. Both paths use the same isolated worker timeout, output cap,
cancellation, temporary working directory, selected-credential injection, and
redacted diagnostics. Neither path installs a provider CLI automatically.

The executable compatibility source of truth is
[`provider-compatibility.json`](./provider-compatibility.json). It lists the
stable providers, every supported transport, required lenses, minimum version,
and the offline fixture that proves each cell. A provider remains experimental
until its registry entry, matrix, fixtures, and doctor checks are all green.

## pre-commit integration

The root `.pre-commit-hooks.yaml` exposes `agentskit-review` as a Node hook. It uses `pass_filenames: false` because the CLI reviews a Git diff, explicit paths, a pull request, or stdin rather than interpreting positional filenames. It is confined to the `manual` stage by default so cloning the hook does not silently add model calls to every commit.

Consumer configuration must select a provider through `args`. Keep credentials in the provider login or environment; never place API keys in `.pre-commit-config.yaml`. Before overriding the hook to `stages: [pre-push]`, decide whether findings are advisory, set a file budget, and confirm that provider latency and data handling are appropriate for every contributor.

The default diff base remains `origin/main`. A pre-commit invocation does not mean the input is limited to the Git staging area. Set `--base` explicitly when the repository uses another integration branch.

## Versioned review configuration

Use a strict `.agentskit-review.json` at the repository root for review policy.
It requires `configVersion: 1` and supports lens policy (`enabled` and
`required` per built-in lens), votes, retries, thresholds, file/byte/call and
concurrency budgets, conventions, and context selection. All built-in lenses
are enabled by default; correctness, security, and tests are required.
The shared local worker also accepts bounded `timeoutMs` and `maxOutputBytes`
settings; absolute ceilings are always enforced.

Flags override file values. The file cannot contain credentials or executable
plugins. Provider, model, transport, trust mode, redaction, permissions, and
other execution inputs are rejected when supplied by the project config in CI.
An intentionally incomplete profile must say `incompleteProfile: true` and be
run locally with `--allow-incomplete`; it is rejected in CI and cannot become an
approval. Malformed, unknown, or unsafe configuration exits `2` before a model
request and diagnostics do not print config values.

Keep policy-only configuration in the file. Use trusted workflow flags or the
runner environment for provider selection, credentials, and execution mode.

`prompt` is the default context mode. To review an explicit repository snapshot,
set `context.mode` to `isolated-snapshot` and provide repository-relative
patterns such as `src/**` or `!src/generated/**`. Sensitive directories/files,
symlink escapes, binaries, and over-limit inputs are excluded and shown as
`UNREVIEWED`. The default snapshot ceiling is 100 files/5 MiB; the absolute
ceiling is 500 files/25 MiB. Prompt files default to 256 KiB with a 1 MiB
absolute per-file ceiling.

Remote and unknown provider boundaries receive high-confidence credential
redaction while preserving file and line context. `--allow-unredacted` is a
local-only escape hatch and is rejected in CI; never use it for untrusted code.

## Local Ollama review

Ollama serves its local API at `http://localhost:11434` by default. Verify the service without sending repository content:

```sh
curl --fail --silent http://localhost:11434/api/tags >/dev/null
```

Choose a tool-capable model that fits the host; tool calling is required because every lens submits a structured result. `qwen2.5-coder:7b` is a practical starting point for machines that cannot run the larger `qwen3-coder:30b`; model quality, context capacity, latency, and memory requirements vary. Pulling a model downloads several gigabytes and does not start a review:

```sh
ollama pull qwen2.5-coder:7b
```

Start with a bounded, advisory branch review:

```sh
npx --yes github:AgentsKit-io/code-review-cli \
  --provider ollama \
  --model qwen2.5-coder:7b \
  --base main \
  --base-url http://localhost:11434 \
  --max-files 10 \
  --concurrency 1 \
  --no-fail
```

The default source is the committed Git diff from `--base` to `HEAD`. It does not mean “only staged files,” even when invoked by a Git hook. Use `--paths` when complete files are the intended source. Avoid piping a unified Git patch through `--stdin`: stdin is treated as one source file rather than parsed into per-file changed ranges.

Seven primary lenses plus adversarial votes can be expensive for a local model, and each structured result can require more than one model turn. Begin with `--max-files 10`, `--concurrency 1`, and the default three votes. Reduce the file set before reducing verification depth. `--no-fail` makes surviving findings advisory; it does not hide an unavailable model, malformed response, unreadable source, or failed lens coverage.

For a self-hosted runner, bind Ollama only to the network interfaces required by the job, isolate the runner per repository trust boundary, and protect job logs and artifacts. Do not set a hosted gateway as `--base-url` and describe the run as local. Any optional telemetry or observability exporter creates a separate network boundary that must be approved explicitly.

Troubleshooting:

- **Connection refused:** start Ollama and repeat the `/api/tags` health check.
- **Model not found:** run `ollama pull <exact-model-id>` and pass the same id to `--model`.
- **Slow or out-of-memory:** choose a smaller model, reduce `--max-files`, and keep `--concurrency 1`.
- **Context overflow:** review narrower paths or a smaller branch diff; unreviewed files must remain visibly outside the result.
- **No findings with exit 0:** inspect the summary and successful/failed lens counts; advisory output is not proof that every file was reviewed.

## GitHub Action permissions

The copy-ready workflow in [`examples/pull-request.yml`](../examples/pull-request.yml) requires:

```yaml
permissions:
  contents: read
  pull-requests: write
```

`contents: read` loads the PR source. `pull-requests: write` posts the batched review. Do not grant repository administration, package write, or workflow write. Fork PRs do not receive normal repository secrets; do not switch to `pull_request_target` merely to expose a model key, because that can execute or process untrusted contributions with privileged context.

Use environment protection or organization secrets for sensitive providers. Rotate a secret after suspected exposure and review provider usage plus GitHub audit logs.

When `--post` is used with `--pr`, the reviewer stores a hidden SHA and policy
fingerprint marker in the summary comment. Re-running the same head SHA with
the same policy skips provider calls and updates no comments. A new SHA uses
GitHub compare scope only when the previous marked SHA is an ancestor; a
missing marker, force-push, or changed fingerprint falls back to the full PR
file list. Fork PRs are reported as `SKIPPED` with exit `2` on this workflow
boundary; do not switch to `pull_request_target` to expose secrets. Summary
comments are reconciled by marker, while POST/PATCH failures remain visible for
manual retry.

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

Use `--plan --json` (or `--dry-run`) to run the source and budget preflight without a model request. The plan reports files, bytes, enabled and required lenses, votes, retries, concurrency, estimated provider calls, and concrete reductions when a limit would be exceeded. Estimates are `bounded` when `thresholds.maxPerFile` is set and `best-effort` otherwise, because model output volume is variable. The preflight refuses before the provider starts; `maxCalls` is capped at 1000 and unlimited mode is not supported. A required-lens failure is `INCOMPLETE` and exits `2`, including with `--no-fail`.

## Cost and latency controls

Seven lenses fan out over selected files; candidate findings then receive adversarial votes. The primary controls are:

- `--max-files`: positive hard file budget;
- `--max-calls`: bounded provider-call budget (absolute ceiling 1000);
- `--votes`: verification depth and cost;
- `--concurrency`: simultaneous model/subprocess calls (default 1 for CLI providers, 4 for API providers);
- `--paths` or workflow path filters: narrow scope;
- `--min-severity` and `--min-confidence`: output noise, not input-token cost.

Start advisory with a small file budget, measure provider usage, and raise depth only where it improves signal. Never present an unmeasured cost estimate as a guaranteed price.

## SARIF

`--sarif out.sarif` writes SARIF 2.1.0 alongside Markdown. Each surviving finding includes a `code-review/<category>` rule, severity level, message, file, and line. Uploading SARIF to GitHub code scanning requires the separate `security-events: write` permission and `github/codeql-action/upload-sarif`; the bundled Action does not request that permission or upload automatically.

SARIF can contain source paths and model-generated explanations. Apply the same retention and access policy as CI logs.

### Route findings through reviewdog

[reviewdog](https://github.com/reviewdog/reviewdog) accepts SARIF directly, so no AgentsKit-specific reporter or converter is required. This complete pull-request job installs reviewdog, fetches the base history, generates the report in advisory mode, and lets reviewdog own diff filtering, annotations, and the final CI threshold:

```yaml
name: AgentsKit reviewdog
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          fetch-depth: 0
      - uses: reviewdog/action-setup@d8edfce3dd5e1ec6978745e801f9c50b5ef80252 # v1.4.0
        with:
          reviewdog_version: v0.21.0
      - name: Review changed code
        env:
          BASE_REF: ${{ github.base_ref }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          REVIEWDOG_GITHUB_API_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          REPORT_FILE="$(mktemp)"
          trap 'rm -f "${REPORT_FILE}"' EXIT
          npx --yes github:AgentsKit-io/code-review-cli#3dfd7427640148281454d52846d369e5ddf85b11 \
            --provider openai --model gpt-4o --base "origin/${BASE_REF}" \
            --sarif "${REPORT_FILE}" --no-fail &&
          reviewdog -f=sarif -name=agentskit-review \
            -reporter=github-pr-review -filter-mode=added -fail-level=error \
            < "${REPORT_FILE}"
```

The hosted-runner example uses an API provider because local CLI providers require their executable and an existing authenticated session. Replace the provider and model with your approved adapter. The base comes from the pull-request event rather than assuming `main`, and `fetch-depth: 0` makes its remote-tracking ref available to `git diff`. Pass the provider secret through `LLM_API_KEY`, pass the workflow token through `REVIEWDOG_GITHUB_API_TOKEN`, and grant only `contents: read` plus `pull-requests: write`.

The temporary report and `&&` prevent reviewdog from reading stale output when the producer fails. Keep `--no-fail` on the producer so reviewdog receives the complete report when review succeeds; `-fail-level=error` then makes SARIF `error` findings fail the reviewdog step. AgentsKit maps blocker and high findings to SARIF `error`, medium to `warning`, and nit to `note`.

The default `added` filter limits inline feedback to changed lines. Choose a broader reviewdog filter deliberately; broader modes can move findings outside the PR diff into checks, annotations, or console output depending on the reporter. Pin both Code Review and reviewdog to reviewed immutable versions in enforcement workflows.

## Failure scenarios

- **Unknown provider or missing model:** validate with `--list-providers`; API/local-server adapters require `--model`.
- **Authentication failure:** verify only the provider-specific secret/login and avoid printing its value.
- **Rate limit or timeout:** Codex calls stop after 300 seconds by default; other local CLI calls use 120 seconds. Set `AGENTSKIT_REVIEW_SUBPROCESS_TIMEOUT_MS` to a positive millisecond value when needed, reduce concurrency/file budget, or use an approved gateway; retry only when provider policy makes the operation safe.
- **No PR comments:** confirm `pull-requests: write`, token availability, and fork restrictions. The Markdown report still appears in logs.
- **Inline comment rejected:** the reporter falls back to a non-approving comment for GitHub 422 restrictions.
- **Large diff:** GitHub PR reviews cap metadata at 500 files, select only the configured file budget before downloading contents, and stop content downloads at the byte budget. Set `--max-files`/`--max-calls` or split review by paths; truncated or unreviewed files must not be described as reviewed.
- **Ollama timeout:** Requests stop after 30 seconds by default. Use a smaller scope or a responsive local model when the request is aborted; a stalled model must not hold the review indefinitely.
- **Provider unavailable:** fail or mark the check unavailable according to team policy; never silently convert it to approval.

## Releases and maturity

The current package is `0.2.1` and the project is pre-v1:

- GitHub-source CLI commands can pin a commit SHA after `github:AgentsKit-io/code-review-cli#<sha>`;
- Actions should pin `@v0.2.1` or a full commit SHA;
- a moving `@main` reference is suitable only when that mutability is accepted;
- the future `@v1` Action tag remains a separate stability milestone.

Release work updates [`CHANGELOG.md`](../CHANGELOG.md), [`ROADMAP.md`](../ROADMAP.md), package version, immutable tag guidance, and signed/provenance evidence when available. Run `npm run check` and `npm pack --dry-run` before publishing.

### Automated npm publishing

`.github/workflows/publish.yml` publishes only when a stable GitHub Release is published with a semantic version tag such as `v0.2.1`. The workflow checks out that tag, verifies that the tag matches `package.json`, runs `npm run check` and `npm pack --dry-run`, then publishes `@agentskit/code-review` using [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC). No long-lived `NPM_TOKEN` is stored in GitHub.

Before the first release, configure the npm package's Trusted Publisher for GitHub Actions with:

- Organization: `AgentsKit-io`
- Repository: `code-review`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

The npm configuration is a one-time external prerequisite; the GitHub workflow cannot create it. For each release, update the package version and changelog in a reviewed commit, push the commit, then create the matching GitHub Release/tag. Do not run `npm publish` locally.

## Contribution and security

Start with [`CONTRIBUTING.md`](../CONTRIBUTING.md). Provider integrations must preserve the AgentsKit adapter contract and keep secrets out of arguments/logs. Review lenses need reproducible evidence and false-positive fixtures. Report vulnerabilities privately through [`SECURITY.md`](../SECURITY.md).

For adjacent work, use [AgentsKit](https://www.agentskit.io/docs) for runtime and adapters, [Registry](https://registry.agentskit.io/docs) for the vendored agent, [AgentsKit Chat](https://chat.agentskit.io/docs) when review belongs inside a conversational application, [Playbook](https://playbook.agentskit.io/docs) for engineering patterns, [Doc Bridge](https://agentskit-io.github.io/doc-bridge/) for documentation ownership handoffs, and [AKOS](https://akos.agentskit.io/docs) for enterprise orchestration and production governance.

Machine readers should start with [`llms.txt`](../llms.txt), escalate to [`llms-full.txt`](../llms-full.txt) only when the complete corpus is required, and use [`docs/for-agents`](./for-agents/index.md) before changing an owned module.
