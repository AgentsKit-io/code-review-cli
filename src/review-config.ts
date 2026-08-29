import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Category, Severity } from '../agents/code-review/agent.js'
import { ABSOLUTE_LOCAL_CLI_OUTPUT_BYTES, ABSOLUTE_LOCAL_CLI_TIMEOUT_MS, DEFAULT_LOCAL_CLI_OUTPUT_BYTES } from './local-cli-process.js'
import { DEFAULT_CODEX_CLI_TIMEOUT_MS, localCliTimeoutMs } from './local-cli-timeout.js'

export const BUILTIN_LENS_KEYS = [
  'correctness', 'security', 'performance', 'maintainability', 'design', 'tests', 'conventions',
] as const satisfies readonly Category[]

export type BuiltinLensKey = (typeof BUILTIN_LENS_KEYS)[number]
export type LensPolicy = { enabled: boolean; required: boolean }

const lensPolicy = z.object({ enabled: z.boolean(), required: z.boolean() }).strict()
const lensOverrides = z.object({
  correctness: lensPolicy.optional(), security: lensPolicy.optional(), performance: lensPolicy.optional(),
  maintainability: lensPolicy.optional(), design: lensPolicy.optional(), tests: lensPolicy.optional(),
  conventions: lensPolicy.optional(),
}).strict()
const positiveInt = z.number().int().min(1)
const nonNegativeInt = z.number().int().min(0)
const relativePattern = z.string().min(1).refine(
  (pattern) => !pattern.startsWith('/') && !pattern.startsWith('\\') && !/^[A-Za-z]:[\\/]/.test(pattern) && !pattern.split('/').includes('..'),
  'must be a repository-relative pattern without .. traversal',
)

const ReviewConfigSchema = z.object({
  configVersion: z.literal(1),
  lenses: lensOverrides.optional(),
  incompleteProfile: z.boolean().optional(),
  votes: positiveInt.max(25).optional(),
  retries: nonNegativeInt.max(1).optional(),
  thresholds: z.object({
    minSeverity: z.enum(['blocker', 'high', 'med', 'nit']).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    maxPerFile: positiveInt.optional(),
    suppressNits: z.boolean().optional(),
  }).strict().optional(),
  budget: z.object({
    maxFiles: positiveInt.max(500).optional(), maxBytes: positiveInt.max(25 * 1024 * 1024).optional(),
    maxCalls: positiveInt.max(1000).optional(), concurrency: positiveInt.max(32).optional(),
  }).strict().optional(),
  worker: z.object({
    timeoutMs: positiveInt.max(ABSOLUTE_LOCAL_CLI_TIMEOUT_MS).optional(),
    maxOutputBytes: positiveInt.max(ABSOLUTE_LOCAL_CLI_OUTPUT_BYTES).optional(),
  }).strict().optional(),
  conventions: relativePattern.optional(),
  context: z.object({ mode: z.enum(['prompt', 'isolated-snapshot']), patterns: z.array(relativePattern).max(100).optional() }).strict().optional(),
  provider: z.string().min(1).max(100).optional(), model: z.string().min(1).max(200).optional(),
  transport: z.enum(['api', 'acp', 'headless', 'auto', 'http']).optional(),
  trustMode: z.enum(['isolated', 'trusted-local']).optional(),
  redaction: z.enum(['required', 'high-confidence']).optional(),
  permissions: z.object({ tools: z.boolean().optional(), write: z.boolean().optional(), shell: z.boolean().optional(), mcp: z.boolean().optional() }).strict().optional(),
}).strict()

type FileConfig = z.infer<typeof ReviewConfigSchema>

export interface ReviewConfigOverrides {
  provider?: string; model?: string; transport?: string; votes?: number; retries?: number
  minSeverity?: Severity; minConfidence?: number; maxFiles?: number; maxCalls?: number; concurrency?: number; conventions?: string
}

export interface ResolvedReviewConfig {
  configVersion: 1
  lenses: Record<BuiltinLensKey, LensPolicy>
  incompleteProfile: boolean
  votes: number
  retries: number
  thresholds: { minSeverity?: Severity; minConfidence?: number; maxPerFile?: number; suppressNits?: boolean }
  budget: { maxFiles?: number; maxBytes?: number; maxCalls?: number; concurrency: number }
  worker: { timeoutMs: number; maxOutputBytes: number }
  conventions?: string
  context: { mode: 'prompt' | 'isolated-snapshot'; patterns: string[] }
  allowUnredacted: boolean
  provider?: string; model?: string; transport?: 'api' | 'acp' | 'headless' | 'auto' | 'http'
  trustMode: 'isolated'; redaction: 'required' | 'high-confidence'
  permissions: { tools?: boolean; write?: boolean; shell?: boolean; mcp?: boolean }
}

export class ReviewConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ReviewConfigError' }
}

const DEFAULT_LENSES: Record<BuiltinLensKey, LensPolicy> = {
  correctness: { enabled: true, required: true }, security: { enabled: true, required: true },
  performance: { enabled: true, required: false }, maintainability: { enabled: true, required: false },
  design: { enabled: true, required: false }, tests: { enabled: true, required: true }, conventions: { enabled: true, required: false },
}
const TRUSTED_ONLY_KEYS = ['provider', 'model', 'transport', 'context', 'trustMode', 'redaction', 'permissions'] as const

function diagnostic(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.join('.') || 'config'
    const label = path === 'budget.maxFiles' ? '--max-files' : path
    const message = label === '--max-files' && issue.message.includes('greater than or equal to 1') ? 'must be a positive integer' : issue.message
    return label === '--max-files' ? `${label} ${message}` : `${label}: ${message}`
  }).join('; ')
}

