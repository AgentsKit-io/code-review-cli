import assert from 'node:assert/strict'
import test from 'node:test'
import { assertBatchManifestComplete, batchPlanOverBudget, batchSourceRequested } from '../dist/src/batch-mode.js'

test('batch planning widens the PR source before partitioning', () => {
  assert.equal(batchSourceRequested(undefined, '10'), true)
  assert.equal(batchSourceRequested('0', '10'), true)
  assert.equal(batchSourceRequested(undefined, undefined), false)
})

test('batch planning evaluates call budgets per batch', () => {
  const reasons = ['1037 estimated provider calls exceed maxCalls 1000', '4 files exceed maxFiles 3']
  assert.deepEqual(batchPlanOverBudget(reasons, true), ['4 files exceed maxFiles 3'])
  assert.deepEqual(batchPlanOverBudget(reasons, false), reasons)
})

test('batch manifests fail closed when any source file is unreviewed', () => {
  assert.doesNotThrow(() => assertBatchManifestComplete([]))
  assert.throws(() => assertBatchManifestComplete([{ file: 'large.bin' }]), /complete source coverage.*large\.bin/)
})
