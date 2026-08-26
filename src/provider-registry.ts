import * as adapters from '@agentskit/adapters'
import type { AdapterFactory } from '@agentskit/core'
import { runLocalCli } from './local-cli-process.js'

export const PROVIDER_REGISTRY_VERSION = 1 as const

export type ProviderKind = 'api' | 'cli' | 'local-server'
export type SupportLevel = 'stable' | 'experimental' | 'unsupported'
export type Transport = 'api' | 'acp' | 'headless' | 'auto' | 'http'
export type ModelRequirement = 'required' | 'optional' | 'none'

export interface ProviderEntry {
  readonly id: string
  readonly aliases: readonly string[]
  readonly kind: ProviderKind
  readonly support: SupportLevel
  readonly description: string
  readonly factoryName?: string
  readonly executable?: string
  readonly versionArgs?: readonly string[]
  readonly minimumVersion?: string
  readonly transports: readonly Transport[]
  readonly defaultTransport: Transport
  readonly model: ModelRequirement
  readonly dataBoundary: 'local' | 'remote' | 'unknown'
  readonly credentialEnv: readonly string[]
  readonly credentialMode: 'api-key' | 'login' | 'none'
  readonly capabilities: Readonly<Record<string, boolean>>
}

const API_METADATA: Record<string, Omit<ProviderEntry, 'id' | 'aliases' | 'factoryName'>> = {
  anthropic: api('Anthropic', ['ANTHROPIC_API_KEY']),
  openai: api('OpenAI', ['OPENAI_API_KEY']),
  gemini: api('Google Gemini', ['GEMINI_API_KEY']),
  grok: api('xAI Grok API', ['GROK_API_KEY']),
  deepseek: api('DeepSeek', ['DEEPSEEK_API_KEY']),
  mistral: api('Mistral', ['MISTRAL_API_KEY']),
  groq: api('Groq', ['GROQ_API_KEY']),
  openrouter: api('OpenRouter', ['OPENROUTER_API_KEY']),
  together: api('Together AI', ['TOGETHER_API_KEY']),
}

const LOCAL_PROVIDERS: readonly ProviderEntry[] = [
  cli('codex-cli', 'OpenAI Codex CLI', 'codex', 'stable'),
  cli('claude-cli', 'Claude Code CLI', 'claude', 'stable'),
  {
    ...cli('grok-cli', 'Grok Build CLI', 'grok', 'stable'),
    transports: ['acp', 'headless', 'auto'],
    defaultTransport: 'acp',
  },
  {
    ...cli('opencode-cli', 'OpenCode CLI', 'opencode', 'stable'),
    transports: ['acp', 'headless', 'auto'],
    defaultTransport: 'acp',
  },
  localServer('ollama', 'Ollama local model server', 'stable'),
]

const FACTORY_EXCLUSIONS = /(?:Adapter|Embedder)$|^(?:bail|chunkText|create|fetch|inMemorySink|mock|recording|replay|simulate|langchain|langgraph)/i
const KNOWN_API_SUPPORT = new Set(Object.keys(API_METADATA))

function api(description: string, credentialEnv: readonly string[]): Omit<ProviderEntry, 'id' | 'aliases' | 'factoryName'> {
  return {
    kind: 'api', support: 'stable', description, transports: ['api'], defaultTransport: 'api', model: 'required',
    dataBoundary: 'remote', credentialEnv, credentialMode: 'api-key',
    capabilities: { streaming: true, tools: true, structuredOutput: true },
  }
}

function cli(id: string, description: string, executable: string, support: SupportLevel): ProviderEntry {
  return {
    id, aliases: [], kind: 'cli', support, description, executable, versionArgs: ['--version'], minimumVersion: '0.1.0',
    transports: ['headless'], defaultTransport: 'headless', model: 'optional', dataBoundary: 'local',
    credentialEnv: [], credentialMode: 'login', capabilities: { streaming: false, tools: true, structuredOutput: true },
  }
}

function localServer(id: string, description: string, support: SupportLevel): ProviderEntry {
  return {
    id, aliases: [], kind: 'local-server', support, description,
    transports: ['http'], defaultTransport: 'http', model: 'required', dataBoundary: 'local',
    credentialEnv: [], credentialMode: 'none', capabilities: { streaming: true, tools: true, structuredOutput: true },
  }
}

export function discoverApiFactories(source: Record<string, unknown> = adapters): string[] {
  return Object.keys(source).filter((name) => typeof source[name] === 'function' && !FACTORY_EXCLUSIONS.test(name)).sort()
}

