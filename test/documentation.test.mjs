import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(join(root, path), 'utf8')

test('README communicates pipeline, maturity, contribution, and ecosystem role', () => {
  const readme = read('README.md')
  for (const marker of ['docs/assets/agentskit-mark.svg', '```mermaid', '## Maturity', '## AgentsKit ecosystem', 'CONTRIBUTING.md', 'SECURITY.md']) {
    assert.ok(readme.includes(marker), `README missing ${marker}`)
  }
  for (const url of ['www.agentskit.io/docs', 'registry.agentskit.io/docs', 'playbook.agentskit.io/docs', 'AgentsKit-io/doc-bridge']) {
    assert.ok(readme.includes(url), `README missing ${url}`)
  }
  assert.match(readme, /no Fumadocs application and no embedded AgentsChat/i)
})

test('operations guide covers every required security and release topic', () => {
  const operations = read('docs/OPERATIONS.md')
  for (const marker of ['## Provider and credential choices', '## GitHub Action permissions', '## Advisory and blocking behavior', '## Cost and latency controls', '## SARIF', '## Failure scenarios', '## Releases and maturity', '## Contribution and security', 'pull_request_target', 'security-events: write']) {
    assert.ok(operations.includes(marker), `operations guide missing ${marker}`)
  }
})

test('the Action stays least-privilege, secret-safe, and advisory by default', () => {
  const action = read('action.yml')
  const workflow = read('examples/pull-request.yml')
  assert.match(action, /LLM_API_KEY: \$\{\{ inputs\.api-key \}\}/)
  assert.match(action, /INPUT_FAIL_ON_BLOCK/)
  assert.match(action, /--no-fail/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /pull-requests: write/)
  assert.doesNotMatch(workflow, /pull_request_target/)
})

test('machine-readable documentation and Doc Bridge ownership are committed', () => {
  for (const path of ['AGENTS.md', 'doc-bridge.config.json', 'llms.txt', '.doc-bridge/index.json', '.doc-bridge/capabilities.json', 'docs/for-agents/index.md', 'docs/for-agents/code-review-cli.md']) {
    assert.ok(existsSync(join(root, path)), `${path} is missing`)
  }
  const config = JSON.parse(read('doc-bridge.config.json'))
  assert.equal(config.routing.options.ownership['code-review-cli'].agentDoc, 'docs/for-agents/code-review-cli.md')
  const index = JSON.parse(read('.doc-bridge/index.json'))
  const handoff = index.handoffs['code-review-cli']
  for (const path of handoff.readBeforeEditing) assert.ok(existsSync(join(root, path)), `handoff target ${path} is missing`)
  const llms = read('llms.txt')
  const ecosystem = [
    ['AgentsKit', 'https://www.agentskit.io/docs', 'https://www.agentskit.io/llms.txt'],
    ['AgentsKit Registry', 'https://registry.agentskit.io/docs', 'https://registry.agentskit.io/llms.txt'],
    ['AgentsKit Chat', 'https://chat.agentskit.io/docs', 'https://chat.agentskit.io/llms.txt'],
    ['Agents Playbook', 'https://playbook.agentskit.io/docs', 'https://playbook.agentskit.io/llms.txt'],
    ['Doc Bridge', 'https://agentskit-io.github.io/doc-bridge/', 'https://agentskit-io.github.io/doc-bridge/llms.txt'],
    ['AgentsKit Code Review', 'https://github.com/AgentsKit-io/code-review-cli#readme', 'https://raw.githubusercontent.com/AgentsKit-io/code-review-cli/main/llms.txt'],
    ['AgentsKit OS', 'https://akos.agentskit.io/docs', 'https://akos.agentskit.io/llms.txt'],
  ]
  for (const [name, docs, machine] of ecosystem) {
    assert.ok(llms.includes(`[${name}](${docs})`), `llms.txt missing canonical docs for ${name}`)
    assert.ok(llms.includes(`llms.txt: ${machine}`), `llms.txt missing canonical machine route for ${name}`)
  }
})

test('repository-native scope has no Fumadocs or AgentsChat runtime dependency', () => {
  const packageJson = read('package.json')
  assert.doesNotMatch(packageJson, /fumadocs/i)
  assert.doesNotMatch(packageJson, /agentskit-chat/i)
  assert.equal(existsSync(join(root, 'app')), false)
  assert.equal(existsSync(join(root, 'apps')), false)
})
