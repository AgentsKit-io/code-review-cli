import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTargets } from '../dist/agents/code-review/sources.js'

test('GitHub PR ingestion fails when a reviewable file cannot be loaded', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/pulls/7')) return Response.json({ head: { sha: 'abc123' } })
    if (path.endsWith('/pulls/7/files')) {
      return Response.json([{ filename: 'src/review-me.ts', patch: '@@ -0,0 +1 @@', status: 'added' }])
    }
    if (path.includes('/contents/')) return new Response('unavailable', { status: 503 })
    return new Response('not found', { status: 404 })
  }

  try {
    await assert.rejects(
      loadTargets({ kind: 'github-pr', owner: 'AgentsKit-io', repo: 'example', number: 7, token: 'test-token' }),
      /GitHub .*contents.* → 503/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GitHub PR ingestion downloads files returned with encoding none', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/pulls/8')) return Response.json({ head: { sha: 'abc123' } })
    if (parsed.pathname.endsWith('/pulls/8/files')) {
      return Response.json([{ filename: 'src/review-me.ts', patch: '@@ -0,0 +1 @@', status: 'added' }])
    }
    if (parsed.pathname.includes('/contents/')) {
      return Response.json({ content: '', encoding: 'none', download_url: 'https://raw.githubusercontent.com/AgentsKit-io/example/abc123/src/review-me.ts' })
    }
    if (parsed.hostname === 'raw.githubusercontent.com') return new Response('export const answer = 42\n')
    return new Response('not found', { status: 404 })
  }

  try {
    const [target] = await loadTargets({ kind: 'github-pr', owner: 'AgentsKit-io', repo: 'example', number: 8, token: 'test-token' })
    assert.equal(target?.fullContent, 'export const answer = 42\n')
  } finally {
    globalThis.fetch = originalFetch
  }
})