export function providerRegistry(source: Record<string, unknown> = adapters): ProviderEntry[] {
  const entries = new Map<string, ProviderEntry>()
  for (const entry of LOCAL_PROVIDERS) entries.set(entry.id, entry)
  for (const id of discoverApiFactories(source)) {
    if (entries.has(id)) continue
    const metadata = API_METADATA[id] ?? {
      ...api(`${id} API adapter`, [`${id.toUpperCase()}_API_KEY`]),
      support: KNOWN_API_SUPPORT.has(id) ? 'stable' : 'experimental',
    }
    entries.set(id, { id, aliases: id === 'anthropic' ? ['api'] : [], factoryName: id, ...metadata })
  }
  for (const [id, metadata] of Object.entries(API_METADATA)) {
    if (!entries.has(id) && typeof source[id] === 'function') entries.set(id, { id, aliases: id === 'anthropic' ? ['api'] : [], factoryName: id, ...metadata })
  }
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function resolveProviderId(id: string, entries: readonly ProviderEntry[] = providerRegistry()): string | undefined {
  const normalized = id.trim().toLowerCase()
  return entries.find((entry) => entry.id.toLowerCase() === normalized || entry.aliases.some((alias) => alias.toLowerCase() === normalized))?.id
}

export function providerEntry(id: string, entries: readonly ProviderEntry[] = providerRegistry()): ProviderEntry | undefined {
  const resolved = resolveProviderId(id, entries)
  return entries.find((entry) => entry.id === resolved)
}

export interface DoctorCheck {
  readonly name: string
  readonly status: 'pass' | 'warn' | 'fail' | 'skip'
  readonly detail: string
}

export interface DoctorReport {
  readonly registryVersion: 1
  readonly schemaVersion: 1
  readonly provider: string
  readonly support: SupportLevel
  readonly live: boolean
  readonly ok: boolean
  readonly checks: readonly DoctorCheck[]
}

export interface DoctorOptions {
  readonly provider: string
  readonly model?: string
  readonly transport?: string
  readonly mode?: string
  readonly live?: boolean
  readonly ci?: boolean
  readonly apiKey?: string
  readonly env?: NodeJS.ProcessEnv
  readonly entries?: readonly ProviderEntry[]
}

const versionPattern = /(?:^|[^\d])v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/m
const VERSION_CHECK_TIMEOUT_MS = 5_000

export function parseVersion(output: string): string | undefined {
  const match = output.match(versionPattern)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!
}

function checkVersion(entry: ProviderEntry, output: string, ci: boolean): DoctorCheck {
  const version = parseVersion(output)
  if (!version) return { name: 'version', status: ci ? 'fail' : 'warn', detail: ci ? 'unknown version (CI requires a recognized version)' : 'unknown version (local run allowed)' }
  if (entry.minimumVersion && compareVersions(version, entry.minimumVersion) < 0) return { name: 'version', status: 'fail', detail: `unsupported version ${version}` }
  return { name: 'version', status: 'pass', detail: version }
}

export async function diagnoseProvider(options: DoctorOptions): Promise<DoctorReport> {
  const entries = options.entries ?? providerRegistry()
  const entry = providerEntry(options.provider, entries)
  if (!entry) return { registryVersion: PROVIDER_REGISTRY_VERSION, schemaVersion: 1, provider: options.provider, support: 'unsupported', live: Boolean(options.live), ok: false, checks: [{ name: 'provider', status: 'fail', detail: 'unsupported provider' }] }

  const env = options.env ?? process.env
  const ci = Boolean(options.ci || env.CI === 'true' || env.CI === '1')
  const checks: DoctorCheck[] = [
    { name: 'support', status: entry.support === 'experimental' ? 'warn' : entry.support === 'unsupported' ? 'fail' : 'pass', detail: entry.support },
    { name: 'transport', status: options.transport && !entry.transports.includes(options.transport as Transport) ? 'fail' : 'pass', detail: options.transport ?? entry.defaultTransport },
    { name: 'model', status: entry.model === 'required' && !options.model ? 'fail' : 'pass', detail: entry.model === 'required' ? (options.model ? 'configured' : 'required') : entry.model },
  ]

  const mode = options.mode ?? env.AGENTSKIT_REVIEW_MODE ?? 'isolated'
  checks.push({ name: 'configuration', status: mode === 'trusted-local' && (ci || entry.kind === 'api') ? 'fail' : ['isolated', 'trusted-local'].includes(mode) ? 'pass' : 'fail', detail: mode })

  const credentialPresent = Boolean(options.apiKey || env.LLM_API_KEY || entry.credentialEnv.some((name) => Boolean(env[name])))
  checks.push({
    name: 'credentials',
    status: entry.credentialMode === 'api-key' ? (credentialPresent ? 'pass' : 'fail') : 'pass',
    detail: entry.credentialMode === 'api-key' ? (credentialPresent ? 'configured' : 'missing') : entry.credentialMode === 'login' ? 'login-managed (not inspected offline)' : 'not required',
  })

  if (entry.executable) {
    try {
      const result = await runLocalCli(entry.executable, [...(entry.versionArgs ?? ['--version'])], { timeoutMs: VERSION_CHECK_TIMEOUT_MS })
      checks.push({ name: 'executable', status: 'pass', detail: entry.executable })
      checks.push(checkVersion(entry, `${result.stdout}\n${result.stderr}`, ci))
    } catch (error) {
      const e = error as { code?: string; message?: string }
      checks.push({ name: 'executable', status: 'fail', detail: e.code === 'ENOENT' ? 'not found' : e.code === 'ETIMEDOUT' ? 'timed out' : 'unavailable' })
      if (e.code === 'ETIMEDOUT') checks.push({ name: 'version', status: 'fail', detail: e.message?.startsWith(entry.executable) ? e.message : 'version check timed out' })
    }
  } else {
    checks.push({ name: 'executable', status: 'skip', detail: 'API provider' })
    checks.push({ name: 'version', status: 'skip', detail: 'API provider' })
  }

  if (options.live) checks.push({ name: 'live', status: 'skip', detail: 'provider smoke test is opt-in and provider-specific' })
  return { registryVersion: PROVIDER_REGISTRY_VERSION, schemaVersion: 1, provider: entry.id, support: entry.support, live: Boolean(options.live), ok: !checks.some((check) => check.status === 'fail'), checks }
}

export function factoryFor(entry: ProviderEntry): ((config: Record<string, unknown>) => AdapterFactory) | undefined {
  const factory = entry.factoryName ? (adapters as Record<string, unknown>)[entry.factoryName] : undefined
  return typeof factory === 'function' ? factory as (config: Record<string, unknown>) => AdapterFactory : undefined
}
