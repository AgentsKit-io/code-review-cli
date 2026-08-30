import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderCircuitBreaker, ProviderCircuitOpenError } from '../dist/src/provider-circuit-breaker.js'

test('provider circuit opens after repeated transient failures and can reset', () => {
  const circuit = new ProviderCircuitBreaker(2, 60_000)
  assert.equal(circuit.state, 'closed')
  circuit.beforeCall()
  circuit.recordFailure()
  assert.equal(circuit.state, 'closed')
  circuit.beforeCall()
  circuit.recordFailure()
  assert.equal(circuit.state, 'open')
  assert.throws(() => circuit.beforeCall(), ProviderCircuitOpenError)
  circuit.reset()
  assert.equal(circuit.state, 'closed')
})
