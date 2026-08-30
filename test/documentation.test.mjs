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
  for (const url of ['www.agentskit.io/docs', 'registry.agentskit.io/docs', 'chat.agentskit.io/docs', 'playbook.agentskit.io/docs', 'agentskit-io.github.io/doc-bridge', 'akos.agentskit.io/docs']) {
    assert.ok(readme.includes(url), `README missing ${url}`)
  }
  assert.match(readme, /no Fumadocs application and no embedded AgentsChat/i)
})

test('operations guide covers every required security and release topic', () => {
  const operations = read('docs/OPERATIONS.md')
  for (const marker of ['## Provider and credential choices', '## pre-commit integration', '## Local Ollama review', '## GitHub Action permissions', '## Advisory and blocking behavior', '## Cost and latency controls', '## SARIF', '## Failure scenarios', '## Releases and maturity', '## Contribution and security', 'pull_request_target', 'security-events: write']) {
    assert.ok(operations.includes(marker), `operations guide missing ${marker}`)
  }
})

test('pre-commit hook is manual, provider-neutral, and reviews the repository diff', () => {
  const hook = read('.pre-commit-hooks.yaml')
  const readme = read('README.md')
  for (const marker of [
    'id: agentskit-review',
    'entry: agentskit-review',
    'language: node',
    'pass_filenames: false',
    'always_run: true',
    'require_serial: true',
    'stages: [manual]',
  ]) {
    assert.ok(hook.includes(marker), `pre-commit hook missing ${marker}`)
  }
  assert.match(readme, /pre-commit run --hook-stage manual agentskit-review/)
  assert.match(readme, /does not claim to review only staged files/)
  assert.match(readme, /args: \[--provider, codex-cli, --no-fail/)
  assert.doesNotMatch(hook, /api[_-]?key/i)
})

test('reviewdog interoperability stays converter-free and explicit about policy ownership', () => {
  const readme = read('README.md')
  const operations = read('docs/OPERATIONS.md')
  const reviewdogSection = operations.split('### Route findings through reviewdog')[1].split('## Failure scenarios')[0]
  for (const marker of ['reviewdog -f=sarif', '-filter-mode=added', '-fail-level=error', 'REPORT_FILE="$(mktemp)"']) {
    assert.ok(readme.includes(marker), `README reviewdog recipe missing ${marker}`)
    assert.ok(operations.includes(marker), `operations reviewdog recipe missing ${marker}`)
  }
  assert.match(operations, /no AgentsKit-specific reporter or converter is required/i)
  assert.match(operations, /REVIEWDOG_GITHUB_API_TOKEN/)
  assert.match(operations, /blocker and high findings to SARIF `error`/)
  assert.match(operations, /actions\/checkout@[0-9a-f]{40}/)
  assert.match(operations, /reviewdog\/action-setup@[0-9a-f]{40}/)
  assert.match(operations, /reviewdog_version: v0\.21\.0/)
  assert.match(operations, /fetch-depth: 0/)
  assert.match(operations, /BASE_REF: \$\{\{ github\.base_ref \}\}/)
  assert.match(operations, /LLM_API_KEY: \$\{\{ secrets\.LLM_API_KEY \}\}/)
  assert.match(operations, /--provider openai --model gpt-4o/)
  assert.match(operations, /--no-fail &&/)
  assert.match(operations, /trap 'rm -f/)
  assert.match(reviewdogSection, /github:AgentsKit-io\/code-review-cli#[0-9a-f]{40}/)
  assert.doesNotMatch(reviewdogSection, /--base origin\/main/)
  assert.doesNotMatch(reviewdogSection, /--provider codex-cli/)
})

test('Ollama recipe is local, bounded, advisory, and honest about its source boundary', () => {
  const readme = read('README.md')
  const operations = read('docs/OPERATIONS.md')
  const readmeRecipe = readme.split('### Review locally with Ollama')[1]?.split('\n## ')[0] ?? ''
  const operationsRecipe = operations.split('## Local Ollama review')[1]?.split('\n## ')[0] ?? ''
  for (const marker of [
    '--provider ollama',
    '--model qwen2.5-coder:7b',
    '--base-url http://localhost:11434',
    '--max-files 10',
    '--concurrency 1',
    '--no-fail',
  ]) {
    assert.ok(readme.includes(marker), `README Ollama recipe missing ${marker}`)
    assert.ok(operations.includes(marker), `operations Ollama recipe missing ${marker}`)
  }
  assert.match(readme, /not a staged-files-only hook/i)
  assert.match(readme, /model must support Ollama tool calling/i)
  assert.match(operations, /tool calling is required/i)
  assert.match(operations, /does not mean “only staged files,”/i)
  assert.match(operations, /stdin is treated as one source file/i)
  assert.match(operations, /Do not set a hosted gateway.*describe the run as local/i)
  assert.doesNotMatch(`${readmeRecipe}\n${operationsRecipe}`, /OLLAMA_API_KEY|--api-key\s+\S+/)
})

test('the Action stays least-privilege, secret-safe, and advisory by default', () => {
  const action = read('action.yml')
  const workflow = read('examples/pull-request.yml')
  const selfHostedWorkflow = read('examples/pull-request-selfhosted.yml')
  assert.match(action, /LLM_API_KEY: \$\{\{ inputs\.api-key \}\}/)
  assert.match(action, /INPUT_MODE: \$\{\{ inputs\.mode \}\}/)
  assert.match(action, /--mode "\$INPUT_MODE"/)
  assert.match(action, /INPUT_FAIL_ON_BLOCK/)
  assert.match(action, /default: '17'/)
  assert.match(action, /INPUT_MAX_CALLS/)
  assert.match(action, /INPUT_MAX_FINDINGS_PER_FILE/)
  assert.match(action, /codex-cli requires a pre-authenticated trusted-local runner/)
  assert.match(action, /--no-fail/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /pull-requests: write/)
  assert.match(selfHostedWorkflow, /mode: 'trusted-local'/)
  assert.doesNotMatch(workflow, /pull_request_target/)
})

test('machine-readable documentation and Doc Bridge ownership are committed', () => {
  for (const path of ['AGENTS.md', 'doc-bridge.config.json', 'ecosystem.json', 'llms.txt', 'llms-full.txt', '.doc-bridge/index.json', '.doc-bridge/capabilities.json', 'docs/for-agents/index.md', 'docs/for-agents/code-review-cli.md']) {
    assert.ok(existsSync(join(root, path)), `${path} is missing`)
  }
  const config = JSON.parse(read('doc-bridge.config.json'))
  assert.equal(config.routing.options.ownership['code-review-cli'].agentDoc, 'docs/for-agents/code-review-cli.md')
  const index = JSON.parse(read('.doc-bridge/index.json'))
  const handoff = index.handoffs['code-review-cli']
  for (const path of handoff.readBeforeEditing) assert.ok(existsSync(join(root, path)), `handoff target ${path} is missing`)
  const searchableBody = index.knowledge.map(entry => entry.body).join('\n')
  for (const [product, url] of [
    ['AgentsKit', 'https://www.agentskit.io/docs'],
    ['Registry', 'https://registry.agentskit.io/docs'],
    ['AgentsKit Chat', 'https://chat.agentskit.io/docs'],
    ['Playbook', 'https://playbook.agentskit.io/docs'],
    ['Doc Bridge', 'https://agentskit-io.github.io/doc-bridge/'],
    ['AKOS', 'https://akos.agentskit.io/docs'],
  ]) {
    assert.ok(searchableBody.includes(product), `Doc Bridge index lost ecosystem product ${product}`)
    assert.ok(searchableBody.includes(url), `Doc Bridge index lost ecosystem route ${url}`)
  }
  assert.match(read('llms.txt'), /AgentsKit Code Review/)
  assert.match(read('llms.txt'), /llms-full\.txt/)
  const full = read('llms-full.txt')
  assert.match(full, /!\[[^\]]+\]\(https:\/\/raw\.githubusercontent\.com\/AgentsKit-io\/code-review-cli\/main\/docs\/assets\/code-review-terminal\.png\)/)
  assert.doesNotMatch(full, /!\[[^\]]*\]\(https:\/\/github\.com\/AgentsKit-io\/code-review-cli\/blob\/main\//)
  for (const marker of ['Code Review operations guide', '## Security policy', '## Contributing guide', '## Roadmap', '## Changelog']) {
    assert.ok(full.includes(marker), `llms-full.txt missing ${marker}`)
  }
  const relativeLinks = [...full.matchAll(/\]\(([^)]+)\)/g)]
    .map(match => match[1])
    .filter(target => !/^(?:https?:\/\/|mailto:|#)/.test(target))
  assert.deepEqual(relativeLinks, [], `llms-full.txt contains unresolved relative links: ${relativeLinks.join(', ')}`)
})

test('canonical ecosystem manifest exposes seven unique products and six Code Review siblings', () => {
  const manifest = JSON.parse(read('ecosystem.json'))
  const expected = ['agentskit', 'registry', 'agentskit-chat', 'playbook', 'doc-bridge', 'code-review', 'akos']
  assert.deepEqual(manifest.products.map(product => product.id), expected)
  assert.equal(new Set(expected).size, 7)
  assert.deepEqual(manifest.products.find(product => product.id === 'code-review').navigation.next, expected.filter(id => id !== 'code-review'))
  assert.ok(manifest.properties.every(product => expected.includes(product.id)))
  assert.equal(manifest.products.find(product => product.id === 'agentskit-chat').surfaces.documentation, 'fumadocs')
  assert.equal(manifest.products.find(product => product.id === 'akos').maturity, 'stable')
  for (const product of manifest.products) {
    assert.match(product.surfaces.home, /^https:\/\//)
    assert.match(product.surfaces.llms, /^https:\/\//)
  }
})

test('published package keeps documentation generators and freshness enforcement', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.ok(manifest.files.includes('scripts/generate-llms-full.mjs'))
  for (const input of [
    'SECURITY.md',
    'CONTRIBUTING.md',
    'ROADMAP.md',
    'CHANGELOG.md',
    'ecosystem-claims.json',
    'docs/assets',
    'docs/plans',
    'test/cli-smoke.test.mjs',
    'test/documentation.test.mjs',
    '.doc-bridge/index.json',
    '.doc-bridge/capabilities.json',
    'action.yml',
    '.pre-commit-hooks.yaml',
    'examples/pull-request.yml',
  ]) {
    assert.ok(manifest.files.includes(input), `published documentation input missing: ${input}`)
  }
  assert.equal(manifest.optionalDependencies['@agentskit/doc-bridge'], '^1.1.1')
  assert.match(manifest.scripts.prepack, /docs:gate/)
})

test('machine discovery links raw sources and every sibling while staying concise', () => {
  const llms = read('llms.txt')
  assert.ok(Buffer.byteLength(llms) < 12_000, 'llms.txt should remain a concise discovery surface')
  for (const marker of ['raw.githubusercontent.com/AgentsKit-io/code-review-cli/main/', 'AgentsKit Chat', 'Registry', 'Playbook', 'Doc Bridge', 'AKOS']) {
    assert.ok(llms.includes(marker), `llms.txt missing ${marker}`)
  }
})

test('repository-native scope has no Fumadocs or AgentsChat runtime dependency', () => {
  const packageJson = read('package.json')
  assert.doesNotMatch(packageJson, /fumadocs/i)
  assert.doesNotMatch(packageJson, /agentskit-chat/i)
  assert.equal(existsSync(join(root, 'app')), false)
  assert.equal(existsSync(join(root, 'apps')), false)
})
