import { writeFileSync } from 'node:fs'
import type { Finding, Reporter, ReviewResult } from './agent.js'
import { GITHUB_REQUEST_TIMEOUT_MS, githubIssueComments, readGithubResponseText } from '../../src/github-review-state.js'

/**
 * Reporters turn a ReviewResult into an output surface. They are orchestration code
 * (string building + GitHub REST), not model calls. Add your own by implementing
 * `Reporter` and passing it in `reporters`.
 *
 * The GitHub reporters POST directly to the REST API. The model-facing equivalents are
 * the `github_create_pr_review_comment` / `github_create_pr_review` tools in
 * `@agentskit/tools` — use those when an LLM should decide to post; use these reporters
 * when orchestration posts deterministically after the pipeline.
 */

const SEV_ORDER: Finding['severity'][] = ['blocker', 'high', 'med', 'nit']
const SEV_EMOJI: Record<Finding['severity'], string> = { blocker: '⛔', high: '🔴', med: '🟡', nit: '🔵' }

function groupBySeverity(findings: Finding[]): string {
  const lines: string[] = []
  for (const sev of SEV_ORDER) {
    const group = findings.filter((f) => f.severity === sev)
    if (!group.length) continue
    lines.push(`\n### ${SEV_EMOJI[sev]} ${sev} (${group.length})\n`)
    for (const f of group) {
      lines.push(`- **${f.file}:${f.line}** — ${f.title} _(${f.category}, conf ${f.confidence.toFixed(2)})_`)
      lines.push(`  - ${f.rationale}`)
      lines.push(`  - 💡 ${f.suggestion}`)
      if (f.suggestedPatch) {
        const tag = f.patchValidated === true ? ' (build-validated)' : f.patchValidated === false ? ' (does not apply)' : ''
        lines.push(`  - <details><summary>suggested patch${tag}</summary>\n\n\`\`\`diff\n${f.suggestedPatch}\n\`\`\`\n</details>`)
      }
    }
  }
  return lines.join('\n')
}

/** Human-readable Markdown — to a sink (default stdout) and optionally a file. */
export function markdownReporter(opts: { write?: (s: string) => void; file?: string } = {}): Reporter {
  const write = opts.write ?? ((s: string) => process.stdout.write(s))
  return {
    name: 'markdown',
    async emit(review: ReviewResult) {
      const md = renderMarkdown(review)
      if (opts.file) writeFileSync(opts.file, md)
      write(md + '\n')
    },
  }
}

export function renderMarkdown(review: ReviewResult): string {
  const evidence = `\n\n_Evidence: profile=${review.evidence.profile}; provider calls=${review.evidence.providerCalls} (failed=${review.evidence.failedProviderCalls}, skipped=${review.evidence.skippedProviderCalls}); elapsed=${review.evidence.elapsedMs}ms; circuit=${review.evidence.circuitState}${review.evidence.deadlineExceeded ? '; deadline exceeded' : ''}_`
  const head = `## Code review — ${review.verdict}\n\n${review.summary}${evidence}`
  const body = review.findings.length ? groupBySeverity(review.findings) : '\nNo findings above threshold. ✅'
  const dropped = review.dropped.length ? `\n\n_${review.dropped.length} finding(s) dropped (verify/threshold). ${review.droppedNote ?? ''}_` : ''
  return `${head}\n${body}${dropped}\n`
}

/**
 * Compact, persistent PR-thread status. The actionable detail belongs on the
 * inline review comments; repeating every finding here creates a second,
 * competing review that is hard to scan and can drift from the diff.
 */
export function renderGithubWalkthrough(review: ReviewResult): string {
  const severity = SEV_ORDER
    .map((level) => {
      const count = review.findings.filter((finding) => finding.severity === level).length
      return count ? `${SEV_EMOJI[level]} ${count} ${level}` : undefined
    })
    .filter((entry): entry is string => entry !== undefined)
    .join(' · ')
  const coverage = `${review.execution.succeeded}/${review.execution.attempted} lens executions`
  const outcome = review.findings.length
    ? 'Actionable findings are attached inline to the relevant changed lines.'
    : 'No findings met the configured review threshold.'
  const dropped = review.dropped.length
    ? ` ${review.dropped.length} candidate finding(s) were rejected during verification or thresholding.`
    : ''
  return [
    `## AgentsKit review · ${review.verdict}`,
    '',
    review.summary,
    '',
    `**Result:** ${severity || '✅ no findings'}  ·  ${coverage}`,
    '',
    outcome + dropped,
    '',
    '<details><summary>Review evidence</summary>',
    '',
    `- Profile: \`${review.evidence.profile}\``,
    `- Provider calls: ${review.evidence.providerCalls} (failed: ${review.evidence.failedProviderCalls}, skipped: ${review.evidence.skippedProviderCalls})`,
    `- Elapsed: ${review.evidence.elapsedMs}ms · Circuit: ${review.evidence.circuitState}${review.evidence.deadlineExceeded ? ' · deadline exceeded' : ''}`,
    '',
    '</details>',
  ].join('\n')
}

