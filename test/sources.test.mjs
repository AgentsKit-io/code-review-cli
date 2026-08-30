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

test('GitHub PR ingestion applies file budgets and marks omitted files unreviewed', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/pulls/9')) return Response.json({ head: { sha: 'abc123' } })
    if (parsed.pathname.endsWith('/pulls/9/files')) {
      return Response.json([
        { filename: 'src/one.ts', patch: '@@ -0,0 +1 @@', status: 'added' },
        { filename: 'src/two.ts', patch: '@@ -0,0 +1 @@', status: 'added' },
      ])
    }
    if (parsed.pathname.includes('/contents/')) return Response.json({ content: 'export const answer = 42\n', encoding: 'utf8' })
    return new Response('not found', { status: 404 })
  }

  try {
    const targets = await loadTargets({ kind: 'github-pr', owner: 'AgentsKit-io', repo: 'example', number: 9, token: 'test-token', limits: { maxFiles: 1 } })
    assert.equal(targets.filter((target) => target.reviewStatus !== 'UNREVIEWED').length, 1)
    assert.equal(targets.filter((target) => target.reviewStatus === 'UNREVIEWED').length, 1)
    assert.match(targets.find((target) => target.reviewStatus === 'UNREVIEWED')?.unreviewedReason ?? '', /file limit/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GitHub PR ingestion does not download content for files outside the file budget', async () => {
  const originalFetch = globalThis.fetch
  const contentRequests = []
  globalThis.fetch = async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/pulls/10')) return Response.json({ head: { sha: 'abc123' } })
    if (parsed.pathname.endsWith('/pulls/10/files')) {
      return Response.json([
        { filename: 'src/one.ts', patch: '@@ -0,0 +1,3 @@', status: 'added' },
        { filename: 'src/two.ts', patch: '@@ -0,0 +1 @@', status: 'added' },
      ])
    }
    if (parsed.pathname.includes('/contents/')) {
      contentRequests.push(parsed.pathname)
      return Response.json({ content: 'export const answer = 42\n', encoding: 'utf8' })
    }
    return new Response('not found', { status: 404 })
  }

  try {
    await loadTargets({ kind: 'github-pr', owner: 'AgentsKit-io', repo: 'example', number: 10, token: 'test-token', limits: { maxFiles: 1 } })
    assert.equal(contentRequests.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GitHub PR ingestion stops downloading when the byte budget is reached', async () => {
  const originalFetch = globalThis.fetch
  let contentRequests = 0
  globalThis.fetch = async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/pulls/11')) return Response.json({ head: { sha: 'abc123' } })
    if (parsed.pathname.endsWith('/pulls/11/files')) {
      return Response.json([
        { filename: 'src/one.ts', patch: '@@ -0,0 +1 @@', status: 'added' },
        { filename: 'src/two.ts', patch: '@@ -0,0 +1 @@', status: 'added' },
      ])
    }
    if (parsed.pathname.includes('/contents/')) {
      contentRequests++
      return Response.json({ content: 'export const answer = 42\n', encoding: 'utf8' })
    }
    return new Response('not found', { status: 404 })
  }

  try {
    const targets = await loadTargets({ kind: 'github-pr', owner: 'AgentsKit-io', repo: 'example', number: 11, token: 'test-token', limits: { maxFiles: 2, maxBytes: 10 } })
    assert.equal(contentRequests, 1)
    assert.equal(targets.filter((target) => target.reviewStatus === 'UNREVIEWED').length, 2)
    assert.ok(targets.some((target) => target.unreviewedReason?.includes('byte limit')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GitHub PR ingestion cancels raw content streams at the byte budget', async () => {
  const originalFetch = globalThis.fetch
  let rawCancelled = false
  globalThis.fetch = async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/pulls/13')) return Response.json({ head: { sha: 'abc123' } })
    if (parsed.pathname.endsWith('/pulls/13/files')) {
      return Response.json([{ filename: 'src/large.ts', patch: '@@ -0,0 +1 @@', status: 'added' }])
    }
    if (parsed.pathname.includes('/contents/')) {
      return Response.json({ content: '', encoding: 'none', download_url: 'https://raw.githubusercontent.com/AgentsKit-io/example/abc123/src/large.ts' })
    }
    if (parsed.hostname === 'raw.githubusercontent.com') {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('123456'))
          controller.enqueue(new TextEncoder().encode('7890'))
          controller.close()
        },
        cancel() { rawCancelled = true },
      })
      return new Response(body)
    }
    return new Response('not found', { status: 404 })
  }

  try {
    const [target] = await loadTargets({ kind: 'github-pr', owner: 'AgentsKit-io', repo: 'example', number: 13, token: 'test-token', limits: { maxBytes: 5 } })
    assert.equal(target?.reviewStatus, 'UNREVIEWED')
    assert.match(target?.unreviewedReason ?? '', /byte limit/)
    assert.equal(rawCancelled, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GitHub PR ingestion caps paginated file metadata and reports truncation', async () => {
  const originalFetch = globalThis.fetch
  let filePages = 0
  globalThis.fetch = async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/pulls/12')) return Response.json({ head: { sha: 'abc123' } })
    if (parsed.pathname.endsWith('/pulls/12/files')) {
      filePages++
      return Response.json(Array.from({ length: 100 }, (_, index) => ({ filename: `src/file-${filePages}-${index}.ts`, patch: '@@ -0,0 +1 @@', status: 'added' })))
    }
    if (parsed.pathname.includes('/contents/')) return Response.json({ content: 'export const answer = 42\n', encoding: 'utf8' })
    return new Response('not found', { status: 404 })
  }

  try {
    const targets = await loadTargets({ kind: 'github-pr', owner: 'AgentsKit-io', repo: 'example', number: 12, token: 'test-token', limits: { maxFiles: 1 } })
    assert.equal(filePages, 5)
    assert.ok(targets.some((target) => target.unreviewedReason?.includes('metadata truncated')))
  } finally {
    globalThis.fetch = originalFetch
  }
})
