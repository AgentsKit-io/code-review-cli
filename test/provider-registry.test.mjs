import assert from 'node:assert/strict'
import test from 'node:test'
import { providerRegistry, resolveProviderId } from '../dist/src/provider-registry.js'

test('registry keeps API and local provider identities separate', () => {
  const entries = providerRegistry()
  const byId = Object.fromEntries(entries.map(entry => [entry.id, entry]))
  assert.equal(byId.grok.kind, 'api')
  assert.equal(byId['grok-cli'].kind, 'cli')
  assert.equal(byId['opencode-cli'].kind, 'cli')
  assert.equal(byId.grok.support, 'stable')
  assert.equal(byId['grok-cli'].support, 'stable')
  assert.equal(byId['opencode-cli'].support, 'stable')
  assert.deepEqual(byId['grok-cli'].transports, ['acp', 'headless', 'auto'])
  assert.deepEqual(byId['opencode-cli'].transports, ['acp', 'headless', 'auto'])
  assert.equal(byId['grok-cli'].defaultTransport, 'acp')
  assert.equal(byId['opencode-cli'].defaultTransport, 'acp')
  assert.equal(resolveProviderId('api'), 'anthropic')
  assert.ok(entries.some(entry => entry.id === 'azureOpenAI'))
  assert.equal(entries.some(entry => entry.id === 'createRouter'), false)
})
