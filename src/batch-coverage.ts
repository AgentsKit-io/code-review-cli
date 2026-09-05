import type { ReviewEvidence, ReviewResult } from '../agents/code-review/agent.js'

export type BatchCoverageState = {
  version: 1
  repository: string
  pullNumber: number
  headSha: string
  policyFingerprint: string
  batches: Array<{ index: number; files: string[]; completed: boolean; findings: number }>
}

/** A private, immutable output from exactly one batch run. Never publish this file. */
export type BatchReviewArtifact = {
  version: 1
  repository: string
  pullNumber: number
  headSha: string
  policyFingerprint: string
  batch: { index: number; files: string[] }
  review: ReviewResult
}

/** The sole artifact accepted by the GitHub publication command. */
export type ConsolidatedReviewArtifact = {
  version: 1
  repository: string
  pullNumber: number
  headSha: string
  policyFingerprint: string
  review: ReviewResult
}

export function partitionReviewableFiles(files: readonly string[], batchSize: number): Array<{ index: number; files: string[] }> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batch size must be a positive integer')
  const unique = [...new Set(files)].sort()
  return Array.from({ length: Math.ceil(unique.length / batchSize) }, (_, index) => ({ index, files: unique.slice(index * batchSize, (index + 1) * batchSize) }))
}

export function createBatchCoverage(input: Omit<BatchCoverageState, 'version' | 'batches'> & { batches: Array<{ index: number; files: string[] }> }): BatchCoverageState {
  const indices = new Set<number>()
  for (const batch of input.batches) {
    if (!Number.isInteger(batch.index) || batch.index < 0 || indices.has(batch.index) || !batch.files.length) throw new Error('invalid batch coverage manifest')
    indices.add(batch.index)
  }
  return { version: 1, repository: input.repository, pullNumber: input.pullNumber, headSha: input.headSha, policyFingerprint: input.policyFingerprint, batches: input.batches.map((batch) => ({ ...batch, files: [...batch.files], completed: false, findings: 0 })) }
}

export function recordBatch(state: BatchCoverageState, input: { headSha: string; policyFingerprint: string; index: number; findings: number }): BatchCoverageState {
  if (input.headSha !== state.headSha || input.policyFingerprint !== state.policyFingerprint) throw new Error('stale batch coverage state')
  const batch = state.batches.find((item) => item.index === input.index)
  if (!batch || batch.completed || !Number.isInteger(input.findings) || input.findings < 0) throw new Error('invalid batch result')
  return { ...state, batches: state.batches.map((item) => item.index === input.index ? { ...item, completed: true, findings: input.findings } : item) }
}

export function finalCoverage(state: BatchCoverageState): { complete: boolean; findings: number; pending: number[] } {
  const pending = state.batches.filter((batch) => !batch.completed).map((batch) => batch.index)
  return { complete: pending.length === 0, findings: state.batches.reduce((sum, batch) => sum + batch.findings, 0), pending }
}

export function publicationDecision(state: BatchCoverageState): { publish: boolean; reason: string } {
  const coverage = finalCoverage(state)
  if (!coverage.complete) return { publish: false, reason: `coverage incomplete; pending batches: ${coverage.pending.join(', ')}` }
  if (coverage.findings) return { publish: true, reason: `${coverage.findings} verified finding(s)` }
  return { publish: true, reason: 'complete coverage with zero findings' }
}

function assertUsableArtifact(state: BatchCoverageState, artifact: BatchReviewArtifact): void {
  if (artifact.version !== 1 || artifact.repository !== state.repository || artifact.pullNumber !== state.pullNumber) throw new Error('batch result does not belong to this PR')
  if (artifact.headSha !== state.headSha || artifact.policyFingerprint !== state.policyFingerprint) throw new Error('stale batch result')
  const expected = state.batches.find((batch) => batch.index === artifact.batch.index)
  if (!expected || expected.files.join('\0') !== artifact.batch.files.join('\0')) throw new Error('batch result does not match the planned file manifest')
  if (artifact.review.unreviewed?.length || artifact.review.missingRequiredLenses?.length || artifact.review.execution.failed || artifact.review.execution.succeeded !== artifact.review.execution.attempted || artifact.review.evidence.deadlineExceeded) {
    throw new Error(`batch ${artifact.batch.index} has incomplete review evidence`)
  }
}

