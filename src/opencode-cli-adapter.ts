import type { AdapterFactory } from '@agentskit/core'
import { createAcpCliAdapter, type AcpCliOptions } from './acp-cli-adapter.js'
import { createHeadlessCliAdapter, type HeadlessCliOptions } from './headless-cli-adapter.js'
import { parseReviewEnvelope, InvalidReviewOutputError } from './acp-cli-adapter.js'

export interface OpenCodeCliOptions extends Omit<AcpCliOptions, 'label' | 'command' | 'args' | 'authenticate' | 'credentialEnv'> {
  readonly command?: string
}

export function opencodeCli(options: OpenCodeCliOptions = {}): AdapterFactory {
  return createAcpCliAdapter({
    label: 'opencode acp',
    outputLabel: 'OpenCode ACP',
    command: options.command ?? 'opencode',
    args: ['acp'],
    authenticate: 'none',
    credentialEnv: 'OPENCODE_API_KEY',
    ...options,
  })
}

function opencodeJsonText(stdout: string, label: string): string {
  let text = ''
  let parsedEvent = false
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event: unknown
    try { event = JSON.parse(line) as unknown } catch { continue }
    if (!event || typeof event !== 'object') continue
    const value = event as Record<string, unknown>
    if (value.type !== 'text') continue
    parsedEvent = true
    const part = value.part && typeof value.part === 'object' ? value.part as Record<string, unknown> : undefined
    const properties = value.properties && typeof value.properties === 'object' ? value.properties as Record<string, unknown> : undefined
    const propertyPart = properties?.part && typeof properties.part === 'object' ? properties.part as Record<string, unknown> : undefined
    const chunk = [value.text, value.content, part?.text, properties?.text, propertyPart?.text].find((candidate): candidate is string => typeof candidate === 'string')
    if (chunk) text += chunk
  }
  if (!parsedEvent) throw new InvalidReviewOutputError(`${label} returned no JSON text event`)
  return parseReviewEnvelope(text, label)
}

export interface OpenCodeHeadlessOptions {
  readonly model?: string
  readonly apiKey?: string
  readonly mode?: HeadlessCliOptions['mode']
  readonly command?: string
  readonly worker?: HeadlessCliOptions['worker']
}

export function opencodeHeadless(options: OpenCodeHeadlessOptions = {}): AdapterFactory {
  return createHeadlessCliAdapter({
    label: 'opencode run',
    outputLabel: 'OpenCode headless',
    command: options.command ?? 'opencode',
    model: options.model,
    args: (prompt, model) => ['run', '--format', 'json', ...(model ? ['--model', model] : []), prompt],
    apiKey: options.apiKey,
    credentialEnv: 'OPENCODE_API_KEY',
    parseOutput: opencodeJsonText,
    mode: options.mode,
    worker: options.worker,
  })
}
