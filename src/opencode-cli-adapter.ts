import type { AdapterFactory } from '@agentskit/core'
import { createAcpCliAdapter, type AcpCliOptions } from './acp-cli-adapter.js'

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
