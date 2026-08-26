import type { AdapterFactory } from '@agentskit/core'
import { createAcpCliAdapter, type AcpCliOptions } from './acp-cli-adapter.js'
import { createHeadlessCliAdapter, type HeadlessCliOptions } from './headless-cli-adapter.js'

export interface GrokCliOptions extends Omit<AcpCliOptions, 'label' | 'command' | 'args' | 'authenticate' | 'credentialEnv'> {
  readonly command?: string
}

export function grokCli(options: GrokCliOptions = {}): AdapterFactory {
  return createAcpCliAdapter({
    label: 'grok agent stdio',
    outputLabel: 'Grok ACP',
    command: options.command ?? 'grok',
    args: ['agent', 'stdio', '--no-auto-update'],
    authenticate: 'xai',
    credentialEnv: 'XAI_API_KEY',
    ...options,
  })
}

export interface GrokHeadlessOptions {
  readonly model?: string
  readonly apiKey?: string
  readonly mode?: HeadlessCliOptions['mode']
  readonly command?: string
  readonly worker?: HeadlessCliOptions['worker']
}

export function grokHeadless(options: GrokHeadlessOptions = {}): AdapterFactory {
  return createHeadlessCliAdapter({
    label: 'grok headless',
    outputLabel: 'Grok headless',
    command: options.command ?? 'grok',
    model: options.model,
    args: (prompt, model) => ['--no-auto-update', '-p', prompt, '--output-format', 'json', ...(model ? ['--model', model] : [])],
    apiKey: options.apiKey,
    credentialEnv: 'XAI_API_KEY',
    mode: options.mode,
    worker: options.worker,
  })
}