/**
 * Validates every private artifact against the immutable manifest and returns the
 * only result that may be published. A partial, stale, failed, or duplicate batch
 * is rejected rather than silently becoming a clean review.
 */
export function consolidateBatchArtifacts(state: BatchCoverageState, artifacts: readonly BatchReviewArtifact[]): ReviewResult {
  let recorded = state
  const seen = new Set<number>()
  for (const artifact of artifacts) {
    assertUsableArtifact(state, artifact)
    if (seen.has(artifact.batch.index)) throw new Error(`duplicate batch result: ${artifact.batch.index}`)
    seen.add(artifact.batch.index)
    recorded = recordBatch(recorded, {
      headSha: artifact.headSha,
      policyFingerprint: artifact.policyFingerprint,
      index: artifact.batch.index,
      findings: artifact.review.findings.length,
    })
  }
  const decision = publicationDecision(recorded)
  if (!decision.publish) throw new Error(decision.reason)
  const reviews = [...artifacts].sort((a, b) => a.batch.index - b.batch.index).map((artifact) => artifact.review)
  const findings = reviews.flatMap((review) => review.findings)
  const dropped = reviews.flatMap((review) => review.dropped)
  const execution = reviews.reduce((total, review) => ({
    attempted: total.attempted + review.execution.attempted,
    succeeded: total.succeeded + review.execution.succeeded,
    failed: total.failed + review.execution.failed,
  }), { attempted: 0, succeeded: 0, failed: 0 })
  const evidence = reviews.reduce<ReviewEvidence>((total, review) => ({
    profile: total.profile,
    providerCalls: total.providerCalls + review.evidence.providerCalls,
    failedProviderCalls: total.failedProviderCalls + review.evidence.failedProviderCalls,
    skippedProviderCalls: total.skippedProviderCalls + review.evidence.skippedProviderCalls,
    elapsedMs: total.elapsedMs + review.evidence.elapsedMs,
    deadlineMs: total.deadlineMs + review.evidence.deadlineMs,
    deadlineExceeded: total.deadlineExceeded || review.evidence.deadlineExceeded,
    circuitState: total.circuitState === 'open' || review.evidence.circuitState === 'open' ? 'open' : total.circuitState,
  }), { profile: reviews[0]!.evidence.profile, providerCalls: 0, failedProviderCalls: 0, skippedProviderCalls: 0, elapsedMs: 0, deadlineMs: 0, deadlineExceeded: false, circuitState: 'closed' })
  const severe = findings.some((finding) => finding.severity === 'blocker' || finding.severity === 'high')
  return {
    verdict: !findings.length ? 'APPROVE' : severe ? 'REQUEST CHANGES' : 'COMMENT',
    blocking: reviews.some((review) => review.blocking),
    incomplete: false,
    findings,
    dropped,
    execution,
    evidence,
    summary: `Complete batch review: ${reviews.length} batch(es), ${state.batches.reduce((total, batch) => total + batch.files.length, 0)} file(s), ${findings.length} verified finding(s).`,
  }
}

export function consolidateToArtifact(state: BatchCoverageState, artifacts: readonly BatchReviewArtifact[]): ConsolidatedReviewArtifact {
  return {
    version: 1,
    repository: state.repository,
    pullNumber: state.pullNumber,
    headSha: state.headSha,
    policyFingerprint: state.policyFingerprint,
    review: consolidateBatchArtifacts(state, artifacts),
  }
}
