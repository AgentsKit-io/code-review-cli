/** A batch plan must use the full PR source before partitioning its files. */
export function batchSourceRequested(batchIndex: string | undefined, batchSize: string | undefined): boolean {
  return batchIndex !== undefined || batchSize !== undefined
}

/** Total call estimates are per invocation; a batch manifest runs each batch separately. */
export function batchPlanOverBudget(overBudget: readonly string[], hasBatchPlan: boolean): string[] {
  return hasBatchPlan ? overBudget.filter((reason) => !/estimated provider calls exceed maxCalls/.test(reason)) : [...overBudget]
}

/** Never start a publishable batch run when the source itself is incomplete. */
export function assertBatchManifestComplete(unreviewed: readonly { file: string }[]): void {
  if (unreviewed.length > 0) {
    const files = unreviewed.map((item) => item.file).join(', ')
    throw new Error(`--batch-manifest requires complete source coverage; ${unreviewed.length} file(s) are unreviewed: ${files}`)
  }
}
