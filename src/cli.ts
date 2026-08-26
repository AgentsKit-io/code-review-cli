#!/usr/bin/env node
/**
 * Thin local CLI over the registry `code-review` agent. Provider-agnostic:
 * `--provider <name>` selects a local CLI or any @agentskit/adapters
 * factory (anthropic, openai, gemini, grok, ollama, deepseek, mistral, groq,
 * openrouter, together, …).
 *
 *   agentskit-review --provider codex-cli            # local CLI, git diff vs origin/main
 *   code-review --pr owner/repo#42 --post            # post a batched PR review (GITHUB_TOKEN)
 *   code-review --provider openai --model gpt-4o     # any provider (key via --api-key / *_API_KEY / LLM_API_KEY)
 *   code-review --provider ollama --model llama3 --base-url http://localhost:11434
 *   echo "const x=a.b" | code-review --stdin --lang ts
 *
 * Exit code: 1 when a finding at/above --block survives (unless --no-fail) — wire to CI.
 */
import type { AdapterFactory } from '@agentskit/core'
import { createProgressObserver } from '@agentskit/ink'
import { readFileSync } from 'node:fs'
import { builtInLenses, createCodeReviewAgent, type Category, type CodeReviewConfig, type Reporter, type Severity } from '../agents/code-review/agent.js'
import { githubInlineReporter, githubSummaryReporter, markdownReporter, sarifReporter } from '../agents/code-review/reporters.js'
import { claudeCode } from './claude-code-adapter.js'
import { codexCli } from './codex-adapter.js'
import { ollamaReview } from './ollama-adapter.js'
import type { SourceConfig } from '../agents/code-review/sources.js'
import { diagnoseProvider, factoryFor, providerEntry, providerRegistry, resolveProviderId, type DoctorReport, type ProviderEntry } from './provider-registry.js'
import { loadReviewConfig, type ResolvedReviewConfig } from './review-config.js'

const HELP = `AgentsKit Code Review — deep, low-noise review with your model

Usage:
  agentskit-review --provider <name> [options]

Providers:
  codex-cli, claude-cli, or any @agentskit/adapters provider
  (anthropic, openai, gemini, ollama, openrouter, mistral, groq, ...)

Examples:
  agentskit-review --provider codex-cli
  agentskit-review --provider claude-cli --base main
  agentskit-review --provider openai --model gpt-4o
  agentskit-review --provider ollama --model llama3 --base-url http://localhost:11434

Sources:
  --base <ref>            Review the git diff against a base (default: origin/main)
  --pr <owner/repo#N>     Review a GitHub PR (requires GITHUB_TOKEN)
  --paths <paths...>      Review complete files or directories
  --stdin [--lang <ext>]  Review source from stdin

Review options:
  --votes <n>             Adversarial verification votes (default: 3)
  --min-severity <level>  Minimum finding severity
  --min-confidence <n>    Minimum finding confidence
  --block <level>         CI gate floor (default: blocker)
  --max-files <n>         Positive file budget
  --concurrency <n>       Parallel model calls (default: 4)
  --conventions <path>    Project conventions file
  --allow-incomplete      Local-only exception for an explicitly incomplete profile
  --allow-unredacted      Local-only exception for secret redaction
  --validate-patch        Validate suggested patches with git apply --check
  --sarif <file>          Also write a SARIF report
  --post                  Post a PR review (with --pr)
  --no-fail               Report findings without failing the process

Provider options:
  --model <id>            Model id (required for API/local-server providers)
  --api-key <key>         Or use LLM_API_KEY / <PROVIDER>_API_KEY
  --base-url <url>        Custom endpoint or local gateway
  --transport <name>      Provider transport (doctor validates it)
  --api                   Back-compatible alias for --provider anthropic

Diagnostics:
  doctor                  Check one provider without making a model request
  --live                  Explicitly enable a provider smoke test for doctor
  --json                  Emit machine-readable doctor output
  --mode <mode>           Configuration mode: isolated or trusted-local
  --ci                    Apply CI version and trust checks

  --help                  Show this help
  --list-providers        List common providers
`

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
  })
}

function shouldRedact(reviewConfig: ResolvedReviewConfig): boolean {
  const provider = reviewConfig.provider && resolveProviderId(reviewConfig.provider)
  const boundary = provider && providerEntry(provider)?.dataBoundary
  return (boundary === 'remote' || boundary === 'unknown') && !reviewConfig.allowUnredacted
}

