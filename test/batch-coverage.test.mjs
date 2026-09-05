import assert from 'node:assert/strict'
import test from 'node:test'
import { consolidateBatchArtifacts, consolidateToArtifact, createBatchCoverage, finalCoverage, partitionReviewableFiles, publicationDecision, recordBatch } from '../dist/src/batch-coverage.js'

test('batch coverage rejects stale SHA and completes only after every batch', () => {
  const state = createBatchCoverage({ repository: 'AgentsKit-io/agentskit-os', pullNumber: 1, headSha: 'a'.repeat(40), policyFingerprint: 'policy', batches: [{ index: 0, files: ['a.ts'] }, { index: 1, files: ['b.ts'] }] })
  assert.deepEqual(finalCoverage(state), { complete: false, findings: 0, pending: [0, 1] })
  assert.equal(publicationDecision(state).publish, false)
  assert.throws(() => recordBatch(state, { headSha: 'b'.repeat(40), policyFingerprint: 'policy', index: 0, findings: 0 }), /stale/)
  const first = recordBatch(state, { headSha: 'a'.repeat(40), policyFingerprint: 'policy', index: 0, findings: 1 })
  assert.deepEqual(finalCoverage(first), { complete: false, findings: 1, pending: [1] })
  assert.deepEqual(finalCoverage(recordBatch(first, { headSha: 'a'.repeat(40), policyFingerprint: 'policy', index: 1, findings: 0 })), { complete: true, findings: 1, pending: [] })
})

test('file partitioning is deterministic', () => {
  assert.deepEqual(partitionReviewableFiles(['b.ts', 'a.ts', 'b.ts'], 1), [{ index: 0, files: ['a.ts'] }, { index: 1, files: ['b.ts'] }])
})

test('only complete, matching batch artifacts can become a publishable review', () => {
  const state = createBatchCoverage({ repository: 'AgentsKit-io/agentskit-os', pullNumber: 1, headSha: 'a'.repeat(40), policyFingerprint: 'policy', batches: [{ index: 0, files: ['a.ts'] }, { index: 1, files: ['b.ts'] }] })
  const review = (findings = []) => ({ verdict: findings.length ? 'COMMENT' : 'APPROVE', blocking: false, incomplete: true, findings, dropped: [], execution: { attempted: 1, succeeded: 1, failed: 0 }, evidence: { profile: 'full', providerCalls: 1, failedProviderCalls: 0, skippedProviderCalls: 0, elapsedMs: 1, deadlineMs: 10, deadlineExceeded: false, circuitState: 'closed' }, summary: 'batch' })
  const artifact = (index, files, findings = []) => ({ version: 1, repository: state.repository, pullNumber: state.pullNumber, headSha: state.headSha, policyFingerprint: state.policyFingerprint, batch: { index, files }, review: review(findings) })
  assert.throws(() => consolidateBatchArtifacts(state, [artifact(0, ['a.ts'])]), /coverage incomplete/)
  const combined = consolidateBatchArtifacts(state, [artifact(0, ['a.ts']), artifact(1, ['b.ts'])])
  assert.equal(combined.incomplete, false)
  assert.equal(combined.verdict, 'APPROVE')
  const publishable = consolidateToArtifact(state, [artifact(0, ['a.ts']), artifact(1, ['b.ts'])])
  assert.deepEqual({ repository: publishable.repository, pullNumber: publishable.pullNumber, headSha: publishable.headSha, policyFingerprint: publishable.policyFingerprint, incomplete: publishable.review.incomplete }, { repository: state.repository, pullNumber: state.pullNumber, headSha: state.headSha, policyFingerprint: state.policyFingerprint, incomplete: false })
  assert.throws(() => consolidateBatchArtifacts(state, [artifact(0, ['wrong.ts']), artifact(1, ['b.ts'])]), /manifest/)
})
