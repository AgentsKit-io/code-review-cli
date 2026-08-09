import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()))
  })
}

function close(server) {
  return new Promise(resolveClose => server.close(resolveClose))
}

function runCli(args, input) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['dist/src/cli.js', ...args], { cwd: root })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolveRun({ status, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('the built CLI completes a structured local Ollama review', async () => {
  const requests = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw)
      requests.push(body)
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end(`${JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'submit_findings', arguments: { findings: [] } } }],
        },
        done: false,
      })}\n${JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 2 })}\n`)
    })
  })
  const address = await listen(server)

  try {
    const run = await runCli([
      '--provider', 'ollama',
      '--model', 'fixture-model',
      '--base-url', `http://127.0.0.1:${address.port}`,
      '--stdin',
      '--lang', 'ts',
      '--concurrency', '1',
      '--no-fail',
    ], 'export const answer = 42\n')

    assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
    assert.ok(requests.length >= 7 && requests.length <= 21, `unexpected Ollama request count: ${requests.length}`)
    assert.ok(requests.every(body => body.model === 'fixture-model'))
    assert.ok(requests.every(body => body.messages[0].role === 'system'))
    assert.ok(requests.every(body => /untrusted/i.test(body.messages[0].content)))
    assert.ok(requests.every(body => body.tools[0].function.name === 'submit_findings'))
    assert.ok(requests.some(body => body.messages.some(message => message.role === 'assistant' && message.tool_calls?.length)))
    assert.ok(requests.some(body => body.messages.some(message => message.role === 'tool' && message.tool_name === 'submit_findings')))
    assert.match(run.stdout, /Code review — APPROVE/)
    assert.match(run.stdout, /7\/7 lens executions succeeded/)
  } finally {
    await close(server)
  }
})
