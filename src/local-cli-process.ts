import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LOCAL_CLI_TIMEOUT_MS, localCliTimeoutMs } from './local-cli-timeout.js'

export { DEFAULT_LOCAL_CLI_TIMEOUT_MS }

export const DEFAULT_LOCAL_CLI_OUTPUT_BYTES = 20 * 1024 * 1024
export const ABSOLUTE_LOCAL_CLI_OUTPUT_BYTES = 25 * 1024 * 1024
export const ABSOLUTE_LOCAL_CLI_TIMEOUT_MS = 10 * 60 * 1000
type LocalCliError = Error & { code?: string; stderr?: string; stdout?: string }
export type LocalCliMode = 'isolated' | 'trusted-local'

export interface LocalCliOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly signal?: AbortSignal
  readonly mode?: LocalCliMode
  /** Explicitly selected provider credential; arbitrary project env is never copied in isolated mode. */
  readonly providerCredential?: { readonly name: string; readonly value: string }
}

const SECRET_PATTERNS = [
  /(?:sk|pk)-[A-Za-z0-9_-]{16,}/g,
  /(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{12,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
]

export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  let redacted = value
  for (const secret of secrets.filter(Boolean)) redacted = redacted.split(secret).join('[REDACTED]')
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]')
  redacted = redacted.replace(/((?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
  return redacted
}

export function redactDiagnostic(value: string, secrets: readonly string[] = []): string {
  return redactSecrets(value, secrets).slice(0, 4000)
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}

function createEnvironment(mode: LocalCliMode, credential?: LocalCliOptions['providerCredential']): { env: NodeJS.ProcessEnv; tempRoot?: string } {
  if (mode === 'trusted-local') return { env: { ...process.env } }
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentskit-review-worker-'))
  const home = join(tempRoot, 'home')
  const temp = join(tempRoot, 'tmp')
  mkdirSync(home)
  mkdirSync(temp)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '', LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, CI: process.env.CI,
    HOME: home, TMPDIR: temp, TEMP: temp, TMP: temp, SystemRoot: process.env.SystemRoot,
  }
  // Offline fixtures use non-secret CODEX_FIXTURE_* switches to exercise failure paths.
  // No general project or user environment is inherited by isolated workers.
  for (const [name, value] of Object.entries(process.env)) if (name.startsWith('CODEX_FIXTURE_')) env[name] = value
  if (credential) env[credential.name] = credential.value
  return { env, tempRoot }
}

function boundedAppend(current: string, chunk: string, limit: number): { value: string; overflow: boolean } {
  const next = current + chunk
  if (Buffer.byteLength(next, 'utf8') <= limit) return { value: next, overflow: false }
  return { value: Buffer.from(next, 'utf8').subarray(0, limit).toString('utf8'), overflow: true }
}

export function runLocalCli(command: string, args: string[], options: LocalCliOptions = {}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const timeoutMs = options.timeoutMs ?? localCliTimeoutMs()
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_LOCAL_CLI_OUTPUT_BYTES
  const mode = options.mode ?? 'isolated'
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ABSOLUTE_LOCAL_CLI_TIMEOUT_MS) return Promise.reject(new Error(`timeout must be between 1 and ${ABSOLUTE_LOCAL_CLI_TIMEOUT_MS}ms`))
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > ABSOLUTE_LOCAL_CLI_OUTPUT_BYTES) return Promise.reject(new Error(`maxOutputBytes must be between 1 and ${ABSOLUTE_LOCAL_CLI_OUTPUT_BYTES}`))
  if (options.signal?.aborted) return Promise.reject(Object.assign(new Error(`${command} aborted before start`), { code: 'ABORT_ERR' }))

  return new Promise((resolve, reject) => {
    const { env, tempRoot } = createEnvironment(mode, options.providerCredential)
    const child = spawn(command, args, {
      cwd: options.cwd ?? (mode === 'trusted-local' ? process.env.HOME : join(tempRoot!, 'home')), env,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let parentShutdown = false
    let failureReason: Error | undefined
    let timeout: NodeJS.Timeout | undefined
    let settled = false
    const secrets = options.providerCredential ? [options.providerCredential.value] : []

    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      process.removeListener('SIGINT', onParentShutdown)
      process.removeListener('SIGTERM', onParentShutdown)
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
    }
    const finishError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      const failure = error as LocalCliError
      if (timedOut) { failure.code = 'ETIMEDOUT'; failure.message = `${command} timed out after ${timeoutMs}ms` }
      else if (aborted) { failure.code = 'ABORT_ERR'; failure.message = `${command} aborted` }
      else if (parentShutdown) { failure.code = 'PARENT_SHUTDOWN'; failure.message = `${command} stopped because the parent process is shutting down` }
      failure.stdout = redactDiagnostic(stdout, secrets)
      failure.stderr = redactDiagnostic(stderr, secrets)
      reject(failure)
    }
    const stop = (reason: Error) => {
      if (settled || failureReason) return
      failureReason = reason
      terminateProcessTree(child)
    }
    const onAbort = () => { aborted = true; stop(new Error(`${command} aborted`)) }
    const onParentShutdown = (signal: NodeJS.Signals) => {
      parentShutdown = true
      stop(new Error(`${command} stopped because the parent process received ${signal}`))
      setImmediate(() => process.kill(process.pid, signal))
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const next = boundedAppend(stdout, chunk, maxOutputBytes)
      stdout = next.value
      if (next.overflow) stop(new Error(`${command} stdout exceeded ${maxOutputBytes} bytes`))
    })
    child.stderr.on('data', (chunk: string) => {
      const next = boundedAppend(stderr, chunk, maxOutputBytes)
      stderr = next.value
      if (next.overflow) stop(new Error(`${command} stderr exceeded ${maxOutputBytes} bytes`))
    })
    child.once('error', (error) => finishError(error))
    child.once('close', (code, signal) => {
      if (failureReason) finishError(failureReason)
      else if (timedOut) finishError(new Error(`${command} terminated with signal ${signal ?? 'unknown'}`))
      else if (aborted) finishError(new Error(`${command} aborted`))
      else if (parentShutdown) finishError(new Error(`${command} stopped because the parent process is shutting down`))
      else if (code === 0) { settled = true; cleanup(); resolve({ stdout, stderr }) }
      else finishError(new Error(`${command} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`))
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    process.once('SIGINT', onParentShutdown)
    process.once('SIGTERM', onParentShutdown)
    child.stdin.end()
    timeout = setTimeout(() => { if (!settled) { timedOut = true; stop(new Error(`${command} timed out after ${timeoutMs}ms`)) } }, timeoutMs)
  })
}
