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
})
