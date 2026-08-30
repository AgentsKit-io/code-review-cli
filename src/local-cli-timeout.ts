export const DEFAULT_LOCAL_CLI_TIMEOUT_MS = 120_000
export const DEFAULT_CODEX_CLI_TIMEOUT_MS = 300_000

const TIMEOUT_ENV = 'AGENTSKIT_REVIEW_SUBPROCESS_TIMEOUT_MS'

export function localCliTimeoutMs(defaultMs = DEFAULT_LOCAL_CLI_TIMEOUT_MS): number {
  const raw = process.env[TIMEOUT_ENV]
  if (raw === undefined) return defaultMs

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${TIMEOUT_ENV} must be a positive integer`)
  }
  return value
}