async function resolveSource(reviewConfig: ResolvedReviewConfig): Promise<SourceConfig> {
  const redact = shouldRedact(reviewConfig)
  const limits = { maxFiles: reviewConfig.budget.maxFiles, maxBytes: reviewConfig.budget.maxBytes }
  const pr = flag('pr')
  if (pr) {
    const m = pr.match(/^([^/]+)\/([^#]+)#(\d+)$/)
    if (!m) throw new Error('--pr must be owner/repo#number')
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('--pr needs GITHUB_TOKEN')
    return { kind: 'github-pr', owner: m[1]!, repo: m[2]!, number: Number(m[3]), token, redact, limits }
  }
  if (has('stdin')) return { kind: 'stdin', content: await readStdin(), filename: `snippet.${flag('lang') ?? 'txt'}`, redact, limits: { ...limits, maxFileBytes: 1024 * 1024 } }
  if (has('paths')) {
    const i = process.argv.indexOf('--paths')
    const paths: string[] = []
    for (let j = i + 1; j < process.argv.length && !process.argv[j]!.startsWith('--'); j++) paths.push(process.argv[j]!)
    if (!paths.length) throw new Error('--paths needs at least one file/dir')
    return { kind: 'paths', paths, cwd: process.cwd(), redact, limits: { ...limits, maxFileBytes: 1024 * 1024 } }
  }
  if (reviewConfig.context.mode === 'isolated-snapshot') return { kind: 'isolated-snapshot', cwd: process.cwd(), patterns: reviewConfig.context.patterns, redact, limits: { ...limits, maxFileBytes: 1024 * 1024 } }
  return { kind: 'git-diff', base: flag('base') ?? 'origin/main', cwd: process.cwd(), redact, limits }
}

async function main() {
  if (has('help') || has('h')) {
    console.log(HELP)
    return
  }
  if (has('list-providers')) {
    console.log(providerRegistry().map(formatProvider).join('\n'))
    return
  }
  if (process.argv.includes('doctor') || has('doctor')) {
    await runDoctor()
    return
  }
  const reviewConfig = loadReviewConfig(process.cwd(), {
    ci: has('ci') || process.env.CI === 'true' || process.env.CI === '1',
    allowIncomplete: has('allow-incomplete'),
    allowUnredacted: has('allow-unredacted'),
    overrides: {
      provider: flag('provider') ?? (has('api') ? 'anthropic' : undefined),
      model: flag('model'),
      transport: flag('transport'),
      votes: flag('votes') === undefined ? undefined : Number(flag('votes')),
      minSeverity: flag('min-severity') as Severity | undefined,
      minConfidence: flag('min-confidence') === undefined ? undefined : Number(flag('min-confidence')),
      maxFiles: flag('max-files') === undefined ? undefined : Number(flag('max-files')),
      concurrency: flag('concurrency') === undefined ? undefined : Number(flag('concurrency')),
      conventions: flag('conventions'),
    },
  })
  const source = await resolveSource(reviewConfig)
  await preflightProvider(reviewConfig)
  const adapter = buildAdapter(reviewConfig)

  const reporters: Reporter[] = [markdownReporter()]
  const sarif = flag('sarif')
  if (sarif) reporters.push(sarifReporter({ file: sarif }))
  if (has('post') && source.kind === 'github-pr') {
    const { owner, repo, number, token } = source
    reporters.push(githubInlineReporter({ owner, repo, number, token }), githubSummaryReporter({ owner, repo, number, token }))
  }

  const config: CodeReviewConfig = {
    adapter,
    source,
    reporters,
    observers: [createProgressObserver()],
    lenses: builtInLenses(Object.entries(reviewConfig.lenses).filter(([, policy]) => policy.enabled).map(([key]) => key as Category)),
    incompleteProfile: reviewConfig.incompleteProfile,
    auditVotes: reviewConfig.votes,
    validatePatch: has('validate-patch'),
    blockingSeverity: (flag('block') as Severity) ?? 'blocker',
    budget: { maxFiles: reviewConfig.budget.maxFiles, concurrency: reviewConfig.budget.concurrency },
    conventions: reviewConfig.conventions ? { path: reviewConfig.conventions } : autoConventions(),
    thresholds: reviewConfig.thresholds,
  }

  const review = await createCodeReviewAgent(config).run()
  // --no-fail = advisory: post the review but never fail the job (exit 0). Real errors
  // still surface via the catch below (exit 2).
  process.exit(reviewConfig.incompleteProfile ? 2 : review.blocking && !has('no-fail') ? 1 : 0)
}

/**
 * Provider-neutral adapter selection. Local CLIs are explicit choices; any other
 * name resolves to a `@agentskit/adapters` factory and is given
 * `{ apiKey, model, baseUrl? }`. `--api` is a back-compat alias for `--provider anthropic`.
 */
function buildAdapter(reviewConfig: ResolvedReviewConfig): AdapterFactory {
  const requestedProvider = reviewConfig.provider
  const provider = requestedProvider && resolveProviderId(requestedProvider)
  if (!provider) throw new Error(requestedProvider ? `unknown --provider "${requestedProvider}" (run --list-providers for common options)` : 'choose a provider with --provider <name> (run --list-providers for common options)')
  const model = reviewConfig.model ?? (has('api') ? 'claude-opus-4-8' : undefined)
  const mode = flag('mode') === 'trusted-local' ? 'trusted-local' : 'isolated'
  if (provider === 'claude-cli') return claudeCode({ model, mode, worker: reviewConfig.worker })
  if (provider === 'codex-cli') return codexCli({ model, mode, worker: reviewConfig.worker })
  if (provider === 'ollama') {
    if (!model) throw new Error('--model is required for provider "ollama"')
    return ollamaReview({ model, ...(flag('base-url') ? { baseUrl: flag('base-url') } : {}) })
  }

  const entry = providerEntry(provider)
  const make = entry && factoryFor(entry)
  if (!entry || !make) throw new Error(`provider "${provider}" is registered but has no local adapter yet`)
  if (!model) throw new Error(`--model is required for provider "${provider}"`)
  const apiKey = flag('api-key') ?? process.env.LLM_API_KEY ?? process.env[`${provider.toUpperCase()}_API_KEY`] ?? ''
  const baseUrl = flag('base-url')
  return make({ apiKey, model, ...(baseUrl ? { baseUrl } : {}) })
}

async function preflightProvider(reviewConfig: ResolvedReviewConfig): Promise<void> {
  const requested = reviewConfig.provider
  const id = requested && resolveProviderId(requested)
  const entry = id && providerEntry(id)
  if (!entry || entry.kind === 'api') return
  const report = await diagnoseProvider({
    provider: entry.id,
    model: reviewConfig.model,
    transport: reviewConfig.transport,
    mode: flag('mode') ?? reviewConfig.trustMode,
    apiKey: flag('api-key'),
    ci: has('ci'),
  })
  const version = report.checks.find((check) => check.name === 'version')
  if (version?.status === 'warn') console.error(`warning: ${entry.id} ${version.detail}`)
  if (!report.ok) throw new Error(`${entry.id} provider preflight failed: ${report.checks.filter((check) => check.status === 'fail').map((check) => `${check.name}: ${check.detail}`).join('; ')}`)
}

async function runDoctor(): Promise<void> {
  const requested = flag('provider') ?? (has('api') ? 'anthropic' : undefined)
  if (!requested) throw new Error('doctor needs --provider <name>')
  const report = await diagnoseProvider({
    provider: requested,
    model: flag('model'),
    transport: flag('transport'),
    mode: flag('mode'),
    live: has('live'),
    ci: has('ci'),
    apiKey: flag('api-key'),
  })
  if (has('json')) console.log(JSON.stringify(report))
  else console.log(formatDoctor(report))
  if (!report.ok) process.exitCode = report.checks.some((check) => check.name === 'provider' && check.status === 'fail') ? 2 : 1
}

function formatProvider(entry: ProviderEntry): string {
  const aliases = entry.aliases.length ? `\taliases=${entry.aliases.join(',')}` : ''
  return `${entry.id}\tkind=${entry.kind}\tsupport=${entry.support}\ttransport=${entry.defaultTransport}\tmodel=${entry.model}${aliases}`
}

function formatDoctor(report: DoctorReport): string {
  const lines = [`Provider doctor: ${report.provider} (${report.support})`]
  for (const check of report.checks) lines.push(`  ${check.name}: ${check.status.toUpperCase()} — ${check.detail}`)
  lines.push(`Result: ${report.ok ? 'PASS' : 'FAIL'}`)
  return lines.join('\n')
}

/** Best-effort: feed a conventions doc to every lens if one exists. */
function autoConventions(): string | undefined {
  for (const f of ['CONVENTIONS.md', 'CONTRIBUTING.md', '.cursorrules', 'AGENTS.md']) {
    try {
      return readFileSync(f, 'utf8').slice(0, 6000)
    } catch {
      /* next */
    }
  }
  return undefined
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(2)
})
