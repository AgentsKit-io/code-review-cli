export const DEFAULT_LOCAL_CLI_TIMEOUT_MS = 120_000

const TIMEOUT_ENV = 'AGENTSKIT_REVIEW_SUBPROCESS_TIMEOUT_MS'

export function localCliTimeoutMs(): number {
  const raw = process.env[TIMEOUT_ENV]
  if (raw === undefined) return DEFAULT_LOCAL_CLI_TIMEOUT_MS

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${TIMEOUT_ENV} must be a positive integer`)
  }
  return value
}
