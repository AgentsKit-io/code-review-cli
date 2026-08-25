import { spawn, type ChildProcess } from 'node:child_process'
import { localCliTimeoutMs } from './local-cli-timeout.js'

const MAX_BUFFER = 20 * 1024 * 1024
type LocalCliError = Error & { code?: string; stderr?: string; stdout?: string }

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }

  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

export function runLocalCli(
  command: string,
  args: string[],
  options: { readonly cwd?: string } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const timeoutMs = localCliTimeoutMs()

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let failureReason: Error | undefined
    let timeout: NodeJS.Timeout | undefined
    let settled = false

    const finishError = (error: Error): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      const failure = error as LocalCliError
      if (timedOut) {
        failure.code = 'ETIMEDOUT'
        failure.message = `${command} timed out after ${timeoutMs}ms`
      }
      failure.stdout = stdout
      failure.stderr = stderr
      reject(failure)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_BUFFER && !failureReason) {
        failureReason = new Error(`${command} stdout exceeded ${MAX_BUFFER} bytes`)
        terminateProcessTree(child)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > MAX_BUFFER && !failureReason) {
        failureReason = new Error(`${command} stderr exceeded ${MAX_BUFFER} bytes`)
        terminateProcessTree(child)
      }
    })
    child.once('error', (error) => finishError(error))
    child.once('close', (code, signal) => {
      if (failureReason) {
        finishError(failureReason)
      } else if (timedOut) {
        finishError(new Error(`${command} terminated with signal ${signal ?? 'unknown'}`))
      } else if (code === 0) {
        settled = true
        if (timeout) clearTimeout(timeout)
        resolve({ stdout, stderr })
      } else {
        finishError(new Error(`${command} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`))
      }
    })
    child.stdin.end()

    timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      terminateProcessTree(child)
    }, timeoutMs)
  })
}
