import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditReadme } from './lib/readme-standard.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('README Standard v1 passes every declared dimension, budget, example, and freshness gate', () => {
  const config = JSON.parse(readFileSync(resolve(root, 'readme-standard-v1.json'), 'utf8'))
  const report = auditReadme(root, config, new Date('2026-07-14T12:00:00Z'))
  assert.deepEqual(report, { ok: true, failures: [] })
})

test('primary verification example runs without credentials', () => {
  const output = execFileSync(process.execPath, ['examples/verify-readme.mjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.match(output, /Verified Code Review CLI discovery without credentials/)
})
