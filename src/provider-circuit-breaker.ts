export type ProviderCircuitState = 'closed' | 'open' | 'half-open'

export class ProviderCircuitOpenError extends Error {
  constructor() {
    super('provider circuit is open after repeated provider failures')
    this.name = 'ProviderCircuitOpenError'
  }
}

/**
 * Stops fan-out after provider failures. A half-open probe is allowed after the
 * cooldown so a long-lived process can recover without restarting.
 */
export class ProviderCircuitBreaker {
  private failures = 0
  private openedAt = 0
  private probing = false

  constructor(private readonly threshold = 2, private readonly cooldownMs = 30_000) {}

  get state(): ProviderCircuitState {
    if (!this.openedAt) return 'closed'
    if (Date.now() - this.openedAt < this.cooldownMs) return 'open'
    return 'half-open'
  }

  beforeCall(): void {
    const state = this.state
    if (state === 'open' || (state === 'half-open' && this.probing)) throw new ProviderCircuitOpenError()
    if (state === 'half-open') this.probing = true
  }

  recordSuccess(): void {
    this.failures = 0
    this.openedAt = 0
    this.probing = false
  }

  reset(): void {
    this.failures = 0
    this.openedAt = 0
    this.probing = false
  }

  recordFailure(forceOpen = false): void {
    this.probing = false
    this.failures++
    if (forceOpen || this.failures >= this.threshold) this.openedAt = Date.now()
  }
}
