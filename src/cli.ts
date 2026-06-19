#!/usr/bin/env node
/**
 * Thin local CLI over the registry `code-review` agent. LLM-agnostic: default is the
 * local `claude -p` (no key); `--provider <name>` selects ANY @agentskit/adapters
 * factory (anthropic, openai, gemini, grok, ollama, deepseek, mistral, groq,
 * openrouter, together, …).
 *
 *   code-review                                      # claude -p, git diff vs origin/main
 *   code-review --pr owner/repo#42 --post            # post a batched PR review (GITHUB_TOKEN)
 *   code-review --provider openai --model gpt-4o     # any provider (key via --api-key / *_API_KEY / LLM_API_KEY)
 *   code-review --provider ollama --model llama3 --base-url http://localhost:11434
 *   echo "const x=a.b" | code-review --stdin --lang ts
 *
 * Exit code: 1 when a finding at/above --block survives (unless --no-fail) — wire to CI.
 */
import * as adapters from '@agentskit/adapters'
import type { AdapterFactory } from '@agentskit/core'
import { createProgressObserver } from '@agentskit/ink'
import { readFileSync } from 'node:fs'
import { createCodeReviewAgent, type CodeReviewConfig, type Reporter, type Severity } from '../agents/code-review/agent.js'
import { githubInlineReporter, githubSummaryReporter, markdownReporter, sarifReporter } from '../agents/code-review/reporters.js'
import { claudeCode } from './claude-code-adapter.js'
import { codexCli } from './codex-adapter.js'
import type { SourceConfig } from '../agents/code-review/sources.js'

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

async function resolveSource(): Promise<SourceConfig> {
  const pr = flag('pr')
  if (pr) {
    const m = pr.match(/^([^/]+)\/([^#]+)#(\d+)$/)
    if (!m) throw new Error('--pr must be owner/repo#number')
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('--pr needs GITHUB_TOKEN')
    return { kind: 'github-pr', owner: m[1]!, repo: m[2]!, number: Number(m[3]), token }
  }
  if (has('stdin')) return { kind: 'stdin', content: await readStdin(), filename: `snippet.${flag('lang') ?? 'txt'}` }
  if (has('paths')) {
    const i = process.argv.indexOf('--paths')
    const paths: string[] = []
    for (let j = i + 1; j < process.argv.length && !process.argv[j]!.startsWith('--'); j++) paths.push(process.argv[j]!)
    if (!paths.length) throw new Error('--paths needs at least one file/dir')
    return { kind: 'paths', paths, cwd: process.cwd() }
  }
  return { kind: 'git-diff', base: flag('base') ?? 'origin/main', cwd: process.cwd() }
}

async function main() {
  const source = await resolveSource()
  const adapter = buildAdapter()

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
    auditVotes: flag('votes') ? Number(flag('votes')) : undefined,
    validatePatch: has('validate-patch'),
    blockingSeverity: (flag('block') as Severity) ?? 'blocker',
    budget: { maxFiles: flag('max-files') ? Number(flag('max-files')) : undefined, concurrency: flag('concurrency') ? Number(flag('concurrency')) : 4 },
    conventions: flag('conventions') ? { path: flag('conventions')! } : autoConventions(),
    thresholds: {
      minSeverity: flag('min-severity') as Severity | undefined,
      minConfidence: flag('min-confidence') ? Number(flag('min-confidence')) : undefined,
    },
  }

  const review = await createCodeReviewAgent(config).run()
  // --no-fail = advisory: post the review but never fail the job (exit 0). Real errors
  // still surface via the catch below (exit 2).
  process.exit(review.blocking && !has('no-fail') ? 1 : 0)
}

/**
 * LLM-agnostic adapter selection. `claude-cli` (default) uses the local `claude -p`;
 * any other name resolves to a `@agentskit/adapters` factory and is given
 * `{ apiKey, model, baseUrl? }`. `--api` is a back-compat alias for `--provider anthropic`.
 */
function buildAdapter(): AdapterFactory {
  const provider = flag('provider') ?? (has('api') ? 'anthropic' : 'claude-cli')
  const model = flag('model') ?? (provider === 'anthropic' ? 'claude-opus-4-8' : undefined)
  if (provider === 'claude-cli') return claudeCode({ model })
  if (provider === 'codex-cli') return codexCli({ model })

  const make = (adapters as Record<string, unknown>)[provider]
  if (typeof make !== 'function') {
    throw new Error(`unknown --provider "${provider}". Use "claude-cli" or any @agentskit/adapters factory (anthropic, openai, gemini, grok, ollama, deepseek, mistral, groq, openrouter, together, …).`)
  }
  if (!model) throw new Error(`--model is required for provider "${provider}"`)
  const apiKey = flag('api-key') ?? process.env.LLM_API_KEY ?? process.env[`${provider.toUpperCase()}_API_KEY`] ?? ''
  const baseUrl = flag('base-url')
  return (make as (c: Record<string, unknown>) => AdapterFactory)({ apiKey, model, ...(baseUrl ? { baseUrl } : {}) })
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
