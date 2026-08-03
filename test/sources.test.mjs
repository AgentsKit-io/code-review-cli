import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTargets } from '../dist/agents/code-review/sources.js'

test('local source directories normalize supported files and ignore Markdown', async () => {
  const targets = await loadTargets({ kind: 'paths', paths: ['test/fixtures/sources'] })
  const byFile = new Map(targets.map((target) => [target.file, target]))

  assert.deepEqual([...byFile.keys()].sort(), [
    'test/fixtures/sources/example.go',
    'test/fixtures/sources/example.py',
  ])
  assert.equal(byFile.get('test/fixtures/sources/example.go')?.language, 'go')
  assert.equal(byFile.get('test/fixtures/sources/example.py')?.language, 'py')
  assert.equal(byFile.get('test/fixtures/sources/example.go')?.isChanged, false)
  assert.equal(byFile.get('test/fixtures/sources/example.py')?.isChanged, false)
  assert.equal(
    byFile.get('test/fixtures/sources/example.go')?.fullContent,
    'package main\n\nfunc main() {}\n',
  )
  assert.equal(
    byFile.get('test/fixtures/sources/example.py')?.fullContent,
    'def greet(name: str) -> str:\n    return f"Hello, {name}"\n',
  )
})

test('stdin source normalization derives Python language and marks the target changed', async () => {
  const [target] = await loadTargets({
    kind: 'stdin',
    filename: 'example.py',
    content: 'print("hello")\n',
  })

  assert.equal(target?.language, 'py')
  assert.equal(target?.isChanged, true)
  assert.equal(target?.file, 'example.py')
  assert.equal(target?.fullContent, 'print("hello")\n')
})

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
