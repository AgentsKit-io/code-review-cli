import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { providerRegistry } from '../dist/src/provider-registry.js'
import { resolveReviewConfig } from '../dist/src/review-config.js'

const root = new URL('.', import.meta.url).pathname.replace(/\/test\/$/, '')
const matrix = JSON.parse(readFileSync(join(root, 'docs/provider-compatibility.json'), 'utf8'))

test('stable CLI matrix is declarative, registry-backed, and fixture-backed', () => {
  assert.equal(matrix.schemaVersion, 1)
  assert.deepEqual(matrix.requiredLenses, ['correctness', 'security', 'tests'])
  const registry = Object.fromEntries(providerRegistry().map((entry) => [entry.id, entry]))
  for (const provider of matrix.providers) {
    const entry = registry[provider.id]
    assert.ok(entry)
    assert.equal(entry.support, 'stable')
    assert.equal(entry.executable, provider.executable)
    assert.equal(entry.minimumVersion, provider.minimumVersion)
    assert.deepEqual([...entry.transports], Object.keys(provider.transports))
    for (const transport of Object.values(provider.transports)) assert.equal(existsSync(join(root, transport.fixture)), true)
  }
  const config = resolveReviewConfig(undefined)
  assert.deepEqual(Object.entries(config.lenses).filter(([, policy]) => policy.required).map(([key]) => key), matrix.requiredLenses)
  assert.doesNotMatch(readFileSync(join(root, 'docs/provider-compatibility.json'), 'utf8'), /(?:sk-|ghp_|xai-[A-Za-z0-9]{12,})/)
})

test('unsupported provider/transport combinations fail before review execution', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const run = spawnSync(process.execPath, [join(root, 'dist/src/cli.js'), '--provider', 'opencode-cli', '--transport', 'http', '--stdin', '--no-fail'], {
    cwd: root, input: 'export const answer = 42\n', encoding: 'utf8', env: { ...process.env, PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /transport/)
})
