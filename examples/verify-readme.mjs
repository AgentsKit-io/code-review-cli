#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'dist/src/cli.js')
if (!existsSync(cli)) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' })
  if (build.status !== 0) {
    console.error(build.stdout)
    console.error(build.stderr)
    process.exit(build.status ?? 1)
  }
}

const help = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8' })
const providers = spawnSync(process.execPath, [cli, '--list-providers'], { cwd: root, encoding: 'utf8' })
if (help.status !== 0 || providers.status !== 0) {
  console.error(help.stderr || providers.stderr)
  process.exit(1)
}
if (!help.stdout.includes('--sarif <file>') || !providers.stdout.includes('codex-cli')) {
  console.error('CLI discovery output is incomplete')
  process.exit(1)
}
console.log('Verified Code Review CLI discovery without credentials.')
