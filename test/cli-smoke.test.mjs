import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('a clean local Codex CLI fixture completes an offline stdin review', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js',
    '--provider', 'codex-cli',
    '--stdin',
    '--lang', 'ts',
    '--no-fail',
  ], {
    cwd: root,
    input: 'export const answer = 42\n',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Code review — APPROVE/)
  assert.match(run.stdout, /No findings above threshold/)
  assert.match(run.stdout, /7\/7 lens executions succeeded/)
})

test('advisory mode fails closed when every lens execution fails', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js',
    '--provider', 'codex-cli',
    '--stdin',
    '--lang', 'ts',
    '--no-fail',
  ], {
    cwd: root,
    input: 'export const answer = 42\n',
    encoding: 'utf8',
    env: { ...process.env, CODEX_FIXTURE_FAIL_ALL: '1', PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })

  assert.equal(run.status, 2, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
  assert.match(run.stderr, /review execution failed: 0 of 7 lens executions succeeded/i)
  assert.doesNotMatch(run.stdout, /Code review — APPROVE/)
})

test('a local Codex subprocess timeout fails fast instead of hanging the review', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js',
    '--provider', 'codex-cli',
    '--stdin',
    '--lang', 'ts',
    '--concurrency', '1',
    '--no-fail',
  ], {
    cwd: root,
    input: 'export const answer = 42\n',
    encoding: 'utf8',
    timeout: 3000,
    env: {
      ...process.env,
      CODEX_FIXTURE_HANG: '1',
      AGENTSKIT_REVIEW_SUBPROCESS_TIMEOUT_MS: '50',
      PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
    },
  })

  assert.equal(run.status, 2, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
  assert.match(`${run.stdout}\n${run.stderr}`, /codex timed out after 50ms/i)
  assert.match(run.stderr, /review execution failed: 0 of 7 lens executions succeeded/i)
})

test('a partially degraded review stays advisory and reports execution coverage', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js',
    '--provider', 'codex-cli',
    '--stdin',
    '--lang', 'ts',
    '--no-fail',
  ], {
    cwd: root,
    input: 'export const answer = 42\n',
    encoding: 'utf8',
    env: { ...process.env, CODEX_FIXTURE_FAIL_CATEGORY: 'security', PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /6\/7 lens executions succeeded; 1 failed/)
  assert.match(run.stdout, /Code review — APPROVE/)
})

test('one reviewed file cannot hide a second file with zero successful lenses', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js',
    '--provider', 'codex-cli',
    '--paths', 'test/fixtures/review/good.ts', 'test/fixtures/review/unreviewed.ts',
    '--no-fail',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CODEX_FIXTURE_FAIL_FILE: 'test/fixtures/review/unreviewed.ts', PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })

  assert.equal(run.status, 2, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
  assert.match(run.stderr, /1 reviewable file had zero successful lenses/i)
  assert.match(run.stderr, /test\/fixtures\/review\/unreviewed\.ts/)
  assert.doesNotMatch(run.stdout, /Code review — APPROVE/)
})

test('a zero file budget cannot convert reviewable input into an approval', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js',
    '--provider', 'codex-cli',
    '--stdin',
    '--lang', 'ts',
    '--max-files', '0',
    '--no-fail',
  ], {
    cwd: root,
    input: 'export const answer = 42\n',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })

  assert.equal(run.status, 2, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
  assert.match(run.stderr, /max-files must be a positive integer/i)
  assert.doesNotMatch(run.stdout, /Code review — APPROVE/)
})

test('the built CLI exposes provider and usage discovery without credentials', () => {
  const help = spawnSync(process.execPath, ['dist/src/cli.js', '--help'], { cwd: root, encoding: 'utf8' })
  const providers = spawnSync(process.execPath, ['dist/src/cli.js', '--list-providers'], { cwd: root, encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--sarif <file>/)
  assert.equal(providers.status, 0, providers.stderr)
  assert.match(providers.stdout, /codex-cli/)
  assert.match(providers.stdout, /ollama/)
  assert.match(providers.stdout, /grok-cli.*support=experimental/)
  assert.match(providers.stdout, /opencode-cli.*support=experimental/)
  assert.match(providers.stdout, /grok\tkind=api/)
})

test('doctor reports a healthy local provider as stable JSON without secrets', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js', 'doctor', '--provider', 'codex-cli', '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })

  assert.equal(run.status, 0, run.stderr)
  const report = JSON.parse(run.stdout)
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.provider, 'codex-cli')
  assert.equal(report.support, 'stable')
  assert.equal(report.ok, true)
  assert.equal(report.checks.find(check => check.name === 'version').status, 'pass')
})

test('doctor catches missing binaries and unsupported versions offline', () => {
  const missing = spawnSync(process.execPath, [
    'dist/src/cli.js', 'doctor', '--provider', 'opencode-cli', '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  })
  assert.equal(missing.status, 1)
  const missingReport = JSON.parse(missing.stdout)
  assert.equal(missingReport.checks.find(check => check.name === 'executable').detail, 'not found')

  const fixtureBin = join(root, 'test/fixtures/bin')
  const oldVersion = spawnSync(process.execPath, [
    'dist/src/cli.js', 'doctor', '--provider', 'codex-cli', '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CODEX_FIXTURE_VERSION: 'codex-cli 0.0.1', PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })
  assert.equal(oldVersion.status, 1)
  assert.match(oldVersion.stdout, /unsupported version 0\.0\.1/)
})

test('unknown local CLI versions warn locally and fail in CI', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const args = ['dist/src/cli.js', 'doctor', '--provider', 'codex-cli', '--json']
  const local = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, CI: '', CODEX_FIXTURE_VERSION: 'codex development build', PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })
  assert.equal(local.status, 0)
  assert.equal(JSON.parse(local.stdout).checks.find(check => check.name === 'version').status, 'warn')

  const ci = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, CI: 'true', CODEX_FIXTURE_VERSION: 'codex development build', PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })
  assert.equal(ci.status, 1)
  assert.match(ci.stdout, /unknown version/)
})

test('CI rejects an unknown local CLI version before model execution', () => {
  const fixtureBin = join(root, 'test/fixtures/bin')
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js', '--provider', 'codex-cli', '--stdin', '--no-fail',
  ], {
    cwd: root,
    input: 'export const answer = 42\n',
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', CODEX_FIXTURE_VERSION: 'codex development build', PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /unknown version/)
  assert.doesNotMatch(run.stdout, /Code review —/)
})

test('doctor reports missing API credentials without echoing values', () => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.endsWith('_API_KEY') || key === 'LLM_API_KEY') delete env[key]
  const secret = 'never-echo-this-key'
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js', 'doctor', '--provider', 'openai', '--model', 'fixture-model', '--json',
  ], { cwd: root, encoding: 'utf8', env: { ...env, OPENAI_API_KEY: secret } })
  assert.equal(run.status, 0)
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, new RegExp(secret))
  assert.equal(JSON.parse(run.stdout).checks.find(check => check.name === 'credentials').detail, 'configured')

  const missing = spawnSync(process.execPath, [
    'dist/src/cli.js', 'doctor', '--provider', 'openai', '--model', 'fixture-model', '--json',
  ], { cwd: root, encoding: 'utf8', env })
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stdout).checks.find(check => check.name === 'credentials').detail, 'missing')
})
