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
