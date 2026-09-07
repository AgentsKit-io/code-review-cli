import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveReviewConfig, loadReviewConfig, ReviewConfigError } from '../dist/src/review-config.js'
import { configFingerprint, defineConfig, generateConfigSchema, loadProjectConfig, validateConfig } from '../dist/src/public-config.js'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

function tempRepo(config) {
  const cwd = mkdtempSync(join(tmpdir(), 'agentskit-review-config-'))
  if (config !== undefined) writeFileSync(join(cwd, '.agentskit-review.json'), JSON.stringify(config))
  return cwd
}

test('defaults enable every lens and require correctness, security, and tests', () => {
  const config = resolveReviewConfig()
  assert.deepEqual(Object.fromEntries(Object.entries(config.lenses).map(([key, value]) => [key, value.enabled])), {
    correctness: true, security: true, performance: true, maintainability: true, design: true, tests: true, conventions: true,
  })
  assert.deepEqual(Object.entries(config.lenses).filter(([, value]) => value.required).map(([key]) => key), ['correctness', 'security', 'tests'])
})

test('CLI overrides max findings per file without changing project config', () => {
  const config = resolveReviewConfig({ configVersion: 1, thresholds: { maxPerFile: 9 } }, { overrides: { maxPerFile: 2 } })
  assert.equal(config.thresholds.maxPerFile, 2)
})

test('merges independent lens policy and flags override file values', () => {
  const config = resolveReviewConfig({
    configVersion: 1,
    lenses: { performance: { enabled: false, required: false } },
    votes: 3,
    thresholds: { minSeverity: 'high' },
  }, { overrides: { votes: 1, minSeverity: 'med' } })
  assert.equal(config.lenses.performance.enabled, false)
  assert.equal(config.lenses.security.enabled, true)
  assert.equal(config.votes, 1)
  assert.equal(config.thresholds.minSeverity, 'med')
  assert.equal(config.worker.timeoutMs, 120000)
  assert.equal(config.budget.maxCalls, 1000)
  assert.equal(resolveReviewConfig({ configVersion: 1, provider: 'codex-cli' }).budget.concurrency, 1)
  assert.equal(resolveReviewConfig({ configVersion: 1, provider: 'codex-cli' }).worker.timeoutMs, 300000)
  assert.equal(resolveReviewConfig({ configVersion: 1, provider: 'openai' }).budget.concurrency, 4)
})

test('fast profile disables optional lenses, batches, and uses bounded defaults', () => {
  const config = resolveReviewConfig({ configVersion: 1, profile: 'fast' })
  assert.equal(config.profile, 'fast')
  assert.equal(config.batchLenses, true)
  assert.deepEqual(Object.entries(config.lenses).filter(([, value]) => value.enabled).map(([key]) => key), ['correctness', 'security', 'tests'])
  assert.equal(config.votes, 1)
  assert.equal(config.retries, 0)
  assert.equal(config.thresholds.maxPerFile, 1)
  assert.equal(config.budget.deadlineMs, 120000)
  assert.equal(resolveReviewConfig(undefined, { overrides: { deadlineMs: 5000 } }).budget.deadlineMs, 5000)
})

test('rejects unknown fields, unsupported versions, and impossible required lenses', () => {
  for (const config of [
    { configVersion: 1, unknown: true },
    { configVersion: 2 },
    { configVersion: 1, lenses: { security: { enabled: false, required: true } } },
  ]) assert.throws(() => resolveReviewConfig(config), ReviewConfigError)
  assert.throws(() => resolveReviewConfig({ configVersion: 1, budget: { maxCalls: 1001 } }), ReviewConfigError)
})

test('requires an explicit local exception for an incomplete profile and rejects it in CI', () => {
  const config = { configVersion: 1, incompleteProfile: true, lenses: { security: { enabled: false, required: true } } }
  assert.throws(() => resolveReviewConfig(config), /allow-incomplete/)
  assert.equal(resolveReviewConfig(config, { allowIncomplete: true }).incompleteProfile, true)
  assert.throws(() => resolveReviewConfig(config, { ci: true, allowIncomplete: true }), /local-only/)
})

