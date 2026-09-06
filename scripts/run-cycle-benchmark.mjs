#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureBin = join(root, 'test/fixtures/bin')
const workdir = mkdtempSync(join(tmpdir(), 'agentskit-review-cycle-'))
const source = 'export const answer = 42\n'

function runCase(id, options = {}) {
  const result = join(workdir, `${id}.json`)
  const startedAt = Date.now()
  const run = spawnSync(process.execPath, [
    'dist/src/cli.js', '--provider', 'codex-cli', '--stdin', '--lang', 'ts',
    '--profile', options.profile ?? 'full', '--health-check', 'off', '--deadline-ms', options.deadlineMs ?? '3000',
    '--result', result, '--no-fail',
  ], {
    cwd: root, input: source, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, ...options.env, PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
  })
  let artifact
  let artifactError
  try { artifact = JSON.parse(readFileSync(result, 'utf8')) } catch (error) { artifactError = error instanceof Error ? error.message : String(error) }
  return {
    id, exitCode: run.status, elapsedMs: Date.now() - startedAt,
    artifact: artifact && {
      verdict: artifact.verdict, blocking: artifact.blocking, incomplete: artifact.incomplete,
      execution: artifact.execution, evidence: artifact.evidence,
    },
    stderr: run.stderr.trim(),
    artifactError,
  }
}

function requireCase(condition, message) {
  if (!condition) throw new Error(`cycle benchmark failed: ${message}`)
}

try {
  const cases = [
    runCase('clean'),
    runCase('required-lens-failure', { env: { CODEX_FIXTURE_FAIL_CATEGORY: 'security' } }),
    runCase('deadline', { profile: 'fast', deadlineMs: '50', env: { CODEX_FIXTURE_HANG: '1' } }),
  ]
  const [clean, lensFailure, deadline] = cases
  requireCase(clean.exitCode === 0 && clean.artifact?.verdict === 'APPROVE' && clean.artifact?.incomplete === false, 'clean review must complete as APPROVE')
  requireCase(
    Number.isInteger(clean.artifact?.execution?.attempted) &&
      Number.isInteger(clean.artifact?.execution?.succeeded) &&
      clean.artifact.execution.attempted > 0 &&
      clean.artifact.execution.succeeded === clean.artifact.execution.attempted,
    'clean review must retain complete execution evidence',
  )
  requireCase(lensFailure.exitCode === 2 && lensFailure.artifact?.incomplete === true, 'required lens failure must fail closed with an artifact')
  requireCase((lensFailure.artifact?.execution?.failed ?? 0) > 0, 'required lens failure must retain failed-call evidence')
  requireCase(deadline.exitCode === 2 && deadline.artifact?.incomplete === true && deadline.artifact?.blocking === true, 'deadline must create a blocking incomplete artifact')
  requireCase(deadline.artifact?.evidence?.deadlineExceeded === true, 'deadline must retain deadline evidence')
  process.stdout.write(`${JSON.stringify({ version: 1, cases }, null, 2)}\n`)
} finally {
  rmSync(workdir, { recursive: true, force: true })
}
