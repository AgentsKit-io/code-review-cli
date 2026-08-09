#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = resolve(root, 'llms-full.txt')
const rawBase = 'https://raw.githubusercontent.com/AgentsKit-io/code-review-cli/main/'
const blobBase = 'https://github.com/AgentsKit-io/code-review-cli/blob/main/'
const sources = [
  ['Public README', 'README.md'],
  ['Operations guide', 'docs/OPERATIONS.md'],
  ['Agent documentation index', 'docs/for-agents/index.md'],
  ['Code Review agent handoff', 'docs/for-agents/code-review-cli.md'],
  ['Security policy', 'SECURITY.md'],
  ['Contributing guide', 'CONTRIBUTING.md'],
  ['Roadmap', 'ROADMAP.md'],
  ['Changelog', 'CHANGELOG.md'],
]

const rebaseRelativeLinks = (markdown, sourcePath) => markdown
  .replace(
    /!\[([^\]]*)\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/g,
    (_match, alt, target) => `![${alt}](${new URL(target, `${rawBase}${sourcePath}`).href})`,
  )
  .replace(
    /\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/g,
    (_match, target) => `](${new URL(target, `${blobBase}${sourcePath}`).href})`,
  )

const ecosystem = JSON.parse(readFileSync(resolve(root, 'ecosystem.json'), 'utf8'))
const productLines = ecosystem.products
  .sort((left, right) => left.navigation.order - right.navigation.order)
  .map((product) => `- ${product.name}: ${product.surfaces.docs ?? product.surfaces.home}`)

const sections = sources.map(([title, path]) => [
  `## ${title}`,
  '',
  `Canonical source: ${rawBase}${path}`,
  '',
  rebaseRelativeLinks(readFileSync(resolve(root, path), 'utf8').trim(), path),
].join('\n'))

const content = [
  '# AgentsKit Code Review — full documentation corpus',
  '',
  'Generated from the public repository documentation. Prefer llms.txt for concise discovery and this file only when the full operating and ownership context is required.',
  '',
  '## AgentsKit ecosystem',
  '',
  ...productLines,
  '',
  ...sections,
  '',
].join('\n')

if (process.argv.includes('--check')) {
  const current = readFileSync(outputPath, 'utf8')
  if (current !== content) {
    console.error('llms-full.txt is stale; run npm run docs:full')
    process.exit(1)
  }
  console.log('llms-full.txt is fresh.')
} else {
  writeFileSync(outputPath, content)
  console.log(`Generated llms-full.txt from ${sources.length} canonical sources.`)
}
