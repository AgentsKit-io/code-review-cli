import type { AdapterFactory, AdapterRequest, StreamSource } from '@agentskit/core'
import { z } from 'zod'
import { runLocalCliProtocol, type LocalCliMode } from './local-cli-process.js'

const FindingSchema = z.object({
  file: z.string(), line: z.number(), endLine: z.number().optional(),
  severity: z.enum(['blocker', 'high', 'med', 'nit']),
  category: z.enum(['correctness', 'security', 'performance', 'maintainability', 'design', 'tests', 'conventions']),
  confidence: z.number().min(0).max(1), title: z.string(), rationale: z.string(), suggestion: z.string(), suggestedPatch: z.string().optional(),
})
const ReviewEnvelope = z.object({ schemaVersion: z.literal(1), findings: z.array(FindingSchema) }).strict()
class InvalidGrokOutputError extends Error {}

type RpcMessage = { readonly id?: string | number; readonly method?: string; readonly result?: unknown; readonly error?: { readonly message?: string } }

function extractJson(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new InvalidGrokOutputError('Grok ACP returned no JSON envelope')
  return text.slice(start, end + 1)
}

function reviewPrompt(request: AdapterRequest): string {
  const system = request.messages.find((message) => message.role === 'system')?.content ?? request.context?.systemPrompt ?? ''
  const convo = request.messages.filter((message) => message.role !== 'system').map((message) => `${message.role.toUpperCase()}: ${message.content}`).join('\n\n')
  const tool = request.context?.tools?.[0]
  return `${system}\n\n${convo}\n\nYou are one isolated code-review lens. Review only the supplied source and do not delegate, execute tools, edit files, use MCP, or use a terminal. Return ONLY JSON matching this envelope: {"schemaVersion":1,"findings":[]} . Each finding must match this schema: ${JSON.stringify(tool?.schema ?? {})}`
}

function parseEnvelope(text: string): string {
  let value: unknown
  try { value = JSON.parse(extractJson(text)) as unknown } catch { throw new InvalidGrokOutputError('Grok ACP returned malformed JSON') }
  const parsed = ReviewEnvelope.safeParse(value)
  if (!parsed.success) throw new InvalidGrokOutputError('Grok ACP returned an invalid schemaVersion: 1 envelope')
  return JSON.stringify({ findings: parsed.data.findings })
}

async function rpcRequest(channel: { readonly readLine: () => Promise<string>; readonly send: (message: unknown) => void }, method: string, params: unknown, text: { value: string }): Promise<unknown> {
  const id = `${method}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  channel.send({ jsonrpc: '2.0', id, method, params })
  for (;;) {
    let message: RpcMessage
    const line = await channel.readLine()
    try { message = JSON.parse(line) as RpcMessage } catch { continue }
    if (message.method === 'session/update') {
      const update = (message as RpcMessage & { params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }).params?.update
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) text.value += update.content.text
      continue
    }
    if (message.id !== id) {
      if (message.id !== undefined && message.method) channel.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'ACP capability denied by isolated review worker' } })
      continue
    }
    if (message.error) throw new Error(message.error.message ?? `${method} failed`)
    return message.result ?? {}
  }
}

async function runGrok(adapterRequest: AdapterRequest, options: GrokCliOptions, signal: AbortSignal): Promise<string> {
  return runLocalCliProtocol(options.command ?? 'grok', ['agent', 'stdio', '--no-auto-update', ...(options.model ? ['--model', options.model] : [])], async (channel) => {
    const text = { value: '' }
    const init = await rpcRequest(channel, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, text) as { authMethods?: Array<{ id?: string }> }
    const authMethods = new Set((init.authMethods ?? []).map((method) => method.id))
    const authMethod = options.apiKey && authMethods.has('xai.api_key')
      ? 'xai.api_key'
      : authMethods.has('cached_token')
        ? 'cached_token'
        : undefined
    if (authMethods.size > 0 && !authMethod) throw new Error('Grok ACP authentication unavailable; run `grok login` or set XAI_API_KEY')
    if (authMethod) await rpcRequest(channel, 'authenticate', { methodId: authMethod, _meta: { headless: true } }, text)
    const session = await rpcRequest(channel, 'session/new', { cwd: channel.cwd, mcpServers: [] }, text) as { sessionId?: string }
    if (!session.sessionId) throw new Error('Grok ACP did not return a session id')
    await rpcRequest(channel, 'session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: reviewPrompt(adapterRequest) }] }, text)
    await rpcRequest(channel, 'shutdown', {}, text)
    channel.send({ jsonrpc: '2.0', method: 'exit', params: {} })
    return parseEnvelope(text.value)
  }, { mode: options.mode, signal, providerCredential: options.apiKey ? { name: 'XAI_API_KEY', value: options.apiKey } : undefined, ...options.worker })
}

export interface GrokCliOptions {
  model?: string
  apiKey?: string
  mode?: LocalCliMode
  command?: string
  worker?: { timeoutMs?: number; maxOutputBytes?: number }
}

export function grokCli(options: GrokCliOptions = {}): AdapterFactory {
  return {
    capabilities: { streaming: false, tools: true, structuredOutput: true },
    createSource: (request: AdapterRequest): StreamSource => {
      const controller = new AbortController()
      return {
        stream: async function* () {
          try {
            const tools = request.context?.tools ?? []
            if (tools.length !== 1) throw new Error('Grok ACP review requires exactly one tool')
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const args = await runGrok(request, options, controller.signal)
                yield { type: 'tool_call', toolCall: { id: `tc-${Date.now()}`, name: tools[0]!.name, args } }
                yield { type: 'done' }
                return
              } catch (error) {
                if (!(error instanceof InvalidGrokOutputError) || attempt === 1) throw error
              }
            }
          } catch (error) {
            const e = error as { code?: string; message?: string; stderr?: string; stdout?: string }
            const detail = [e.message, e.stderr, e.stdout].filter(Boolean).join(' ').slice(0, 400)
            yield { type: 'error', content: `grok agent stdio failed${detail ? `: ${detail}` : ''}` }
          }
        },
        abort: () => controller.abort(),
      }
    },
  }
}
