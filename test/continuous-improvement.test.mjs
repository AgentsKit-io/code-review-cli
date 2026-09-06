import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('continuous-improvement benchmark proves clean, failed-lens, and deadline behavior', () => {
  const run = spawnSync(process.execPath, ['scripts/run-cycle-benchmark.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
  const report = JSON.parse(run.stdout)
  assert.equal(report.version, 1)
  assert.deepEqual(report.cases.map((entry) => entry.id), ['clean', 'required-lens-failure', 'deadline'])
  assert.equal(report.cases[0].artifact.verdict, 'APPROVE')
  assert.equal(report.cases[1].artifact.incomplete, true)
  assert.equal(report.cases[2].artifact.evidence.deadlineExceeded, true)
})
