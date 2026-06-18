#!/usr/bin/env node
/**
 * Thin local CLI over the registry `code-review` agent. Default LLM is the local
 * `claude -p` (no API key); `--api` switches to the Anthropic API for CI.
 *
 *   code-review                              # review git diff vs origin/main → Markdown
 *   code-review --base main --votes 5
 *   code-review --pr owner/repo#42 --post    # post a batched PR review (needs GITHUB_TOKEN)
 *   code-review --paths src --whole-repo --max-files 30 --sarif out.sarif
 *   echo "const x=a.b" | code-review --stdin --lang ts
 *   code-review --api --model claude-opus-4-8 ...   # use the Anthropic API
 *
 * Exit code: 1 when a finding at/above --block (default "blocker") survives — wire to CI.
 */
import { anthropic } from '@agentskit/adapters'
import { createProgressObserver } from '@agentskit/ink'
import { readFileSync } from 'node:fs'
import { createCodeReviewAgent, type CodeReviewConfig, type Reporter, type Severity } from '../agents/code-review/agent.js'
import { githubInlineReporter, githubSummaryReporter, markdownReporter, sarifReporter } from '../agents/code-review/reporters.js'
import { claudeCode } from './claude-code-adapter.js'
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
    const paths = process.argv.slice(i + 1).filter((a) => !a.startsWith('--'))
    return { kind: 'paths', paths, cwd: process.cwd() }
  }
  return { kind: 'git-diff', base: flag('base') ?? 'origin/main', cwd: process.cwd() }
}

async function main() {
  const source = await resolveSource()
  const adapter = has('api')
    ? anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, model: flag('model') ?? 'claude-opus-4-8' })
    : claudeCode({ model: flag('model') })

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
  process.exit(review.blocking ? 1 : 0)
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