test('CI cannot accept trusted execution inputs or secrets from the project file', () => {
  assert.throws(() => resolveReviewConfig({ configVersion: 1, provider: 'openai' }, { ci: true }), /provider/)
  assert.throws(() => resolveReviewConfig({ configVersion: 1, apiKey: 'secret-value' }), /apiKey/)
  assert.doesNotThrow(() => resolveReviewConfig({ configVersion: 1, context: { mode: 'prompt' } }))
  assert.doesNotThrow(() => resolveReviewConfig({ configVersion: 1, context: { mode: 'isolated-snapshot', patterns: ['src/**'] } }, { ci: true }))
  assert.throws(() => resolveReviewConfig({ configVersion: 1, context: { mode: 'isolated-snapshot', patterns: ['../**'] } }), /repository-relative/)
})

test('invalid config exits 2 before provider execution and does not echo secret values', () => {
  const cwd = tempRepo({ configVersion: 1, apiKey: 'never-echo-this-key' })
  try {
    const run = spawnSync(process.execPath, [join(root, 'dist/src/cli.js'), '--provider', 'codex-cli', '--stdin'], {
      cwd, input: 'export const answer = 42\n', encoding: 'utf8',
      env: { ...process.env, CI: '', PATH: '/usr/bin:/bin' },
    })
    assert.equal(run.status, 2, run.stdout)
    assert.match(run.stderr, /apiKey/)
    assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /never-echo-this-key/)
    assert.doesNotMatch(run.stdout, /Code review —/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('CLI applies project lens policy and flags override configuration', () => {
  const cwd = tempRepo({ configVersion: 1, lenses: { performance: { enabled: false, required: false } }, votes: 3 })
  const fixtureBin = join(root, 'test/fixtures/bin')
  try {
    const run = spawnSync(process.execPath, [join(root, 'dist/src/cli.js'), '--provider', 'codex-cli', '--stdin', '--votes', '1', '--no-fail'], {
      cwd, input: 'export const answer = 42\n', encoding: 'utf8',
      env: { ...process.env, CI: '', PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /6\/6 lens executions succeeded/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('an explicitly incomplete local profile never reports approval', () => {
  const cwd = tempRepo({ configVersion: 1, incompleteProfile: true, lenses: { security: { enabled: false, required: true } } })
  const fixtureBin = join(root, 'test/fixtures/bin')
  try {
    const run = spawnSync(process.execPath, [join(root, 'dist/src/cli.js'), '--provider', 'codex-cli', '--stdin', '--allow-incomplete'], {
      cwd, input: 'export const answer = 42\n', encoding: 'utf8',
      env: { ...process.env, CI: '', PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
    })
    assert.equal(run.status, 2, run.stderr)
    assert.match(run.stdout, /Code review — COMMENT/)
    assert.match(run.stdout, /not an approval/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('loadReviewConfig reads only the repository config filename', () => {
  const cwd = tempRepo({ configVersion: 1, votes: 2 })
  try { assert.equal(loadReviewConfig(cwd).votes, 2) } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('public config API provides presets, schema validation, and stable fingerprints', () => {
  const config = defineConfig({
    target: { repository: 'AgentsKit-io/agentskit-os' },
    review: { lenses: { security: true } },
  })
  assert.equal(config.target.provider, 'github')
  assert.equal(config.review.lenses.security, true)
  assert.equal(typeof configFingerprint(config), 'string')
  assert.equal((generateConfigSchema().$schema), 'http://json-schema.org/draft-07/schema#')
  assert.doesNotThrow(() => validateConfig(config))
  assert.throws(() => validateConfig({ target: { repository: 'not-a-repository' }, review: {} }), /owner\/repository/)
})

test('public config loader imports JavaScript and TypeScript config modules', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentskit-public-config-'))
  const modulePath = join(cwd, 'code-review.config.ts')
  writeFileSync(modulePath, `import { defineConfig } from ${JSON.stringify(resolve(root, 'dist/src/index.js'))}\nexport default defineConfig({ target: { repository: 'AgentsKit-io/agentskit-os' }, review: { provider: 'codex-cli' } })\n`)
  try {
    const loaded = await loadProjectConfig(cwd)
    assert.equal(loaded.config.target.repository, 'AgentsKit-io/agentskit-os')
    assert.equal(loaded.path, modulePath)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
