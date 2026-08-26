import assert from 'node:assert/strict'
import test from 'node:test'
import { getGithubReviewState, reviewFingerprint, reviewMarker } from '../dist/src/github-review-state.js'

test('reconciles the same SHA and fingerprint without provider work', async () => {
  const originalFetch = globalThis.fetch
  const fingerprint = reviewFingerprint({ provider: 'codex-cli', votes: 3 })
  const marker = reviewMarker('head-1', fingerprint)
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/pulls/7')) return Response.json({ head: { sha: 'head-1', repo: { full_name: 'org/repo' } }, base: { sha: 'base-1', repo: { full_name: 'org/repo' } } })
    if (path.endsWith('/comments')) return Response.json([{ id: 1, body: `${marker}\n## Code review — APPROVE` }])
    return new Response('not found', { status: 404 })
  }
  try {
    const state = await getGithubReviewState({ owner: 'org', repo: 'repo', number: 7, token: 'test-token', fingerprint })
    assert.equal(state.alreadyReviewed, true)
    assert.equal(state.fork, false)
  } finally { globalThis.fetch = originalFetch }
})

test('retries one idempotent GET and detects fork ownership', async () => {
  const originalFetch = globalThis.fetch
  let pulls = 0
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/pulls/8')) {
      pulls++
      if (pulls === 1) throw new Error('temporary network failure')
      return Response.json({ head: { sha: 'head-2', repo: { full_name: 'contributor/repo' } }, base: { sha: 'base-2', repo: { full_name: 'org/repo' } } })
    }
    if (path.endsWith('/comments')) return Response.json([])
    return new Response('not found', { status: 404 })
  }
  try {
    const state = await getGithubReviewState({ owner: 'org', repo: 'repo', number: 8, token: 'test-token', fingerprint: 'f' })
    assert.equal(pulls, 2)
    assert.equal(state.fork, true)
    assert.equal(state.alreadyReviewed, false)
  } finally { globalThis.fetch = originalFetch }
})

test('uses incremental scope only when the previous reviewed SHA is an ancestor', async () => {
  const originalFetch = globalThis.fetch
  const fingerprint = 'stable'
  const oldMarker = reviewMarker('head-old', fingerprint)
  const calls = []
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (path.endsWith('/pulls/9')) return Response.json({ head: { sha: 'head-new', repo: { full_name: 'org/repo' } }, base: { sha: 'base-1', repo: { full_name: 'org/repo' } } })
    if (path.endsWith('/comments')) return Response.json([{ body: oldMarker }])
    if (path.includes('/compare/head-old...head-new')) return Response.json({ status: 'ahead' })
    return new Response('not found', { status: 404 })
  }
  try {
    const state = await getGithubReviewState({ owner: 'org', repo: 'repo', number: 9, token: 'test-token', fingerprint })
    assert.equal(state.scope, 'incremental')
    assert.equal(state.baselineSha, 'head-old')
    assert.ok(calls.some(path => path.includes('/compare/head-old...head-new')))
  } finally { globalThis.fetch = originalFetch }
})
