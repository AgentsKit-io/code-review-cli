import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(join(root, path), 'utf8')

test('release workflows allow only a trusted merged Changesets version PR to publish', () => {
  const version = read('.github/workflows/release.yml')
  const publish = read('.github/workflows/publish.yml')

  assert.match(version, /push:\n    branches: \[main\]/)
  assert.match(version, /changesets\/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/)
  assert.match(version, /pull-requests: write/)
  assert.doesNotMatch(version, /id-token: write/)
  assert.match(publish, /pull_request:\n    branches: \[main\]\n    types: \[closed\]/)
  assert.match(publish, /github\.event\.pull_request\.merged == true/)
  assert.match(publish, /github\.event\.pull_request\.title == 'chore: version packages'/)
  assert.match(publish, /github\.event\.pull_request\.head\.ref == 'changeset-release\/main'/)
  assert.match(publish, /github\.event\.pull_request\.head\.ref == 'codex-release-0\.4\.1'|github\.event\.pull_request\.head\.ref == 'codex\/release-0\.4\.1'/)
  assert.doesNotMatch(publish, /version packages'\)/)
  assert.match(publish, /id-token: write/)
  assert.match(publish, /npm run check/)
  assert.match(publish, /npm pack --dry-run/)
  assert.match(publish, /npm publish --access public/)
  assert.match(publish, /gh release create/)
  assert.doesNotMatch(publish, /workflow_dispatch|NPM_TOKEN|RECOVERY_VERSION/)
})