function parseFile(raw: unknown): FileConfig {
  const result = ReviewConfigSchema.safeParse(raw)
  if (!result.success) throw new ReviewConfigError(`invalid .agentskit-review.json: ${diagnostic(result.error)}`)
  return result.data
}

export function resolveReviewConfig(
  fileConfig: unknown | undefined,
  options: { ci?: boolean; allowIncomplete?: boolean; allowUnredacted?: boolean; overrides?: ReviewConfigOverrides } = {},
): ResolvedReviewConfig {
  const file = fileConfig === undefined ? undefined : parseFile(fileConfig)
  const overrides = options.overrides ?? {}
  if (file) {
    const restricted = TRUSTED_ONLY_KEYS.filter((key) => key !== 'context' || file.context?.mode !== 'isolated-snapshot').filter((key) => file[key] !== undefined)
    if (options.ci && restricted.length) throw new ReviewConfigError(`project config cannot set trusted execution inputs in CI: ${restricted.join(', ')}`)
    if (file.trustMode === 'trusted-local') throw new ReviewConfigError('project config cannot enable trusted-local mode; use an explicit trusted CLI invocation')
    if (file.context?.mode === 'isolated-snapshot' && !file.context.patterns?.length) throw new ReviewConfigError('isolated-snapshot requires at least one context pattern')
  }

  const lenses = Object.fromEntries(BUILTIN_LENS_KEYS.map((key) => [key, { ...DEFAULT_LENSES[key], ...(file?.lenses?.[key] ?? {}) }])) as Record<BuiltinLensKey, LensPolicy>
  const impossibleRequired = BUILTIN_LENS_KEYS.filter((key) => lenses[key].required && !lenses[key].enabled)
  if (impossibleRequired.length && !file?.incompleteProfile) throw new ReviewConfigError(`required lens cannot be disabled without incompleteProfile: ${impossibleRequired.join(', ')}`)
  const incompleteProfile = Boolean(file?.incompleteProfile || impossibleRequired.length)
  if (options.ci && (incompleteProfile || options.allowIncomplete)) throw new ReviewConfigError('--allow-incomplete and incomplete profiles are local-only; CI cannot approve an incomplete review')
  if (options.ci && options.allowUnredacted) throw new ReviewConfigError('--allow-unredacted is local-only and cannot disable CI redaction')
  if (incompleteProfile && !options.allowIncomplete) throw new ReviewConfigError('incomplete profile requires explicit --allow-incomplete for a local run')

  const thresholds = { ...file?.thresholds, ...(overrides.minSeverity === undefined ? {} : { minSeverity: overrides.minSeverity }), ...(overrides.minConfidence === undefined ? {} : { minConfidence: overrides.minConfidence }) }
  const budget = {
    ...file?.budget,
    ...(overrides.maxFiles === undefined ? {} : { maxFiles: overrides.maxFiles }),
    ...(overrides.maxCalls === undefined ? {} : { maxCalls: overrides.maxCalls }),
    ...(overrides.concurrency === undefined ? {} : { concurrency: overrides.concurrency }),
  }
  const provider = overrides.provider ?? file?.provider
  const defaultConcurrency = provider?.endsWith('-cli') ? 1 : 4
  const effective = {
    configVersion: 1 as const, lenses, incompleteProfile,
    votes: overrides.votes ?? file?.votes ?? 3, retries: overrides.retries ?? file?.retries ?? 1,
    thresholds, budget: { ...budget, concurrency: budget.concurrency ?? defaultConcurrency, maxCalls: budget.maxCalls ?? 1000 },
    worker: { timeoutMs: file?.worker?.timeoutMs ?? localCliTimeoutMs(provider === 'codex-cli' ? DEFAULT_CODEX_CLI_TIMEOUT_MS : undefined), maxOutputBytes: file?.worker?.maxOutputBytes ?? DEFAULT_LOCAL_CLI_OUTPUT_BYTES },
    conventions: overrides.conventions ?? file?.conventions,
    context: { mode: file?.context?.mode ?? 'prompt', patterns: file?.context?.patterns ?? [] },
    allowUnredacted: Boolean(options.allowUnredacted),
    provider: overrides.provider ?? file?.provider, model: overrides.model ?? file?.model,
    transport: (overrides.transport ?? file?.transport) as ResolvedReviewConfig['transport'],
    trustMode: 'isolated' as const, redaction: file?.redaction ?? 'required', permissions: file?.permissions ?? {},
  }
  const validation = z.object({
    votes: positiveInt.max(25), retries: nonNegativeInt.max(1),
    thresholds: z.object({ minSeverity: z.enum(['blocker', 'high', 'med', 'nit']).optional(), minConfidence: z.number().min(0).max(1).optional() }),
    budget: z.object({ maxFiles: positiveInt.max(500).optional(), maxBytes: positiveInt.max(25 * 1024 * 1024).optional(), maxCalls: positiveInt.max(1000), concurrency: positiveInt.max(32) }),
  }).safeParse(effective)
  if (!validation.success) throw new ReviewConfigError(`invalid effective review config: ${diagnostic(validation.error)}`)
  return effective
}

export function loadReviewConfig(
  cwd: string,
  options: { ci?: boolean; allowIncomplete?: boolean; allowUnredacted?: boolean; overrides?: ReviewConfigOverrides } = {},
): ResolvedReviewConfig {
  const file = join(cwd, '.agentskit-review.json')
  if (!existsSync(file)) return resolveReviewConfig(undefined, options)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) as unknown } catch { throw new ReviewConfigError(`invalid ${file}: expected valid JSON`) }
  return resolveReviewConfig(raw, options)
}
