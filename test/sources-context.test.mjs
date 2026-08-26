import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadTargets } from '../dist/agents/code-review/sources.js'

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-review-source-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  mkdirSync(join(root, 'node_modules/ignored'), { recursive: true })
  writeFileSync(join(root, 'src/app.ts'), 'const apiKey = "sk-1234567890123456"\n')
  writeFileSync(join(root, 'Dockerfile'), 'FROM node:22\n')
  writeFileSync(join(root, 'Makefile'), 'test:\n\tnpm test\n')
  writeFileSync(join(root, '.github/workflows/ci'), 'name: CI\n')
  writeFileSync(join(root, '.env'), 'API_KEY=never-read\n')
  writeFileSync(join(root, 'node_modules/ignored/index.ts'), 'const ignored = true\n')
  const outside = mkdtempSync(join(tmpdir(), 'agentskit-review-outside-'))
  writeFileSync(join(outside, 'secret.ts'), 'const outside = true\n')
  symlinkSync(join(outside, 'secret.ts'), join(root, 'src/outside-link.ts'))
  return { root, outside }
}

test('isolated snapshots select deterministic code/config files and redact secrets', async () => {
  const { root, outside } = fixtureRepo()
  try {
    const targets = await loadTargets({ kind: 'isolated-snapshot', cwd: root, patterns: ['**/*'], redact: true })
    const selected = targets.filter((target) => target.reviewStatus !== 'UNREVIEWED')
    assert.deepEqual(selected.map((target) => target.file), ['.github/workflows/ci', 'Dockerfile', 'Makefile', 'src/app.ts'])
    assert.equal(selected.find((target) => target.file === 'Dockerfile')?.language, 'dockerfile')
    assert.match(selected.find((target) => target.file === 'src/app.ts')?.fullContent ?? '', /\[REDACTED\]/)
    assert.doesNotMatch(selected.find((target) => target.file === 'src/app.ts')?.fullContent ?? '', /sk-1234567890123456/)
    assert.ok(targets.some((target) => target.file === '.env' && target.unreviewedReason === 'sensitive file'))
    assert.ok(targets.some((target) => target.file === 'src/outside-link.ts' && target.unreviewedReason.includes('symlink')))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('snapshot file and byte ceilings mark excess input UNREVIEWED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-review-limits-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/a.ts'), 'a'.repeat(20))
    writeFileSync(join(root, 'src/b.ts'), 'b'.repeat(20))
    const targets = await loadTargets({ kind: 'isolated-snapshot', cwd: root, patterns: ['src/**'], limits: { maxFiles: 1, maxBytes: 10 }, redact: false })
    assert.equal(targets.filter((target) => target.reviewStatus !== 'UNREVIEWED').length, 0)
    assert.ok(targets.some((target) => target.unreviewedReason.includes('file limit')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