/** Machine output: SARIF 2.1.0 for GitHub code-scanning / dashboards. */
export function sarifReporter(opts: { file?: string; write?: (s: string) => void } = {}): Reporter {
  const sevToLevel: Record<Finding['severity'], string> = { blocker: 'error', high: 'error', med: 'warning', nit: 'note' }
  return {
    name: 'sarif',
    async emit(review: ReviewResult) {
      const rulesSeen = new Map<string, { id: string; name: string }>()
      const results = review.findings.map((f) => {
        const ruleId = `code-review/${f.category}`
        if (!rulesSeen.has(ruleId)) rulesSeen.set(ruleId, { id: ruleId, name: f.category })
        return {
          ruleId,
          level: sevToLevel[f.severity],
          message: { text: `${f.title} — ${f.rationale} Suggestion: ${f.suggestion}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: { startLine: f.line, ...(f.endLine ? { endLine: f.endLine } : {}) },
              },
            },
          ],
          properties: { severity: f.severity, confidence: f.confidence },
        }
      })
      const sarif = {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
          {
            tool: { driver: { name: 'agentskit-code-review', rules: [...rulesSeen.values()].map((r) => ({ id: r.id, name: r.name })) } },
            results,
          },
        ],
      }
      const text = JSON.stringify(sarif, null, 2)
      if (opts.file) writeFileSync(opts.file, text)
      if (opts.write) opts.write(text)
    },
  }
}

/** Private machine-readable handoff for an orchestrator; never posts to GitHub. */
export function jsonReporter(opts: { file: string }): Reporter {
  return { name: 'json', async emit(review: ReviewResult) { writeFileSync(opts.file, JSON.stringify(review, null, 2), { mode: 0o600 }) } }
}

async function githubPost(token: string, path: string, body: unknown): Promise<{ html_url?: string }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'agentskit-code-review',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = (await readGithubResponseText(res, 4096)).trim().slice(0, 300)
    throw new Error(`GitHub POST ${path} → ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  return JSON.parse(await readGithubResponseText(res)) as { html_url?: string }
}

async function githubPatch(token: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'agentskit-code-review',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = (await readGithubResponseText(res, 4096)).trim().slice(0, 300)
    throw new Error(`GitHub PATCH ${path} → ${res.status}${detail ? `: ${detail}` : ''}`)
  }
}

/** One summary comment on the PR thread (uses the issues endpoint — always available). */
export function githubSummaryReporter(c: { owner: string; repo: string; number: number; token: string; marker?: string }): Reporter {
  return {
    name: 'github-summary',
    async emit(review: ReviewResult) {
      const body = `${c.marker ? `${c.marker}\n` : ''}${renderGithubWalkthrough(review)}`
      if (!c.marker) {
        await githubPost(c.token, `/repos/${c.owner}/${c.repo}/issues/${c.number}/comments`, { body })
        return
      }
      const history = await githubIssueComments(c.token, c.owner, c.repo, c.number)
      if (history.truncated) throw new Error('GitHub review comment history is too large to update safely')
      const existing = history.comments.find((comment) => comment.id !== undefined && comment.body?.includes(c.marker!))
      if (existing) await githubPatch(c.token, `/repos/${c.owner}/${c.repo}/issues/comments/${existing.id}`, { body })
      else await githubPost(c.token, `/repos/${c.owner}/${c.repo}/issues/${c.number}/comments`, { body })
    },
  }
}

/**
 * A batched PR review: inline comments on findings that land inside the diff, plus an
 * overall verdict + summary body. Findings outside the diff are folded into the body
 * (GitHub rejects review comments on unchanged lines).
 */
export function githubInlineReporter(c: { owner: string; repo: string; number: number; token: string; commitId?: string; marker?: string }): Reporter {
  // Never emit APPROVE — a GitHub Actions token and your own PR both reject it (422).
  const eventFor = (v: ReviewResult['verdict']) => (v === 'REQUEST CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT')
  return {
    name: 'github-inline',
    async emit(review: ReviewResult) {
      const inline = review.findings.filter((f) => f.inDiff)
      const outOfDiff = review.findings.filter((f) => !f.inDiff)
      const comments = inline.map((f) => ({
        path: f.file,
        line: f.endLine ?? f.line,
        body: `**${SEV_EMOJI[f.severity]} ${f.severity} · ${f.category}** — ${f.title}\n\n**Why this needs correction**\n${f.rationale}\n\n**Required change**\n${f.suggestion}\n\n**Acceptance check**\nVerify the changed behavior prevents this condition and preserves the intended flow.\n\n**Review evidence**\nVerified finding · confidence ${f.confidence.toFixed(2)}${f.suggestedPatch ? `\n\n\`\`\`diff\n${f.suggestedPatch}\n\`\`\`` : ''}`,
      }))
      const body =
        `${c.marker ? `${c.marker}\n` : ''}## Code review — ${review.verdict}\n\n${review.summary}` +
        (outOfDiff.length ? `\n\n### Findings outside the diff\n${groupBySeverity(outOfDiff)}` : '')
      const payload = {
        body,
        ...(c.commitId ? { commit_id: c.commitId } : {}),
        ...(comments.length ? { comments } : {}),
      }
      const path = `/repos/${c.owner}/${c.repo}/pulls/${c.number}/reviews`
      try {
        await githubPost(c.token, path, { event: eventFor(review.verdict), ...payload })
      } catch (e) {
        // APPROVE / REQUEST_CHANGES are rejected on your OWN PR and for a GitHub
        // Actions token (422). The verdict is in the body anyway — fall back to a
        // plain COMMENT review so the findings still post.
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('422')) await githubPost(c.token, path, { event: 'COMMENT', ...payload })
        else throw e
      }
    },
  }
}
