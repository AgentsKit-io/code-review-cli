import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
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

export interface LocalCliProtocolChannel {
  readonly cwd: string
  readonly readLine: () => Promise<string>
  readonly send: (message: unknown) => void
}

const SECRET_PATTERNS = [
  /(?:sk|pk)-[A-Za-z0-9_-]{16,}/g,
  /(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{12,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
]

// Local review fan-out can start dozens of workers. Register process shutdown
// listeners once and fan the signal out, rather than adding one listener per
// child (which emits MaxListenersExceededWarning at normal concurrency).
const parentShutdownHandlers = new Set<(signal: NodeJS.Signals) => void>()
let parentShutdownListening = false
const handleParentShutdown = (signal: NodeJS.Signals): void => {
  const handlers = [...parentShutdownHandlers]
  parentShutdownHandlers.clear()
  process.removeListener('SIGINT', handleParentShutdown)
  process.removeListener('SIGTERM', handleParentShutdown)
  parentShutdownListening = false
  for (const handler of handlers) handler(signal)
}
function addParentShutdownHandler(handler: (signal: NodeJS.Signals) => void): void {
  parentShutdownHandlers.add(handler)
  if (parentShutdownListening) return
  parentShutdownListening = true
  process.on('SIGINT', handleParentShutdown)
  process.on('SIGTERM', handleParentShutdown)
}
function removeParentShutdownHandler(handler: (signal: NodeJS.Signals) => void): void {
  parentShutdownHandlers.delete(handler)
  if (parentShutdownHandlers.size || !parentShutdownListening) return
  process.removeListener('SIGINT', handleParentShutdown)
  process.removeListener('SIGTERM', handleParentShutdown)
  parentShutdownListening = false
}

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
      removeParentShutdownHandler(onParentShutdown)
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
    addParentShutdownHandler(onParentShutdown)
    child.stdin.end()
    timeout = setTimeout(() => { if (!settled) { timedOut = true; stop(new Error(`${command} timed out after ${timeoutMs}ms`)) } }, timeoutMs)
  })
}

/** Run one bounded line-delimited JSON protocol over a local CLI's stdio. */
export function runLocalCliProtocol<T>(
  command: string,
  args: string[],
  exchange: (channel: LocalCliProtocolChannel) => Promise<T>,
  options: LocalCliOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? localCliTimeoutMs()
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_LOCAL_CLI_OUTPUT_BYTES
  const mode = options.mode ?? 'isolated'
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ABSOLUTE_LOCAL_CLI_TIMEOUT_MS) return Promise.reject(new Error(`timeout must be between 1 and ${ABSOLUTE_LOCAL_CLI_TIMEOUT_MS}ms`))
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > ABSOLUTE_LOCAL_CLI_OUTPUT_BYTES) return Promise.reject(new Error(`maxOutputBytes must be between 1 and ${ABSOLUTE_LOCAL_CLI_OUTPUT_BYTES}`))
  if (options.signal?.aborted) return Promise.reject(Object.assign(new Error(`${command} aborted before start`), { code: 'ABORT_ERR' }))

  return new Promise((resolve, reject) => {
    const { env, tempRoot } = createEnvironment(mode, options.providerCredential)
    const cwd = options.cwd ?? (mode === 'trusted-local' ? process.env.HOME ?? process.cwd() : join(tempRoot!, 'home'))
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    const rl = createInterface({ input: child.stdout })
    let stdout = ''
    let stderr = ''
    let lineQueue: string[] = []
    let lineWaiter: ((line: string) => void) | undefined
    let lineRejecter: ((error: Error) => void) | undefined
    let lineFailure: Error | undefined
    let exchangeResult: T | undefined
    let exchangeDone = false
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
      removeParentShutdownHandler(onParentShutdown)
      rl.close()
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
    }
    const finishError = (error: Error): void => {
      if (settled) return
      settled = true
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
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
      lineFailure = reason
      if (lineRejecter) { const rejectLine = lineRejecter; lineWaiter = undefined; lineRejecter = undefined; rejectLine(reason) }
      terminateProcessTree(child)
      finishError(reason)
    }
    const onAbort = () => { aborted = true; stop(new Error(`${command} aborted`)) }
    const onParentShutdown = (signal: NodeJS.Signals) => {
      parentShutdown = true
      stop(new Error(`${command} stopped because the parent process received ${signal}`))
    }
    const readLine = (): Promise<string> => {
      if (lineQueue.length) return Promise.resolve(lineQueue.shift()!)
      if (lineFailure) return Promise.reject(lineFailure)
      return new Promise((resolveLine, rejectLine) => { lineWaiter = resolveLine; lineRejecter = rejectLine })
    }
    const send = (message: unknown): void => {
      if (settled || child.stdin.destroyed) throw new Error(`${command} stdin is closed`)
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    rl.on('line', (line) => {
      const next = boundedAppend(stdout, `${line}\n`, maxOutputBytes)
      stdout = next.value
      if (next.overflow) { stop(new Error(`${command} stdout exceeded ${maxOutputBytes} bytes`)); return }
      if (lineWaiter) { const waiter = lineWaiter; lineWaiter = undefined; waiter(line) }
      else lineQueue.push(line)
    })
    child.stderr.on('data', (chunk: string) => {
      const next = boundedAppend(stderr, chunk, maxOutputBytes)
      stderr = next.value
      if (next.overflow) stop(new Error(`${command} stderr exceeded ${maxOutputBytes} bytes`))
    })
    child.once('error', (error) => finishError(error))
    child.once('close', (code, signal) => {
      if (lineRejecter) { const rejectLine = lineRejecter; lineWaiter = undefined; lineRejecter = undefined; rejectLine(new Error(`${command} exited before the protocol completed`)) }
      if (failureReason) finishError(failureReason)
      else if (timedOut) finishError(new Error(`${command} terminated with signal ${signal ?? 'unknown'}`))
      else if (aborted) finishError(new Error(`${command} aborted`))
      else if (parentShutdown) finishError(new Error(`${command} stopped because the parent process is shutting down`))
      else if (code !== 0) finishError(new Error(`${command} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`))
      else if (!exchangeDone) finishError(new Error(`${command} exited before the protocol completed`))
      else { settled = true; cleanup(); resolve(exchangeResult as T) }
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    addParentShutdownHandler(onParentShutdown)
    timeout = setTimeout(() => { if (!settled) { timedOut = true; stop(new Error(`${command} timed out after ${timeoutMs}ms`)) } }, timeoutMs)
    void exchange({ cwd, readLine, send }).then((result) => {
      if (settled) return
      exchangeResult = result
      exchangeDone = true
      child.stdin.end()
    }).catch((error: unknown) => stop(error instanceof Error ? error : new Error(String(error))))
  })
}
