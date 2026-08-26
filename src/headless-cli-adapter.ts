import type { AdapterFactory, AdapterRequest, StreamSource } from '@agentskit/core'
import { buildReviewPrompt, parseReviewEnvelope, InvalidReviewOutputError } from './acp-cli-adapter.js'
import { runLocalCli, type LocalCliMode } from './local-cli-process.js'

export interface HeadlessCliOptions {
  readonly label: string
  readonly outputLabel?: string
  readonly command: string
  readonly model?: string
  readonly args: (prompt: string, model?: string) => readonly string[]
  readonly apiKey?: string
  readonly credentialEnv?: string
  readonly parseOutput?: (stdout: string, label: string) => string
  readonly mode?: LocalCliMode
  readonly worker?: { timeoutMs?: number; maxOutputBytes?: number }
}

function defaultParseOutput(stdout: string, label: string): string {
  return parseReviewEnvelope(stdout, label)
}

export function createHeadlessCliAdapter(options: HeadlessCliOptions): AdapterFactory {
  return {
    capabilities: { streaming: false, tools: true, structuredOutput: true },
    createSource: (request: AdapterRequest): StreamSource => {
      const controller = new AbortController()
      return {
        stream: async function* () {
          try {
            const tools = request.context?.tools ?? []
            if (tools.length !== 1) throw new Error(`${options.label} review requires exactly one tool`)
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const { stdout } = await runLocalCli(options.command, [...options.args(buildReviewPrompt(request), options.model)], {
                  mode: options.mode,
                  signal: controller.signal,
                  providerCredential: options.apiKey ? { name: options.credentialEnv ?? 'API_KEY', value: options.apiKey } : undefined,
                  ...options.worker,
                })
                const args = (options.parseOutput ?? defaultParseOutput)(stdout, options.outputLabel ?? options.label)
                yield { type: 'tool_call', toolCall: { id: `tc-${Date.now()}`, name: tools[0]!.name, args } }
                yield { type: 'done' }
                return
              } catch (error) {
                if (!(error instanceof InvalidReviewOutputError) || attempt === 1) throw error
              }
            }
          } catch (error) {
            const e = error as { message?: string; stderr?: string; stdout?: string }
            const detail = [e.message, e.stderr, e.stdout].filter(Boolean).join(' ').slice(0, 400)
            yield { type: 'error', content: `${options.label} failed${detail ? `: ${detail}` : ''}` }
          }
        },
        abort: () => controller.abort(),
      }
    },
  }
}

export function createAutoCliAdapter(options: {
  readonly provider: string
  readonly primary: AdapterFactory
  readonly fallback: AdapterFactory
  readonly onFallback?: (detail: string) => void
}): AdapterFactory {
  return {
    capabilities: options.primary.capabilities,
    createSource: (request: AdapterRequest): StreamSource => {
      const primary = options.primary.createSource(request)
      const fallback = options.fallback.createSource(request)
      return {
        stream: async function* () {
          let primaryError: string | undefined
          for await (const chunk of primary.stream()) {
            if (chunk.type === 'error') { primaryError = chunk.content; break }
            yield chunk
          }
          if (!primaryError) return
          options.onFallback?.(`${options.provider}: ${primaryError}`)
          for await (const chunk of fallback.stream()) {
            if (chunk.type === 'error' && primaryError) yield { ...chunk, content: `${chunk.content}; ACP fallback reason: ${primaryError}` }
            else yield chunk
          }
        },
        abort: () => { primary.abort(); fallback.abort() },
      }
    },
  }
}
