import type { AdapterFactory } from '@agentskit/core'
import { createAcpCliAdapter, type AcpCliOptions } from './acp-cli-adapter.js'

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
