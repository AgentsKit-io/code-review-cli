import assert from 'node:assert/strict'
import test from 'node:test'
import { githubInlineReporter } from '../dist/agents/code-review/reporters.js'

const review = {
  verdict: 'REQUEST CHANGES',
  blocking: true,
  incomplete: false,
  findings: [{ file: 'src/example.ts', line: 4, severity: 'high', category: 'correctness', confidence: 0.95, title: 'Example defect', rationale: 'The value is not validated.', suggestion: 'Validate the value before use.', inDiff: true }],
  dropped: [],
  execution: { attempted: 1, succeeded: 1, failed: 0 },
  summary: '1 finding.',
}

test('GitHub inline reporter falls back to COMMENT after a rejected event', async () => {
  const originalFetch = globalThis.fetch
  const events = []
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    events.push(body.event)
    return events.length === 1
      ? new Response('event rejected', { status: 422 })
      : Response.json({ html_url: 'https://github.test/review/1' })
  }
  try {
    await githubInlineReporter({ owner: 'org', repo: 'repo', number: 1, token: 'test-token', commitId: 'abc123' }).emit(review)
    assert.deepEqual(events, ['REQUEST_CHANGES', 'COMMENT'])
  } finally { globalThis.fetch = originalFetch }
})

test('GitHub inline reporter surfaces non-validation posting failures', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('server failure', { status: 500 })
  try {
    await assert.rejects(
      githubInlineReporter({ owner: 'org', repo: 'repo', number: 1, token: 'test-token', commitId: 'abc123' }).emit(review),
      /GitHub POST .* → 500/,
    )
  } finally { globalThis.fetch = originalFetch }
})
