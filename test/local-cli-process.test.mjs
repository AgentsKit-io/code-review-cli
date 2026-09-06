import assert from 'node:assert/strict'
import test from 'node:test'
import { runLocalCli } from '../dist/src/local-cli-process.js'

const node = process.execPath

test('isolated workers receive temporary HOME/TMPDIR and only the selected credential', async () => {
  process.env.AGENTSKIT_TEST_INHERITED = 'must-not-pass'
  try {
    const result = await runLocalCli(node, ['-e', 'process.stdout.write(JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, cwd: process.cwd(), inherited: process.env.AGENTSKIT_TEST_INHERITED, key: process.env.TEST_PROVIDER_KEY }))'], {
      providerCredential: { name: 'TEST_PROVIDER_KEY', value: 'selected-secret' },
    })
    const env = JSON.parse(result.stdout)
    assert.notEqual(env.home, process.env.HOME)
    assert.notEqual(env.tmp, process.env.TMPDIR)
    assert.match(env.cwd, /agentskit-review-worker-[^/]+\/home$/)
    assert.equal(env.inherited, undefined)
    assert.equal(env.key, 'selected-secret')
  } finally { delete process.env.AGENTSKIT_TEST_INHERITED }
})

test('trusted-local mode explicitly inherits the caller environment', async () => {
  process.env.AGENTSKIT_TEST_INHERITED = 'trusted-value'
  try {
    const result = await runLocalCli(node, ['-e', 'process.stdout.write(process.env.AGENTSKIT_TEST_INHERITED ?? "")'], { mode: 'trusted-local' })
    assert.equal(result.stdout, 'trusted-value')
  } finally { delete process.env.AGENTSKIT_TEST_INHERITED }
})

test('abort terminates a local worker and returns a stable error code', async () => {
  const controller = new AbortController()
  const pending = runLocalCli(node, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeoutMs: 5000 })
  setTimeout(() => controller.abort(), 25)
  await assert.rejects(pending, (error) => error?.code === 'ABORT_ERR' && error.message === `${node} aborted`)
})


test('output overflow stops the worker and never returns unbounded output', async () => {
  const pending = runLocalCli(node, ['-e', "process.stdout.write('x'.repeat(100))"], { maxOutputBytes: 10 })
  await assert.rejects(pending, (error) => error?.message.includes('stdout exceeded 10 bytes') && error.stdout.length <= 10)
})

test('failed worker diagnostics redact explicit credentials and known token formats', async () => {
  const secret = 'provider-secret-123456'
  const pending = runLocalCli(node, ['-e', `process.stderr.write(${JSON.stringify(`key=${secret} token=sk-1234567890123456`)}); process.exit(1)`], {
    providerCredential: { name: 'TEST_PROVIDER_KEY', value: secret },
  })
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /exited with code 1/)
    assert.doesNotMatch(error.stderr, new RegExp(secret))
    assert.doesNotMatch(error.stderr, /sk-1234567890123456/)
    assert.match(error.stderr, /\[REDACTED\]/)
    return true
  })
})

test('rejects unsafe worker limits before spawning', async () => {
  await assert.rejects(runLocalCli(node, ['-e', 'process.exit(0)'], { maxOutputBytes: 25 * 1024 * 1024 + 1 }), /maxOutputBytes/)
  await assert.rejects(runLocalCli(node, ['-e', 'process.exit(0)'], { timeoutMs: 10 * 60 * 1000 + 1 }), /timeout/)
})

test('missing executable remains a typed spawn failure without raw output', async () => {
  await assert.rejects(runLocalCli('agentskit-command-does-not-exist', []), (error) => error?.code === 'ENOENT' && error.stdout === '' && error.stderr === '')
})
